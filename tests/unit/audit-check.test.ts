import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decide, rootAdvisories, satisfies } from "../../scripts/audit-check.mjs";

const ROOT = join(__dirname, "..", "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

// npm audit --omit=dev --json as it stood on 18 November 2026 with @sentry/nextjs 11.10.0, and the lockfile entries around it
const AUDIT = readJson("tests/unit/fixtures/audit/sentry-build-time.json");
const LOCK = readJson("tests/unit/fixtures/audit/lock-subset.json");
const ALLOWLIST = readJson("scripts/audit-allowlist.json");
// published versions on that day (picomatch's latest is still vulnerable; glob and minimatch have fixes a newer dependent needs)
const PUBLISHED = {
  picomatch: ["2.3.1", "2.3.2", "4.0.6", "4.0.7"],
  glob: ["13.0.6", "13.0.7", "14.0.1", "14.0.2", "14.0.6", "15.0.0-rc.1"],
  minimatch: ["10.2.5", "10.2.6", "11.0.0", "11.0.9"],
};
const BEFORE = new Date("2026-11-18T12:00:00Z");
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe("audit-check: the decision on a captured report", () => {
  it("passes with the owner's allowlist: every one of the 11 findings is listed by package and advisory id", () => {
    const result = decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: BEFORE });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(AUDIT.vulnerabilities)).toHaveLength(11);
    expect(ALLOWLIST.entries.map((e: { package: string }) => e.package).sort()).toEqual(Object.keys(AUDIT.vulnerabilities).sort());
    for (const entry of ALLOWLIST.entries) expect(entry.reason).toBe("build-time only (Sentry bundler plugins), owner (433) א");
    expect(ALLOWLIST.recheck_by).toBe("2026-12-15");
    // the fixes that only a newer dependent can take are notes, not failures
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
    const result = decide({ audit, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: BEFORE });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["not on the allowlist: left-pad (high; GHSA-aaaa-bbbb-cccc)"]);
    expect(result.notes.join("\n")).toContain("right-pad (moderate; GHSA-dddd-eeee-ffff)");
  });

  it("a listed package with a new advisory is not covered by its old entry", () => {
    const audit = clone(AUDIT);
    audit.vulnerabilities.picomatch.via.push({ name: "picomatch", url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx", range: "<=4.0.7", severity: "critical" });
    const result = decide({ audit, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: BEFORE });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("not on the allowlist: picomatch");
  });

  it("fails after the recheck date (Israel date) and passes on the day itself", () => {
    // 15 December 2026 ends at 22:00 UTC in Israel (UTC+2)
    const onDay = decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: new Date("2026-12-15T21:59:59Z") });
    expect(onDay.ok).toBe(true);
    const after = decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: new Date("2026-12-15T22:00:00Z") });
    expect(after.ok).toBe(false);
    expect(after.failures).toEqual([
      "the allowlist's recheck_by date 2026-12-15 has passed: look at the findings again, then fix them or renew the date",
    ]);
    const noDate = decide({ audit: AUDIT, lock: LOCK, allowlist: { ...ALLOWLIST, recheck_by: "soon" }, published: PUBLISHED, now: BEFORE });
    expect(noDate.failures).toEqual(["the allowlist has no valid recheck_by date (YYYY-MM-DD)"]);
  });

  it("fails as soon as a fixed version exists that the dependent accepts", () => {
    const published = { ...PUBLISHED, picomatch: [...PUBLISHED.picomatch, "4.0.8"] };
    const result = decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published, now: BEFORE });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f: string) => f.startsWith("GHSA-fc5q-39xc-vjpf: picomatch 4.0.8 is fixed and") && f.includes("npm update picomatch"))).toBe(true);
    // a newer minimatch that is still inside the vulnerable range is no fix
    const minimatch = decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published: { ...PUBLISHED, minimatch: [...PUBLISHED.minimatch, "10.2.9"] }, now: BEFORE });
    expect(minimatch.ok).toBe(true);
  });

  it("fails when published versions cannot be read, or the report is unreadable", () => {
    const result = decide({ audit: AUDIT, lock: LOCK, allowlist: ALLOWLIST, published: { glob: PUBLISHED.glob, minimatch: PUBLISHED.minimatch }, now: BEFORE });
    expect(result.failures).toEqual(["could not read the published versions of picomatch to look for a fix of GHSA-fc5q-39xc-vjpf"]);
    expect(decide({ audit: null, lock: LOCK, allowlist: ALLOWLIST, published: PUBLISHED, now: BEFORE }).ok).toBe(false);
  });

  it("notes allowlist entries that are no longer needed, without failing", () => {
    const allowlist = clone(ALLOWLIST);
    allowlist.entries.push({ package: "gone", advisories: ["GHSA-1111-2222-3333"], reason: "old" });
    const result = decide({ audit: AUDIT, lock: LOCK, allowlist, published: PUBLISHED, now: BEFORE });
    expect(result.ok).toBe(true);
    expect(result.notes).toContain("allowlist entry no longer needed: gone (GHSA-1111-2222-3333); remove it");
  });

  it("follows a finding to the advisories it stands on", () => {
    expect(rootAdvisories(AUDIT.vulnerabilities, "@sentry/nextjs").map((a: { id: string }) => a.id).sort()).toEqual([
      "GHSA-3g3m-2fjr-6pw4",
      "GHSA-fc5q-39xc-vjpf",
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
