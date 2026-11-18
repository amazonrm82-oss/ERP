import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  calendarDate,
  chainTo,
  chainsTo,
  decide,
  rootAdvisories,
  satisfies,
  summaryMarkdown,
  writeStepSummary,
} from "../../scripts/audit-check.mjs";

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
  it("passes with the owner's allowlist, which lists only the root packages, exactly as npm audit and the lockfile give them", () => {
    const result = run();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    // the runtime @sentry/* packages are never listed: they are covered as parents through the build-time chain
    expect(ALLOWLIST.entries.map((e: { package: string }) => e.package).sort()).toEqual(["glob", "minimatch"]);
    for (const entry of ALLOWLIST.entries) {
      expect(entry.reason).toBe("build-time only (Sentry bundler plugins), owner (433) א");
      expect(entry.paths).toEqual(AUDIT.vulnerabilities[entry.package].nodes);
      expect([...entry.chains].sort()).toEqual(entry.paths.flatMap((node: string) => chainsTo(LOCK, node)).sort());
    }
    expect(chainsTo(LOCK, "node_modules/glob")).toEqual([
      "node_modules/@sentry/nextjs@11.10.0 > node_modules/@sentry/bundler-plugins@11.10.0 > node_modules/glob@13.0.7",
      "node_modules/@sentry/nextjs@11.10.0 > node_modules/@sentry/node@11.10.0 > node_modules/@sentry/bundler-plugins@11.10.0 > node_modules/glob@13.0.7",
    ]);
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
    expect(result.failures).toContain(
      "glob (moderate; GHSA-3g3m-2fjr-6pw4) is installed at a path the allowlist does not name: node_modules/some-runtime-lib/node_modules/glob",
    );
    expect(result.failures).toContain(
      "glob (moderate; GHSA-3g3m-2fjr-6pw4) is installed at node_modules/some-runtime-lib/node_modules/glob, which is not on a chain the allowlist names for minimatch",
    );
    // the parents standing on it are no longer covered, and add no noise of their own
    expect(result.failures).toHaveLength(2);
  });

  it("a listed package with a new advisory is not covered by its old entry", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities.minimatch.severity = "critical";
    audit.vulnerabilities.minimatch.via.push({ name: "minimatch", url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx", range: "<=11.0.9", severity: "critical" });
    const result = run({ audit });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      "minimatch (critical; GHSA-g3hv-75wg-m249, GHSA-zzzz-yyyy-xxxx) carries an advisory its allowlist entry does not name: GHSA-zzzz-yyyy-xxxx",
    );
    expect(result.failures).toContain("minimatch (critical; GHSA-g3hv-75wg-m249, GHSA-zzzz-yyyy-xxxx) is more severe than its allowlist entry (moderate)");
  });

  it("an entry that matches no finding fails", () => {
    const allowlist = clone(ALLOWLIST);
    allowlist.entries.push({
      package: "picomatch",
      severity: "moderate",
      advisories: ["GHSA-fc5q-39xc-vjpf"],
      paths: ["node_modules/picomatch"],
      chains: ["node_modules/@sentry/nextjs@11.10.0 > node_modules/picomatch@4.0.3"],
      reason: "build-time only",
    });
    const result = run({ allowlist });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["allowlist entry no longer matches any finding: picomatch (GHSA-fc5q-39xc-vjpf); remove it"]);
  });

  it("an entry with no ids, severity, chains, a wildcard, no paths or no reason cannot be used", () => {
    const base = ALLOWLIST.entries.find((e: { package: string }) => e.package === "minimatch");
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, advisories: [] }, "no advisory ids"],
      [{ ...base, advisories: ["*"] }, "an advisory id that is not GHSA-xxxx-xxxx-xxxx"],
      [{ ...base, package: "*" }, "no exact package name"],
      [{ ...base, paths: [] }, "no install paths"],
      [{ ...base, paths: ["node_modules/*"] }, "an install path that is not an exact node_modules path"],
      [{ ...base, reason: " " }, "no reason"],
      [{ ...base, severity: undefined }, "no severity (info, low, moderate, high or critical)"],
      [{ ...base, severity: "severe" }, "no severity (info, low, moderate, high or critical)"],
      [{ ...base, chains: [] }, "no dependent chains"],
      [{ ...base, chains: ["node_modules/@sentry/*@11.10.0 > node_modules/glob/node_modules/minimatch@10.2.6"] }, "a chain that is not exact node_modules paths with their exact versions"],
      [{ ...base, chains: ["node_modules/@sentry/nextjs > node_modules/glob/node_modules/minimatch"] }, "a chain that is not exact node_modules paths with their exact versions"],
      [{ ...base, chains: ["node_modules/@sentry/nextjs@^11 > node_modules/glob/node_modules/minimatch@10.2.6"] }, "a chain that is not exact node_modules paths with their exact versions"],
      [{ ...base, chains: ["node_modules/@sentry/nextjs@11.10.0 > node_modules/glob@13.0.7"] }, "a chain that does not end at one of its install paths"],
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

  it("fails when a runtime package depends on the same hoisted copy (install location alone is not enough)", () => {
    // a non-dev package declaring glob@^13 resolves to the very node_modules/glob the allowlist names
    const lock = clone(LOCK);
    lock.packages[""].dependencies["runtime-lib"] = "^1.0.0";
    lock.packages["node_modules/runtime-lib"] = { version: "1.0.0", dependencies: { glob: "^13.0.0" } };
    const result = run({ lock });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      "glob (moderate; GHSA-3g3m-2fjr-6pw4) at node_modules/glob is also reached through a chain the allowlist does not name: node_modules/runtime-lib@1.0.0 > node_modules/glob@13.0.7",
    );
    // a runtime package depending on the bundler plugins one level up is caught on both roots
    const lock2 = clone(LOCK);
    lock2.packages[""].dependencies["runtime-lib"] = "^1.0.0";
    lock2.packages["node_modules/runtime-lib"] = { version: "1.0.0", dependencies: { "@sentry/bundler-plugins": "11.10.0" } };
    const failures = run({ lock: lock2 }).failures.join("\n");
    expect(failures).toContain("node_modules/runtime-lib@1.0.0 > node_modules/@sentry/bundler-plugins@11.10.0 > node_modules/glob@13.0.7");
    expect(failures).toContain(
      "node_modules/runtime-lib@1.0.0 > node_modules/@sentry/bundler-plugins@11.10.0 > node_modules/glob@13.0.7 > node_modules/glob/node_modules/minimatch@10.2.6",
    );
    // a dev package depending on it changes nothing: it is not shipped
    const lock3 = clone(LOCK);
    lock3.packages["node_modules/dev-lib"] = { version: "1.0.0", dev: true, dependencies: { glob: "^13.0.0" } };
    expect(run({ lock: lock3 }).ok).toBe(true);
  });

  it("covers the parents only while every via leads to allowlisted advisories through the named chain", () => {
    const result = run();
    expect(result.ok).toBe(true);
    // a parent with a via the allowlist does not cover fails, even at moderate
    const audit = clone(AUDIT);
    audit.vulnerabilities["@sentry/node"].via.push("left-pad");
    audit.vulnerabilities["left-pad"] = {
      name: "left-pad",
      severity: "moderate",
      via: [{ name: "left-pad", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", range: "<2.0.0", severity: "moderate" }],
      nodes: ["node_modules/left-pad"],
    };
    const failed = run({ audit });
    expect(failed.ok).toBe(false);
    expect(failed.failures).toEqual(["@sentry/node (moderate; no advisory of its own) stands on left-pad, which the allowlist does not cover"]);
    // a parent with an advisory of its own is not a parent: it fails as usual
    const own = clone(AUDIT);
    own.vulnerabilities["@sentry/nextjs"].via.push({ name: "@sentry/nextjs", url: "https://github.com/advisories/GHSA-1111-2222-3333", range: "<99", severity: "low" });
    expect(run({ audit: own }).failures).toEqual([
      "not covered by the allowlist although it reaches an allowlisted advisory: @sentry/nextjs (moderate; GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249, GHSA-1111-2222-3333)",
    ]);
    // a parent installed off the named chain fails
    const off = clone(AUDIT);
    off.vulnerabilities["@sentry/node"].nodes = ["node_modules/other/node_modules/@sentry/node"];
    expect(run({ audit: off }).failures.join("\n")).toContain("is not on a chain the allowlist names for glob");
    // listing a parent is refused: only roots go on the list
    const allowlist = clone(ALLOWLIST);
    allowlist.entries.push({ ...ALLOWLIST.entries[0], package: "@sentry/nextjs", paths: ["node_modules/@sentry/nextjs"], chains: ["node_modules/@sentry/nextjs@11.10.0"] });
    expect(run({ allowlist }).failures).toContain(
      "allowlist entry @sentry/nextjs names a package that carries no advisory itself: list only the root packages",
    );
  });

  it("fails when a finding is more severe than its entry, also through a parent", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities.glob.severity = "high";
    audit.vulnerabilities.glob.via[0].severity = "high";
    expect(run({ audit }).failures).toContain("glob (high; GHSA-3g3m-2fjr-6pw4) is more severe than its allowlist entry (moderate)");
    const parent = clone(AUDIT);
    parent.vulnerabilities["@sentry/nextjs"].severity = "critical";
    expect(run({ audit: parent }).failures).toEqual([
      "@sentry/nextjs (critical; no advisory of its own) is more severe than the allowlist entries it stands on",
    ]);
  });

  it("fails when an entry lists an id, a path or a chain npm audit or the lockfile no longer gives", () => {
    const allowlist = clone(ALLOWLIST);
    allowlist.entries[0].advisories.push("GHSA-g3hv-75wg-m249");
    expect(run({ allowlist }).failures).toEqual([
      "allowlist entry glob lists GHSA-g3hv-75wg-m249, which npm audit no longer reports for it; remove the id",
    ]);
    const chains = clone(ALLOWLIST);
    chains.entries[0].chains.push("node_modules/@sentry/nextjs@11.10.0 > node_modules/glob@13.0.7");
    expect(run({ allowlist: chains }).failures).toEqual([
      "allowlist entry glob names a chain the lockfile no longer has: node_modules/@sentry/nextjs@11.10.0 > node_modules/glob@13.0.7; remove it",
    ]);
    const paths = clone(ALLOWLIST);
    paths.entries[1].paths.push("node_modules/minimatch");
    paths.entries[1].chains.push("node_modules/eslint@9.39.5 > node_modules/minimatch@3.1.5");
    expect(run({ allowlist: paths }).failures).toContain(
      "allowlist entry minimatch names an install path npm audit no longer reports: node_modules/minimatch; remove it",
    );
  });

  it("fails on a moderate finding that reaches an allowlisted advisory but is not covered", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities["other-tool"] = { name: "other-tool", severity: "moderate", via: ["glob"], nodes: ["node_modules/other-tool"] };
    expect(run({ audit }).failures).toEqual([
      "other-tool (moderate; no advisory of its own) is installed at node_modules/other-tool, which is not on a chain the allowlist names for glob",
      "other-tool (moderate; no advisory of its own) is installed at node_modules/other-tool, which is not on a chain the allowlist names for minimatch",
    ]);
  });

  it("fails when a version on an allowed chain changes, until someone checks the build-time claim again", () => {
    for (const [path, version] of [
      ["node_modules/@sentry/node", "11.11.0"],
      ["node_modules/@sentry/nextjs", "11.10.1"],
      ["node_modules/glob", "13.0.8"],
    ]) {
      const lock = clone(LOCK);
      lock.packages[path].version = version;
      const failures = run({ lock }).failures.join("\n");
      expect(failures).toContain(`${path}@${version}`);
      expect(failures).toContain("the chain's versions changed");
      expect(failures).toContain("then update scripts/audit-allowlist.json");
    }
    const lock = clone(LOCK);
    lock.packages["node_modules/glob/node_modules/minimatch"].version = "10.2.7";
    expect(run({ lock }).failures).toEqual([
      "allowlist entry minimatch: the chain's versions changed (now node_modules/@sentry/nextjs@11.10.0 > node_modules/@sentry/bundler-plugins@11.10.0 > node_modules/glob@13.0.7 > node_modules/glob/node_modules/minimatch@10.2.7; node_modules/@sentry/nextjs@11.10.0 > node_modules/@sentry/node@11.10.0 > node_modules/@sentry/bundler-plugins@11.10.0 > node_modules/glob@13.0.7 > node_modules/glob/node_modules/minimatch@10.2.7): check that minimatch is still reached only by build-time code of these packages, then update scripts/audit-allowlist.json",
    ]);
  });

  it("marks a dependent that only reaches the copy through a cycle as not reached from the app", () => {
    const lock = clone(LOCK);
    lock.packages["node_modules/a"] = { version: "1.0.0", dependencies: { b: "^1.0.0", glob: "^13.0.6" } };
    lock.packages["node_modules/b"] = { version: "1.0.0", dependencies: { a: "^1.0.0" } };
    expect(chainsTo(lock, "node_modules/glob")).toContain("(not reached from the app) > node_modules/b@1.0.0 > node_modules/a@1.0.0 > node_modules/glob@13.0.7");
    const result = run({ lock });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("(not reached from the app)");
  });

  it("reports a dependency spec that is not a version range instead of throwing", () => {
    for (const spec of ["npm:glob@^13.0.6", "git+https://example.com/glob.git", "file:../glob", "workspace:*"]) {
      const lock = clone(LOCK);
      lock.packages["node_modules/@sentry/bundler-plugins"].dependencies.glob = spec;
      const result = run({ lock });
      expect(result.ok).toBe(false);
      expect(result.failures).toContain(
        `GHSA-3g3m-2fjr-6pw4: @sentry/bundler-plugins declares glob as "${spec}", which is not a version range this check reads: a fix cannot be looked for`,
      );
    }
    const audit = clone(AUDIT);
    audit.vulnerabilities.glob.via[0].range = "git+https://x";
    expect(run({ audit }).failures).toContain('GHSA-3g3m-2fjr-6pw4: cannot read the vulnerable range "git+https://x" of glob, so a fix cannot be looked for');
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

describe("audit-check: the run summary (owner (435) א)", () => {
  it("shows the notes prominently, with the recheck date, when the check passes", () => {
    const result = run();
    expect(result.ok).toBe(true);
    expect(result.notes.length).toBeGreaterThan(0);
    const md = summaryMarkdown({ result, total: 5, recheckBy: "2026-12-15" });
    expect(md.startsWith("## Audit check: passed\n")).toBe(true);
    expect(md).toContain("### :warning: Notes (CI passes, but look at these)");
    for (const note of result.notes) expect(md).toContain(`- ${note.replace(/`/g, "'")}`);
    expect(md).toContain("Allowlist recheck date: **2026-12-15**");
    expect(md).not.toContain("### Failures");
  });

  it("lists the failures when the check fails", () => {
    const md = summaryMarkdown({
      result: { ok: false, failures: ["the allowlist's recheck_by date 2026-12-15 has passed"], notes: [] },
      total: 5,
      recheckBy: "2026-12-15",
    });
    expect(md.startsWith("## Audit check: FAILED\n")).toBe(true);
    expect(md).toContain("### Failures\n\n- :x: the allowlist's recheck_by date 2026-12-15 has passed");
    expect(md).not.toContain("Notes");
  });

  it("keeps each note on one line and says when no recheck date is set", () => {
    const md = summaryMarkdown({ result: { ok: true, failures: [], notes: ["a\nb `c`"] }, total: 0, recheckBy: "not a date" });
    expect(md).toContain("- a b 'c'\n");
    expect(md).toContain("Allowlist recheck date: none set.");
  });

  it("writes to GITHUB_STEP_SUMMARY only when it is set, and a failed write is not an error", () => {
    const writes: Array<[string, string]> = [];
    const append = (path: string, text: string) => void writes.push([path, text]);
    expect(writeStepSummary("x", { env: {}, append })).toBe(false);
    expect(writes).toEqual([]);
    expect(writeStepSummary("## y\n", { env: { GITHUB_STEP_SUMMARY: "/tmp/summary.md" }, append })).toBe(true);
    expect(writes).toEqual([["/tmp/summary.md", "## y\n"]]);
    const broken = () => {
      throw new Error("disk full");
    };
    expect(writeStepSummary("z", { env: { GITHUB_STEP_SUMMARY: "/tmp/s" }, append: broken })).toBe(false);
  });

  it("package.json holds no npm overrides (no override of Sentry's dependencies, owner (435) א)", () => {
    const pkg = readJson("package.json");
    expect(pkg).not.toHaveProperty("overrides");
    expect(pkg).not.toHaveProperty("resolutions");
  });
});
