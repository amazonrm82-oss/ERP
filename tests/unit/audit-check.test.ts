import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { calendarDate, chainTo, decide, rootAdvisories, satisfies } from "../../scripts/audit-check.mjs";

const ROOT = join(__dirname, "..", "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

// npm audit --omit=dev --json as it stood on 18 November 2026 with @sentry/nextjs 11.10.0 (5 moderate findings), and the
// lockfile entries around them
const AUDIT = readJson("tests/unit/fixtures/audit/sentry-build-time.json");
const LOCK = readJson("tests/unit/fixtures/audit/lock-subset.json");
const ALLOWLIST = readJson("scripts/audit-allowlist.json");
// published versions on that day: glob and minimatch have fixes, but only a newer dependent accepts them
const PUBLISHED = {
  glob: ["13.0.6", "13.0.7", "14.0.1", "14.0.2", "14.0.6", "15.0.0-rc.1"],
  minimatch: ["10.2.5", "10.2.6", "11.0.0", "11.0.9"],
};
const BEFORE = new Date("2026-11-18T12:00:00Z");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const run = (over: Partial<Parameters<typeof decide>[0]> = {}) =>
  decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: BEFORE, ...over });

describe("audit-check: the decision on a captured report", () => {
  it("passes with the owner's allowlist, which lists exactly what npm audit reports", () => {
    const result = run();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(ALLOWLIST.entries.map((e: { package: string }) => e.package).sort()).toEqual(Object.keys(AUDIT.vulnerabilities).sort());
    for (const entry of ALLOWLIST.entries) {
      expect(entry.reason).toBe("build-time only (Sentry bundler plugins), owner (433) א");
      expect(entry.paths).toEqual(AUDIT.vulnerabilities[entry.package].nodes);
    }
    expect(ALLOWLIST.recheck_by).toBe("2026-12-15");
    expect(result.notes.join("\n")).toContain("a newer @sentry/bundler-plugins is needed");
  });

  it("fails on a new high finding that is not listed, and only notes a new moderate one", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities["left-pad"] = {
      name: "left-pad",
      severity: "high",
      via: [{ name: "left-pad", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", range: "<2.0.0", severity: "high" }],
      nodes: ["node_modules/left-pad"],
    };
    audit.vulnerabilities["right-pad"] = {
      name: "right-pad",
      severity: "moderate",
      via: [{ name: "right-pad", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", range: "<2.0.0", severity: "moderate" }],
      nodes: ["node_modules/right-pad"],
    };
    const result = run({ audit });
    expect(result.failures).toEqual(["not on the allowlist: left-pad (high; GHSA-aaaa-bbbb-cccc)"]);
    expect(result.notes.join("\n")).toContain("right-pad (moderate; GHSA-dddd-eeee-ffff)");
  });

  it("fails when an allowlisted advisory reaches the app at a path the entry does not name (a runtime dependency)", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities.glob.nodes.push("node_modules/some-runtime-lib/node_modules/glob");
    const result = run({ audit });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "glob (moderate; GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249) is installed at a path the allowlist does not name: node_modules/some-runtime-lib/node_modules/glob",
    ]);
  });

  it("a listed package with a new advisory is not covered by its old entry", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities.minimatch.severity = "critical";
    audit.vulnerabilities.minimatch.via.push({ name: "minimatch", url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx", range: "<=11.0.9", severity: "critical" });
    const result = run({ audit });
    expect(result.failures.join("\n")).toContain("not on the allowlist: minimatch (critical;");
    // and its entry, now matching nothing, fails too
    expect(result.failures.join("\n")).toContain("allowlist entry no longer matches any finding: minimatch");
  });

  it("an entry that matches no finding fails", () => {
    const allowlist = clone(ALLOWLIST);
    allowlist.entries.push({ package: "picomatch", advisories: ["GHSA-fc5q-39xc-vjpf"], paths: ["node_modules/picomatch"], reason: "build-time only" });
    const result = run({ allowlist });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["allowlist entry no longer matches any finding: picomatch (GHSA-fc5q-39xc-vjpf); remove it"]);
  });

  it("an entry with no ids, a wildcard, no paths or no reason cannot be used", () => {
    const base = ALLOWLIST.entries.find((e: { package: string }) => e.package === "minimatch");
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, advisories: [] }, "no advisory ids"],
      [{ ...base, advisories: ["*"] }, "an advisory id that is not GHSA-xxxx-xxxx-xxxx"],
      [{ ...base, package: "*" }, "no exact package name"],
      [{ ...base, paths: [] }, "no install paths"],
      [{ ...base, paths: ["node_modules/*"] }, "an install path that is not an exact node_modules path"],
      [{ ...base, reason: " " }, "no reason"],
    ];
    for (const [entry, problem] of cases) {
      const allowlist = { ...ALLOWLIST, entries: ALLOWLIST.entries.map((e: { package: string }) => (e.package === "minimatch" ? entry : e)) };
      const result = run({ allowlist });
      expect(result.ok).toBe(false);
      expect(result.failures.join("\n")).toContain(`cannot be used: ${problem}`);
    }
  });

  it("an advisory without a GHSA id fails the run instead of being dropped", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities.minimatch.via.push({ name: "minimatch", url: "https://example.com/advisory/123", range: "<99", severity: "moderate" });
    const result = run({ audit });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("minimatch: npm audit gives an advisory without a GHSA id (minimatch): it cannot be judged");
  });

  it("fails after the recheck date (Israel date), passes on the day, and needs a real calendar date", () => {
    // 15 December 2026 ends at 22:00 UTC in Israel (UTC+2)
    expect(run({ now: new Date("2026-12-15T21:59:59Z") }).ok).toBe(true);
    expect(run({ now: new Date("2026-12-15T22:00:00Z") }).failures).toEqual([
      "the allowlist's recheck_by date 2026-12-15 has passed: look at the findings again, then fix them or renew the date",
    ]);
    for (const bad of ["soon", "2026-99-99", "2026-02-30", "", undefined]) {
      expect(run({ allowlist: { ...ALLOWLIST, recheck_by: bad } }).failures).toEqual(["the allowlist has no valid recheck_by date (a real YYYY-MM-DD)"]);
    }
    expect(calendarDate("2026-12-15")).toBe("2026-12-15");
    expect(calendarDate("2026-99-99")).toBeNull();
  });

  it("fails as soon as a fixed version exists that the dependent accepts", () => {
    // as if glob's advisory were fixed in 13.0.8, a version @sentry/bundler-plugins' ^13.0.6 accepts
    const audit = clone(AUDIT);
    audit.vulnerabilities.glob.via[0].range = ">=9.0.0 <13.0.8";
    const result = run({ audit, published: { ...PUBLISHED, glob: [...PUBLISHED.glob, "13.0.8"] } });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "GHSA-3g3m-2fjr-6pw4: glob 13.0.8 is fixed and @sentry/bundler-plugins accepts it (^13.0.6): update it (npm update glob) and remove the allowlist entry",
    ]);
    // a newer minimatch still inside the vulnerable range is no fix
    expect(run({ published: { ...PUBLISHED, minimatch: [...PUBLISHED.minimatch, "10.2.9"] } }).ok).toBe(true);
  });

  it("names the release of the top-level package that would bring a fix", () => {
    const manifests: Record<string, { version: string; dependencies: Record<string, string> }> = {
      "@sentry/nextjs@latest": { version: "11.14.0", dependencies: { "@sentry/bundler-plugins": "11.14.0" } },
      "@sentry/bundler-plugins@11.14.0": { version: "11.14.0", dependencies: { glob: "^14.0.3" } },
    };
    const registry = { manifest: (name: string, range: string) => manifests[`${name}@${range}`] ?? null };
    const result = run({ registry });
    expect(result.ok).toBe(true);
    expect(result.notes).toContain(
      "GHSA-3g3m-2fjr-6pw4: glob 14.0.6 is fixed, but @sentry/bundler-plugins declares ^13.0.6: a newer @sentry/bundler-plugins is needed; @sentry/nextjs 11.14.0 brings a fixed glob (upgrade once it is two weeks old)",
    );
    const stale = { manifest: (name: string, range: string) => (name === "@sentry/bundler-plugins" ? { version: "11.14.0", dependencies: { glob: "^13.0.6" } } : manifests[`${name}@${range}`] ?? null) };
    expect(run({ registry: stale }).notes.join("\n")).toContain("the newest @sentry/nextjs (11.14.0) still does not take it");
    expect(chainTo(LOCK, "node_modules/glob")).toEqual([
      { name: "@sentry/nextjs", range: "11.10.0" },
      { name: "@sentry/bundler-plugins", range: "11.10.0" },
      { name: "glob", range: "^13.0.6" },
    ]);
  });

  it("fails when published versions cannot be read, or the report is unreadable", () => {
    expect(run({ published: { glob: PUBLISHED.glob } }).failures).toEqual([
      "could not read the published versions of minimatch to look for a fix of GHSA-g3hv-75wg-m249",
    ]);
    expect(run({ audit: null }).ok).toBe(false);
  });

  it("follows a finding to the advisories it stands on", () => {
    expect(rootAdvisories(AUDIT.vulnerabilities, "@sentry/nextjs").map((a: { id: string }) => a.id).sort()).toEqual([
      "GHSA-3g3m-2fjr-6pw4",
      "GHSA-g3hv-75wg-m249",
    ]);
  });
});

describe("audit-check: the small semver", () => {
  it("reads advisory and package ranges", () => {
    expect(satisfies("4.0.7", "<=4.0.7")).toBe(true);
    expect(satisfies("4.0.8", "<=4.0.7")).toBe(false);
    expect(satisfies("13.0.7", ">=9.0.0 <=14.0.1")).toBe(true);
    expect(satisfies("14.0.2", ">=9.0.0 <=14.0.1")).toBe(false);
    expect(satisfies("11.0.0", ">=7.0.0 <11.0.1")).toBe(true);
    expect(satisfies("13.9.0", "^13.0.6")).toBe(true);
    expect(satisfies("14.0.0", "^13.0.6")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("2.5.0", "1.x || >=2.4.0 <3")).toBe(true);
    expect(satisfies("1.4.0", "1.2.0 - 1.4.0")).toBe(true);
    expect(satisfies("5.0.0", "*")).toBe(true);
    expect(satisfies("15.0.0-rc.1", "*")).toBe(false);
  });
});

describe("audit-check in CI", () => {
  it("replaces the plain npm audit step", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("run: node scripts/audit-check.mjs");
    expect(ci).not.toContain("npm audit --omit=dev --audit-level=high");
  });
});
