#!/usr/bin/env node
// FXS-06 / OPS-05, owner (433) א (18 November 2026): the CI check of known vulnerabilities in what the app ships.
//
// Runs `npm audit --omit=dev --json` and fails on any finding of severity high or critical that is not covered by the
// allowlist (scripts/audit-allowlist.json). A moderate or low finding that touches nothing on the allowlist only prints a
// note, as `npm audit --audit-level=high` did. The allowlist names ONLY the root vulnerable packages (the ones that carry an
// advisory themselves): the exact package, its severity, the exact GHSA ids npm audit gives for it, the exact install paths
// (npm audit's `nodes`), every chain of packages through which the app reaches each path (from the app's direct dependency
// down, read from package-lock.json), and the reason. The owner allowed these findings only because they sit in Sentry's
// build-time code, so:
// - a root finding is covered only when its ids, paths and chains are exactly the entry's and its severity is not above the
//   entry's: any other package depending on the vulnerable copy (a runtime dependency resolving to the same hoisted folder,
//   say) adds a chain and fails, an id or chain npm audit or the lockfile no longer gives fails (the list must say exactly
//   what is there), a new advisory on the package fails;
// - a parent finding (one npm audit reports only because it depends on a vulnerable package, like @sentry/nextjs) is not
//   listed: it is covered when every `via` it has is a covered finding, it carries no advisory of its own, every install path
//   of it lies on a chain of each root it reaches, and its severity is not above theirs;
// - any finding, whatever its severity, that reaches an allowlisted advisory but is not covered fails;
// - an entry for a package npm audit does not report fails, and so does one for a package that carries no advisory itself;
// - an entry without a package, severity, GHSA ids, paths, chains or reason, or with a wildcard, fails;
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

/**
 * Every chain through which this app reaches the installed copy at `node`, as "a > b > node" strings of lock paths, from
 * the app's direct dependency down. A package that depends on a copy but does not itself lead back to the app gives a
 * chain starting with "(not reached from the app)", which no allowlist can name. Cycles are not routes and are skipped.
 */
export function chainsTo(lock, node, limit = 200) {
  const found = new Set();
  const walk = (path, below, seen) => {
    if (found.size >= limit) return;
    const dependents = dependentsOf(lock, path, nameOf(path));
    if (dependents.length === 0) {
      found.add(["(not reached from the app)", path, ...below].join(" > "));
      return;
    }
    for (const dependent of dependents) {
      if (dependent.path === "") found.add([path, ...below].join(" > "));
      else if (!seen.has(dependent.path)) walk(dependent.path, [path, ...below], new Set([...seen, dependent.path]));
    }
  };
  walk(node, [], new Set([node]));
  return [...found].sort();
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

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const EXACT_PATH = (p) => typeof p === "string" && p.startsWith("node_modules/") && !/[*?\s]/.test(p);
const chainParts = (chain) => chain.split(" > ");

/** Why an allowlist entry cannot be used, or null: package, severity, GHSA ids, install paths, their chains, and a reason. */
function entryProblem(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (typeof entry.package !== "string" || entry.package.trim() === "" || /[*?]/.test(entry.package)) return "no exact package name";
  if (!Object.hasOwn(RANK, entry.severity)) return "no severity (info, low, moderate, high or critical)";
  if (!Array.isArray(entry.advisories) || entry.advisories.length === 0) return "no advisory ids";
  if (entry.advisories.some((id) => canonicalId(id) === null)) return "an advisory id that is not GHSA-xxxx-xxxx-xxxx";
  if (!Array.isArray(entry.paths) || entry.paths.length === 0) return "no install paths";
  if (!entry.paths.every(EXACT_PATH)) return "an install path that is not an exact node_modules path";
  if (!Array.isArray(entry.chains) || entry.chains.length === 0) return "no dependent chains";
  for (const chain of entry.chains) {
    if (typeof chain !== "string" || !chainParts(chain).every(EXACT_PATH)) return "a chain that is not exact node_modules paths joined by \" > \"";
    if (!entry.paths.includes(chainParts(chain).at(-1))) return `a chain that does not end at one of its install paths: ${chain}`;
  }
  for (const path of entry.paths) if (!entry.chains.some((c) => chainParts(c).at(-1) === path)) return `no chain for install path ${path}`;
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

  const byPackage = new Map(usable.map((e) => [e.package, e]));
  const allowedIds = new Set(usable.flatMap((e) => e.advisories.map((id) => `${canonicalId(id)}:${e.package}`)));
  const ownAdvisories = (finding) => rootAdvisories({ [finding.name]: { ...finding, via: (finding.via ?? []).filter((v) => typeof v !== "string") } }, finding.name);

  // whether a finding is covered: { covered, entries (the root entries it stands on), problems (why not, when known) }
  const memo = new Map();
  const cover = (name) => {
    if (memo.has(name)) return memo.get(name);
    // blocked: not covered only because something it stands on is not (that one's failure names the cause)
    const result = { covered: false, blocked: false, entries: new Set(), problems: [] };
    memo.set(name, result); // a cycle in `via` is not covered
    const finding = vulnerabilities[name];
    if (!finding) return result;
    const own = ownAdvisories({ ...finding, name });
    const ownIds = [...new Set(own.map((a) => a.id))].sort();
    const parents = (finding.via ?? []).filter((v) => typeof v === "string");
    const nodes = Array.isArray(finding.nodes) ? finding.nodes : [];
    const entry = byPackage.get(name);
    const label = `${name} (${finding.severity}; ${ownIds.join(", ") || "no advisory of its own"})`;
    if (ownIds.includes(null) || nodes.length === 0) {
      if (nodes.length === 0) result.problems.push(`${label}: npm audit gives no install path`);
      return result;
    }
    if (ownIds.length > 0) {
      if (!entry) return result;
      const listed = [...new Set(entry.advisories.map(canonicalId))].sort();
      const unlisted = ownIds.filter((id) => !listed.includes(id));
      const stale = listed.filter((id) => !ownIds.includes(id));
      if (unlisted.length > 0) result.problems.push(`${label} carries an advisory its allowlist entry does not name: ${unlisted.join(", ")}`);
      if (stale.length > 0) result.problems.push(`allowlist entry ${name} lists ${stale.join(", ")}, which npm audit no longer reports for it; remove the id`);
      if (RANK[finding.severity] === undefined || RANK[finding.severity] > RANK[entry.severity]) {
        result.problems.push(`${label} is more severe than its allowlist entry (${entry.severity})`);
      }
      const outside = nodes.filter((n) => !entry.paths.includes(n));
      const gone = entry.paths.filter((p) => !nodes.includes(p));
      if (outside.length > 0) result.problems.push(`${label} is installed at a path the allowlist does not name: ${outside.join(", ")}`);
      if (gone.length > 0) result.problems.push(`allowlist entry ${name} names an install path npm audit no longer reports: ${gone.join(", ")}; remove it`);
      for (const node of nodes.filter((n) => entry.paths.includes(n))) {
        const actual = chainsTo(lock, node);
        const expected = entry.chains.filter((c) => chainParts(c).at(-1) === node);
        const extra = actual.filter((c) => !expected.includes(c));
        const missing = expected.filter((c) => !actual.includes(c));
        if (extra.length > 0) {
          // another package depends on the vulnerable copy (a runtime dependency resolving to the same folder, say)
          result.problems.push(`${label} at ${node} is also reached through a chain the allowlist does not name: ${extra.join("; ")}`);
        }
        if (missing.length > 0) result.problems.push(`allowlist entry ${name} names a chain the lockfile no longer has: ${missing.join("; ")}; remove it`);
      }
      result.entries.add(entry);
    } else {
      if (entry) result.problems.push(`allowlist entry ${name} names a package that carries no advisory itself: list only the root packages`);
      if (parents.length === 0) return result;
    }
    for (const parent of parents) {
      const sub = cover(parent);
      if (!sub.covered) {
        if (sub.problems.length > 0 || sub.blocked) result.blocked = true;
        else result.problems.push(`${label} stands on ${parent}, which the allowlist does not cover`);
        continue;
      }
      for (const e of sub.entries) result.entries.add(e);
    }
    if (parents.length > 0 && !result.blocked && result.entries.size > 0) {
      for (const e of result.entries) {
        if (e === entry) continue;
        const onChain = (n) => e.chains.some((c) => chainParts(c).slice(0, -1).includes(n));
        const off = nodes.filter((n) => !onChain(n));
        if (off.length > 0) result.problems.push(`${label} is installed at ${off.join(", ")}, which is not on a chain the allowlist names for ${e.package}`);
      }
      const ceiling = Math.max(...[...result.entries].map((e) => RANK[e.severity]));
      if (ownIds.length === 0 && !(RANK[finding.severity] <= ceiling)) {
        result.problems.push(`${label} is more severe than the allowlist entries it stands on`);
      }
    }
    result.covered = result.problems.length === 0 && !result.blocked && result.entries.size > 0;
    return result;
  };

  const allowedAdvisories = new Map();
  const silent = [];
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const advisories = rootAdvisories(vulnerabilities, name);
    const unnamed = advisories.filter((a) => a.id === null);
    if (unnamed.length > 0) {
      failures.push(`${name}: npm audit gives an advisory without a GHSA id (${unnamed.map((a) => a.package).join(", ")}): it cannot be judged`);
      continue;
    }
    const ids = [...new Set(advisories.map((a) => a.id))];
    const label = `${name} (${finding.severity}; ${ids.join(", ") || "no advisory"})`;
    const verdict = cover(name);
    if (verdict.covered) {
      for (const a of ownAdvisories({ ...finding, name })) allowedAdvisories.set(`${a.id}:${a.package}`, a);
      continue;
    }
    if (advisories.some((a) => allowedIds.has(`${a.id}:${a.package}`)) || byPackage.has(name)) {
      // it touches what the owner allowed, but not the way he allowed it: fails whatever its severity
      if (verdict.problems.length > 0) failures.push(...verdict.problems);
      else if (verdict.blocked) silent.push(label);
      else failures.push(`not covered by the allowlist although it reaches an allowlisted advisory: ${label}`);
    } else if (FAILING.has(finding.severity)) failures.push(`not on the allowlist: ${label}`);
    else notes.push(`not on the allowlist (does not fail at this severity): ${label}`);
  }
  // a finding blocked by another is named only when no failure names the cause (it can never pass silently)
  if (failures.length === 0) for (const label of silent) failures.push(`not covered by the allowlist although it reaches an allowlisted advisory: ${label}`);
  for (const entry of usable) {
    if (!vulnerabilities[entry.package]) failures.push(`allowlist entry no longer matches any finding: ${entry.package} (${entry.advisories.join(", ")}); remove it`);
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
