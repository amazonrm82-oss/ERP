#!/usr/bin/env node
// FXS-06 / OPS-05, owner (433) א (18 November 2026): the CI check of known vulnerabilities in what the app ships.
//
// Runs `npm audit --omit=dev --json` and fails on any finding of severity high or critical that is not on the allowlist
// (scripts/audit-allowlist.json). A moderate or low finding that is not listed only prints a note, as
// `npm audit --audit-level=high` did. Each allowlist entry names the exact package, the GHSA ids it carries, the exact
// install paths (npm audit's `nodes`) it is allowed at, and the reason. The owner allowed these findings only because they
// sit in Sentry's build-time code, so:
// - a listed finding installed at any path the entry does not name (the same advisory reaching the app through a runtime
//   dependency) fails;
// - an entry that matches no finding fails (the list must say exactly what npm audit reports);
// - an entry without a package, GHSA ids, paths or reason, or with a wildcard, fails;
// - an advisory npm audit gives without a GHSA id fails (it cannot be judged);
// - after `recheck_by` (a real calendar date, read as an Israel date) the check fails until the date is renewed or the
//   findings are gone;
// - on every run, for every allowlisted advisory, it looks for a published version of the vulnerable package outside the
//   advisory's range that the package depending on it accepts (its declared range in package-lock.json): such a fix can be
//   taken with a plain update, so the check fails and says what to update. A fix only a newer dependent would accept is a
//   note, which also names the newest release of the app's own top-level dependency that would bring it.
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

const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const GHSA_IN_URL = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

/** The advisory database's own spelling of an id: "GHSA-" then lower case; null when it is not a GHSA id. */
export function canonicalId(id) {
  return typeof id === "string" && GHSA.test(id) ? `GHSA-${id.slice(5).toLowerCase()}` : null;
}

/**
 * The advisories a finding stands on: its own, and those of the packages it is vulnerable through. An advisory npm audit
 * gives without a GHSA id has `id: null` (the decision fails on it: it can never be judged against the allowlist).
 */
export function rootAdvisories(vulnerabilities, name, seen = new Set()) {
  if (seen.has(name) || !vulnerabilities[name]) return [];
  seen.add(name);
  const found = [];
  for (const via of vulnerabilities[name].via ?? []) {
    if (typeof via === "string") found.push(...rootAdvisories(vulnerabilities, via, seen));
    else {
      const id = canonicalId(GHSA_IN_URL.exec(String(via.url ?? ""))?.[0]);
      found.push({ id, package: via.name, range: via.range ?? "*", severity: via.severity, title: via.title ?? "" });
    }
  }
  const unique = new Map(found.map((a) => [`${a.id}:${a.package}:${a.title}`, a]));
  return [...unique.values()];
}

// ---------------------------------------------------------------- package-lock: who depends on an installed copy

function parentDir(path) {
  const i = path.lastIndexOf("/node_modules/");
  return i === -1 ? "" : path.slice(0, i);
}

const nameOf = (path) => path.replace(/^.*node_modules\//, "");

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

/** Every { path, name, range } whose dependency `name` resolves to the installed copy at `node` ("" = this app). */
export function dependentsOf(lock, node, name) {
  const packages = lock?.packages ?? {};
  const found = [];
  for (const [path, entry] of Object.entries(packages)) {
    const range = entry.dependencies?.[name] ?? entry.optionalDependencies?.[name] ?? entry.peerDependencies?.[name];
    if (range === undefined || entry.dev) continue;
    if (resolveFrom(packages, path, name) === node) found.push({ path, name: path === "" ? "(this app)" : nameOf(path), range });
  }
  return found;
}

/**
 * The chain from this app's direct dependency down to `node`: [{ name, range }] where each range is what the one before
 * declares (the first is this app's own range for the top-level package). Null when the lock does not lead back to the app.
 */
export function chainTo(lock, node) {
  const chain = [];
  let current = node;
  for (let guard = 0; guard < 50; guard += 1) {
    const [first] = dependentsOf(lock, current, nameOf(current));
    if (!first) return null;
    chain.unshift({ name: nameOf(current), range: first.range });
    if (first.path === "") return chain;
    current = first.path;
  }
  return null;
}

// ---------------------------------------------------------------- the allowlist

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date YYYY-MM-DD, else null (2026-99-99, 2026-02-30 and "soon" are not). */
export function calendarDate(value) {
  const m = typeof value === "string" ? DATE.exec(value) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? value : null;
}

/** Why an allowlist entry cannot be used, or null: package, GHSA ids, the install paths it is allowed at, and a reason. */
function entryProblem(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.package !== "string" || entry.package.trim() === "" || /[*?]/.test(entry.package)) return "no exact package name";
  if (!Array.isArray(entry.advisories) || entry.advisories.length === 0) return "no advisory ids";
  if (entry.advisories.some((id) => canonicalId(id) === null)) return "an advisory id that is not GHSA-xxxx-xxxx-xxxx";
  if (!Array.isArray(entry.paths) || entry.paths.length === 0) return "no install paths";
  if (entry.paths.some((p) => typeof p !== "string" || !p.startsWith("node_modules/") || /[*?]/.test(p))) return "an install path that is not an exact node_modules path";
  if (typeof entry.reason !== "string" || entry.reason.trim() === "") return "no reason";
  return null;
}

// ---------------------------------------------------------------- the decision

function israelDay(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The newest of the versions that satisfy `range`, or null. */
function newest(versions, range) {
  const matching = versions.filter((v) => satisfies(v, range));
  return matching.length === 0 ? null : matching.reduce((a, b) => (compare(parseVersion(a), parseVersion(b)) >= 0 ? a : b));
}

/**
 * Whether the newest release of the top-level package would take a fixed version: walks the chain down with the registry's
 * manifests (`registry.manifest(name, range)` = { version, dependencies } of the newest version in range, or null).
 * Answers { version } of the top-level release that brings a fixed copy, { stillVulnerable: version }, or null when unknown.
 */
function topLevelFix(chain, fixedVersions, registry) {
  if (!chain || chain.length < 2 || !registry) return null;
  const top = registry.manifest(chain[0].name, "latest");
  if (!top) return null;
  let manifest = top;
  for (let i = 1; i < chain.length; i += 1) {
    const range = manifest.dependencies?.[chain[i].name];
    if (range === undefined) return { version: top.version, dropped: chain[i].name };
    if (i === chain.length - 1) {
      return fixedVersions.some((v) => satisfies(v, range)) ? { version: top.version } : { stillVulnerable: top.version };
    }
    manifest = registry.manifest(chain[i].name, range);
    if (!manifest) return null;
  }
  return null;
}

/**
 * The verdict for one audit report. Inputs are plain data, so the unit test drives it with a captured report:
 * - audit: the parsed `npm audit --json`; lock: the parsed package-lock.json; allowlist: the parsed allowlist file;
 * - published: { [package]: string[] } every published version of each allowlisted advisory's package;
 * - registry (optional): { manifest(name, range) } for the note on a fix a newer top-level release would bring;
 * - now: the current time.
 * Answers { ok, failures: string[], notes: string[] }.
 *
 * @param {{ audit: any, lock: any, allowlist: any, published: any, registry?: any, now: Date }} input
 * @returns {{ ok: boolean, failures: string[], notes: string[] }}
 */
export function decide({ audit, lock, allowlist, published, registry, now }) {
  const failures = [];
  const notes = [];
  const vulnerabilities = audit?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    return { ok: false, failures: ["npm audit gave no readable report"], notes };
  }
  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : [];
  for (const entry of entries) {
    const problem = entryProblem(entry);
    if (problem) failures.push(`allowlist entry ${typeof entry?.package === "string" ? entry.package : "?"} cannot be used: ${problem}`);
  }
  const usable = entries.filter((entry) => entryProblem(entry) === null);
  if (entries.length > 0 && !calendarDate(allowlist?.recheck_by)) failures.push("the allowlist has no valid recheck_by date (a real YYYY-MM-DD)");
  else if (entries.length > 0 && israelDay(now) > allowlist.recheck_by) {
    failures.push(`the allowlist's recheck_by date ${allowlist.recheck_by} has passed: look at the findings again, then fix them or renew the date`);
  }

  const usedEntries = new Set();
  const allowedAdvisories = new Map();
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const advisories = rootAdvisories(vulnerabilities, name);
    const unnamed = advisories.filter((a) => a.id === null);
    if (unnamed.length > 0) {
      failures.push(`${name}: npm audit gives an advisory without a GHSA id (${unnamed.map((a) => a.package).join(", ")}): it cannot be judged`);
      continue;
    }
    const ids = advisories.map((a) => a.id);
    const nodes = Array.isArray(finding.nodes) ? finding.nodes : [];
    const label = `${name} (${finding.severity}; ${ids.join(", ") || "no advisory"})`;
    const entry = usable.find((e) => e.package === name && ids.length > 0 && ids.every((id) => e.advisories.map(canonicalId).includes(id)));
    if (!entry) {
      if (FAILING.has(finding.severity)) failures.push(`not on the allowlist: ${label}`);
      else notes.push(`not on the allowlist (does not fail at this severity): ${label}`);
      continue;
    }
    usedEntries.add(entry);
    const outside = nodes.length === 0 ? ["(no install path given)"] : nodes.filter((node) => !entry.paths.includes(node));
    if (outside.length > 0) {
      // the same advisory reached through another path (a runtime dependency, say) is not what the owner allowed
      failures.push(`${label} is installed at a path the allowlist does not name: ${outside.join(", ")}`);
      continue;
    }
    for (const a of advisories) allowedAdvisories.set(`${a.id}:${a.package}`, a);
  }
  for (const entry of usable) {
    if (!usedEntries.has(entry)) failures.push(`allowlist entry no longer matches any finding: ${entry.package} (${entry.advisories.join(", ")}); remove it`);
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
    for (const node of vulnerabilities[advisory.package]?.nodes ?? []) {
      for (const dependent of dependentsOf(lock, node, advisory.package)) {
        const takeable = newest(fixed, dependent.range);
        if (takeable) {
          failures.push(
            `${advisory.id}: ${advisory.package} ${takeable} is fixed and ${dependent.name} accepts it (${dependent.range}): update it (npm update ${advisory.package}) and remove the allowlist entry`,
          );
          continue;
        }
        const chain = dependent.path === "" ? null : chainTo(lock, dependent.path);
        const top = topLevelFix(chain ? [...chain, { name: advisory.package, range: dependent.range }] : null, fixed, registry);
        const latestFixed = newest(fixed, "*");
        let line = `${advisory.id}: ${advisory.package} ${latestFixed} is fixed, but ${dependent.name} declares ${dependent.range}: a newer ${dependent.name} is needed`;
        if (top?.version && !top.dropped) line += `; ${chain[0].name} ${top.version} brings a fixed ${advisory.package} (upgrade once it is two weeks old)`;
        else if (top?.dropped) line += `; ${chain[0].name} ${top.version} no longer depends on ${top.dropped}`;
        else if (top?.stillVulnerable) line += `; the newest ${chain[0].name} (${top.stillVulnerable}) still does not take it`;
        notes.push(line);
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

/** The registry's manifest of the newest version of `name` in `range` (or its latest): { version, dependencies }. */
function npmManifest(name, range) {
  const spec = range === "latest" ? `${name}@latest` : `${name}@${range}`;
  const answer = npmJson(["view", spec, "version", "dependencies", "--json"]);
  const pick = Array.isArray(answer) ? answer[answer.length - 1] : answer;
  return pick && typeof pick.version === "string" ? { version: pick.version, dependencies: pick.dependencies ?? {} } : null;
}

function main() {
  const audit = npmJson(["audit", "--omit=dev", "--json"]);
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const allowlist = JSON.parse(readFileSync(join(ROOT, "scripts", "audit-allowlist.json"), "utf8"));
  const names = new Set();
  for (const name of Object.keys(audit?.vulnerabilities ?? {})) {
    for (const a of rootAdvisories(audit.vulnerabilities, name)) if (a.package) names.add(a.package);
  }
  const published = {};
  for (const name of names) {
    const versions = npmJson(["view", name, "versions", "--json"]);
    if (Array.isArray(versions)) published[name] = versions;
    else if (typeof versions === "string") published[name] = [versions];
  }
  const result = decide({ audit, lock, allowlist, published, registry: { manifest: npmManifest }, now: new Date() });
  const total = Object.keys(audit?.vulnerabilities ?? {}).length;
  console.log(`audit-check: ${total} finding(s) in production dependencies`);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const failure of result.failures) console.log(`FAIL: ${failure}`);
  console.log(result.ok ? "audit-check: ok" : "audit-check: failed");
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
