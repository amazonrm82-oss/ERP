#!/usr/bin/env node
// FXS-06 / OPS-05, owner (433) א (18 November 2026): the CI check of known vulnerabilities in what the app ships.
//
// Runs `npm audit --omit=dev --json` and fails on any finding of severity high or critical that is not on the allowlist
// (scripts/audit-allowlist.json). Each allowlist entry names the package, the advisory ids (GHSA-...) it carries and the
// reason. A moderate or low finding that is not listed only prints a note, as `npm audit --audit-level=high` did.
//
// Two rules keep the list short-lived:
// - after `recheck_by` (an Israel date) the check fails until the date is renewed or the findings are gone;
// - on every run, for every allowlisted advisory, it looks for a published version of the vulnerable package that is outside
//   the advisory's range AND that the package depending on it accepts (its declared range in package-lock.json): such a fix
//   can be taken with a plain update, so the check fails and says which package to update. A fixed version that only a newer
//   dependent would accept is printed as a note naming that dependent.
//
// The output holds package names, versions and advisory ids only. No new dependency: the small semver below covers the range
// forms npm advisories and package.json files use (^, ~, comparators, x-ranges, hyphens, ||).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAILING = new Set(["high", "critical"]);

// ---------------------------------------------------------------- semver (the subset this check needs)

/** [major, minor, patch, prerelease] or null; a part that is x, X, * or missing is null. */
function parseVersion(text) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  const part = (p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p));
  return [part(m[1]), part(m[2]), part(m[3]), m[4] ?? null];
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1;
  if (b[3] === null) return -1;
  return a[3] < b[3] ? -1 : 1;
}

/** One comparator as a list of [op, version] tests (op one of >=, >, <=, <, =). */
function comparatorTests(text) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(text.trim());
  const op = m[1] ?? "";
  const v = parseVersion(m[2] || "*");
  if (!v) throw new Error(`unsupported version range: ${text}`);
  const [maj, min, pat] = v;
  const full = [maj ?? 0, min ?? 0, pat ?? 0, v[3]];
  if (maj === null) return op === "<" || op === ">" ? [["<", [0, 0, 0, null]]] : [];
  if (op === "^") {
    const upper = maj > 0 || min === null ? [maj + 1, 0, 0, null] : min > 0 || pat === null ? [0, min + 1, 0, null] : [0, 0, pat + 1, null];
    return [[">=", full], ["<", upper]];
  }
  if (op === "~") return [[">=", full], ["<", min === null ? [maj + 1, 0, 0, null] : [maj, min + 1, 0, null]]];
  const next = min === null ? [maj + 1, 0, 0, null] : pat === null ? [maj, min + 1, 0, null] : null;
  if (op === "" || op === "=") return next ? [[">=", full], ["<", next]] : [["=", full]];
  if (op === "<=") return next ? [["<", next]] : [["<=", full]];
  if (op === ">") return next ? [[">=", next]] : [[">", full]];
  return [[op, full]];
}

function passes(version, [op, bound]) {
  const c = compare(version, bound);
  return op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : op === "<" ? c < 0 : c === 0;
}

/** Whether a version satisfies a range ("" and "*" = any). Prereleases are never considered. */
export function satisfies(versionText, range) {
  const version = parseVersion(versionText);
  if (!version || version.slice(0, 3).some((p) => p === null) || version[3] !== null) return false;
  return range.split("||").some((alternative) => {
    const text = alternative.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    return parts.flatMap(comparatorTests).every((test) => passes(version, test));
  });
}

// ---------------------------------------------------------------- reading npm audit

const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

/** The advisory database's own spelling of an id: "GHSA-" then lower case. */
export function canonicalId(id) {
  return `GHSA-${String(id).slice(5).toLowerCase()}`;
}

/** The advisories a finding stands on: its own, and those of the packages it is vulnerable through. */
export function rootAdvisories(vulnerabilities, name, seen = new Set()) {
  if (seen.has(name) || !vulnerabilities[name]) return [];
  seen.add(name);
  const found = [];
  for (const via of vulnerabilities[name].via ?? []) {
    if (typeof via === "string") found.push(...rootAdvisories(vulnerabilities, via, seen));
    else {
      const id = GHSA.exec(via.url ?? "")?.[0];
      if (id) found.push({ id: canonicalId(id), package: via.name, range: via.range ?? "*", severity: via.severity });
    }
  }
  const unique = new Map(found.map((a) => [`${a.id}:${a.package}`, a]));
  return [...unique.values()];
}

// ---------------------------------------------------------------- package-lock: who depends on an installed copy

function parentDir(path) {
  const i = path.lastIndexOf("/node_modules/");
  return i === -1 ? "" : path.slice(0, i);
}

/** The lock path a package `name` resolves to when required from the package at `from` (node's lookup, walking up). */
function resolveFrom(packages, from, name) {
  let dir = from;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (dir === "") return null;
    dir = parentDir(dir);
  }
}

/** Every [dependent path, declared range] whose dependency `name` resolves to the installed copy at `node`. */
export function dependentsOf(lock, node, name) {
  const packages = lock.packages ?? {};
  const found = [];
  for (const [path, entry] of Object.entries(packages)) {
    const range = entry.dependencies?.[name] ?? entry.optionalDependencies?.[name] ?? entry.peerDependencies?.[name];
    if (range === undefined || entry.dev) continue;
    if (resolveFrom(packages, path, name) === node) found.push([path === "" ? "(this app)" : path.replace(/^.*node_modules\//, ""), range]);
  }
  return found;
}

// ---------------------------------------------------------------- the decision

function israelDay(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The verdict for one audit report. Inputs are plain data, so the unit test drives it with a captured report:
 * - audit: the parsed `npm audit --json`; lock: the parsed package-lock.json; allowlist: the parsed allowlist file;
 * - published: { [package]: string[] } of every published version of each allowlisted advisory's package;
 * - now: the current time.
 * Answers { ok, failures: string[], notes: string[] }.
 */
export function decide({ audit, lock, allowlist, published, now }) {
  const failures = [];
  const notes = [];
  const vulnerabilities = audit?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    return { ok: false, failures: ["npm audit gave no readable report"], notes };
  }
  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : [];
  const recheckBy = typeof allowlist?.recheck_by === "string" && /^\d{4}-\d{2}-\d{2}$/.test(allowlist.recheck_by) ? allowlist.recheck_by : null;
  const today = israelDay(now);

  const usedEntries = new Set();
  const allowedAdvisories = new Map();
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const advisories = rootAdvisories(vulnerabilities, name);
    const ids = advisories.map((a) => a.id);
    const entry = entries.find(
      (e) => e.package === name && typeof e.reason === "string" && e.reason.trim() !== "" && ids.length > 0 && ids.every((id) => (e.advisories ?? []).map(canonicalId).includes(id)),
    );
    const label = `${name} (${finding.severity}; ${ids.join(", ") || "no advisory id"})`;
    if (entry) {
      usedEntries.add(entry);
      for (const a of advisories) allowedAdvisories.set(`${a.id}:${a.package}`, a);
      continue;
    }
    if (FAILING.has(finding.severity)) failures.push(`not on the allowlist: ${label}`);
    else notes.push(`not on the allowlist (does not fail at this severity): ${label}`);
  }

  if (usedEntries.size > 0) {
    if (!recheckBy) failures.push("the allowlist has no valid recheck_by date (YYYY-MM-DD)");
    else if (today > recheckBy) failures.push(`the allowlist's recheck_by date ${recheckBy} has passed: look at the findings again, then fix them or renew the date`);
  }
  for (const entry of entries) {
    if (!usedEntries.has(entry)) notes.push(`allowlist entry no longer needed: ${entry.package} (${(entry.advisories ?? []).join(", ")}); remove it`);
  }

  // a fixed version an update can take
  for (const advisory of allowedAdvisories.values()) {
    const versions = published?.[advisory.package];
    if (!Array.isArray(versions)) {
      failures.push(`could not read the published versions of ${advisory.package} to look for a fix of ${advisory.id}`);
      continue;
    }
    const fixed = versions.filter((v) => satisfies(v, "*") && !satisfies(v, advisory.range));
    if (fixed.length === 0) continue;
    const nodes = vulnerabilities[advisory.package]?.nodes ?? [];
    for (const node of nodes) {
      for (const [dependent, range] of dependentsOf(lock, node, advisory.package)) {
        const takeable = fixed.filter((v) => satisfies(v, range));
        if (takeable.length > 0) {
          failures.push(
            `${advisory.id}: ${advisory.package} ${takeable[takeable.length - 1]} is fixed and ${dependent} accepts it (${range}): update it (npm update ${advisory.package}) and remove the allowlist entry`,
          );
        } else {
          notes.push(`${advisory.id}: ${advisory.package} ${fixed[fixed.length - 1]} is fixed, but ${dependent} declares ${range}: a newer ${dependent} is needed`);
        }
      }
    }
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)], notes: [...new Set(notes)] };
}

// ---------------------------------------------------------------- running it

function npmJson(args) {
  const run = spawnSync("npm", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(run.stdout);
  } catch {
    return null;
  }
}

function main() {
  const audit = npmJson(["audit", "--omit=dev", "--json"]);
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const allowlist = JSON.parse(readFileSync(join(ROOT, "scripts", "audit-allowlist.json"), "utf8"));
  const names = new Set();
  for (const name of Object.keys(audit?.vulnerabilities ?? {})) {
    for (const a of rootAdvisories(audit.vulnerabilities, name)) names.add(a.package);
  }
  const published = {};
  for (const name of names) {
    const versions = npmJson(["view", name, "versions", "--json"]);
    if (Array.isArray(versions)) published[name] = versions;
    else if (typeof versions === "string") published[name] = [versions];
  }
  const result = decide({ audit, lock, allowlist, published, now: new Date() });
  const total = Object.keys(audit?.vulnerabilities ?? {}).length;
  console.log(`audit-check: ${total} finding(s) in production dependencies`);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const failure of result.failures) console.log(`FAIL: ${failure}`);
  console.log(result.ok ? "audit-check: ok" : "audit-check: failed");
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
