import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// OPS-05, owner (436) א, 18 November 2026: "an error message our code throws contains no record value or user input, only a
// code, a uuid and a field name". An error's message goes to our logs (OPS-06) and, from the Sentry start day, to Sentry; the
// scrubbing there is the second line, this rule the first. Two scans:
// (a) TypeScript under src/: every `new <Something>Error(...)`, every call of a built-in `Error(...)` / `TypeError(...)` /
//     `RangeError(...)` without `new`, every `super(...)` of a class that extends an Error, and every `throw "..."` /
//     `throw \`...\``. Its message is a plain string, or a template / concatenation whose interpolated parts are on a closed
//     allowlist (ids, codes through errorCode(), field and table names, the label the caller passes); a database error's own
//     `.message` (it can quote a row) never is. This is a LINT-LEVEL rule: it judges by the names of what is interpolated, not
//     by data flow, so a variable named `key` that holds a typed value passes; a message assigned to `.message` afterwards, an
//     error built by a helper that is not named *Error, and a `throw` of a variable are not scanned.
// (b) SQL migrations: for each function only its LATEST definition (a later `create or replace function` wins; a function
//     renamed to `*_retired` is gone). Every `raise exception '<format>', args` whose format has a `%` placeholder: each arg is
//     an id, a code, a field name, a position or a plan number, judged by its variable name with casts and wrappers stripped,
//     and never the caller's own unknown key echoed back ("unknown ...", "not editable"). A `using message =` option is judged
//     the same way (the values of a `||` concatenation, or the arguments of `format(...)`). Every `using hint =` is one static
//     code-like string. The violations that stand in functions already applied to the hosted database are listed in
//     KNOWN_SQL_VIOLATIONS: fixing one needs a new migration (the lead's apply), and then its entry must go (a stale entry fails
//     too), so the list only shrinks.

const ROOT = join(__dirname, "..", "..");

// ------------------------------------------------------------------------------------------------- shared expression rules

/** Splits on a separator at depth 0, outside quotes and template literals. */
function splitTop(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        current += text[i + 1] ?? "";
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (depth === 0 && text.startsWith(separator, i)) {
      out.push(current.trim());
      current = "";
      i += separator.length - 1;
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

// ------------------------------------------------------------------------------------------------- (a) TypeScript

/**
 * Interpolations every file may use: an id, a code, a status, a hint or reason code, a kind, a field/table/screen key, and
 * `what` (the caller's own label of a read, e.g. "leads list"). A trailing `?? "<literal>"` is ignored.
 */
const TS_ALLOWED = /^(?:[\w$]+(?:\?\.|\.))*(?:id|[a-z]\w*Id|\w+_id|code|status|hint|reason|problem|kind|key|table|what|screen)$|^errorCode\([^()]*(?:\([^()]*\))?[^()]*\)$/;

/** A module constant in capitals (a fixed text or number of our own code). */
const CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/** Per-file additions, each with the reason its values are no record value or user input. */
const TS_FILE_ALLOWED: Record<string, { expressions: string[]; why: string }> = {
  "src/features/help/content.ts": {
    expressions: ["file", "file.path", "where", "i + 1", "match[0]", "meta.topic", "meta.screen", "help.article", "tour.length"],
    why: "the help files in docs/help/, checked when the content is generated and by a unit test, never user data",
  },
  "src/features/reports/build.ts": { expressions: ["name"], why: "the report function's name (a closed union)" },
  "src/features/reports/schemas.ts": { expressions: ["name"], why: "the report function's name (a closed union)" },
  "src/features/platform/queries.ts": { expressions: ["name"], why: "the platform function's name (a closed union)" },
  "src/features/imports/components/import-wizard.tsx": {
    expressions: ["formatNumber(table.length - 1)", "formatNumber(MAX_IMPORT_ROWS)"],
    why: "a row count and the fixed row limit, shown to the importer",
  },
};

/** Classes whose first argument is not a message. */
const NOT_A_MESSAGE = new Set(["ZodError"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** The text of the first argument of a call whose "(" ends at `start`. */
function firstArgument(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  const templateDepth: number[] = [];
  let i = start;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (quote === "`" && c === "$" && source[i + 1] === "{") {
        templateDepth.push(depth);
        depth++;
        i++;
        quote = null;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (c === "}" && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === depth - 1) {
        depth--;
        templateDepth.pop();
        quote = "`";
        continue;
      }
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return source.slice(start, i).trim();
}

/** The interpolations of a template literal (one level; a nested template inside one is judged as a whole). */
function templateParts(template: string): string[] {
  const parts: string[] = [];
  let i = 1;
  while (i < template.length - 1) {
    if (template[i] === "\\") {
      i += 2;
      continue;
    }
    if (template[i] === "$" && template[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < template.length && depth > 0; j++) {
        if (template[j] === "{") depth++;
        if (template[j] === "}") depth--;
      }
      parts.push(template.slice(i + 2, j - 1).trim());
      i = j;
      continue;
    }
    i++;
  }
  return parts;
}

const PLAIN_LITERAL = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;

/** The parts of a message expression that are not allowed (empty = fine). */
function messageProblems(expression: string, file: string): string[] {
  if (expression === "" || PLAIN_LITERAL.test(expression)) return [];
  const extra = TS_FILE_ALLOWED[file]?.expressions ?? [];
  const judge = (part: string): boolean => {
    const bare = part.replace(/\s*\?\?\s*("[^"]*"|'[^']*')$/, "").trim();
    return TS_ALLOWED.test(bare) || CONSTANT.test(bare) || extra.includes(bare) || PLAIN_LITERAL.test(bare);
  };
  if (expression.startsWith("`") && expression.endsWith("`")) return templateParts(expression).filter((p) => !judge(p));
  return splitTop(expression, "+").filter((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return templateParts(part).some((p) => !judge(p));
    return !judge(part);
  });
}

type TsFinding = { file: string; line: number; call: string; part: string };

function scanTypeScript(): TsFinding[] {
  const findings: TsFinding[] = [];
  for (const path of sourceFiles(join(ROOT, "src"))) {
    const file = relative(ROOT, path).split("\\").join("/");
    const source = readFileSync(path, "utf8");
    const calls: { index: number; call: string; open: number; text?: string }[] = [];
    for (const m of source.matchAll(/new\s+([A-Za-z_$][\w$]*Error)\s*\(/g)) {
      if (!NOT_A_MESSAGE.has(m[1])) calls.push({ index: m.index, call: `new ${m[1]}`, open: m.index + m[0].length });
    }
    for (const m of source.matchAll(/(?<![\w$.])(?<!new\s+)(Error|TypeError|RangeError|SyntaxError)\s*\(/g)) {
      calls.push({ index: m.index, call: m[1], open: m.index + m[0].length });
    }
    for (const m of source.matchAll(/\bthrow\s+(?=[`'"])/g)) {
      const start = m.index + m[0].length;
      const end = source.slice(start).search(/;|\n\s*\n/);
      calls.push({ index: m.index, call: "throw", open: -1, text: source.slice(start, end < 0 ? undefined : start + end).trim() });
    }
    if (/class\s+\w+\s+extends\s+\w*Error\b/.test(source)) {
      for (const m of source.matchAll(/\bsuper\s*\(/g)) calls.push({ index: m.index, call: "super", open: m.index + m[0].length });
    }
    for (const { index, call, open, text } of calls) {
      for (const part of messageProblems(text ?? firstArgument(source, open), file)) {
        findings.push({ file, line: source.slice(0, index).split("\n").length, call, part });
      }
    }
  }
  return findings;
}

describe("error messages hold no record value or user input: TypeScript", () => {
  it("every thrown error's message interpolates only ids, codes and field names", () => {
    expect(scanTypeScript()).toEqual([]);
  });

  it("the scan catches a database message, a value and a concatenation", () => {
    expect(messageProblems("`leads query failed: ${error.message}`", "src/x.ts")).toEqual(["error.message"]);
    expect(messageProblems("`not a colour: ${color}`", "src/x.ts")).toEqual(["color"]);
    expect(messageProblems('"no row for " + phone', "src/x.ts")).toEqual(["phone"]);
    expect(messageProblems("message", "src/x.ts")).toEqual(["message"]);
    expect(messageProblems("`read failed: ${what}: ${error.code ?? \"\"} ${row.id} ${leadId} ${lead_id}`", "src/x.ts")).toEqual([]);
    expect(messageProblems('"plain text"', "src/x.ts")).toEqual([]);
    expect(messageProblems("REPORT_SHAPE_MESSAGE", "src/x.ts")).toEqual([]);
    expect(messageProblems("`leads query failed: ${errorCode(error)}`", "src/x.ts")).toEqual([]);
    expect(messageProblems("`failed: ${errorCode(pipelines.error ?? stages.error)}`", "src/x.ts")).toEqual([]);
    expect(messageProblems("`${name} failed`", "src/features/reports/build.ts")).toEqual([]);
    expect(messageProblems("`${name} failed`", "src/x.ts")).toEqual(["name"]);
  });
});

// ------------------------------------------------------------------------------------------------- (b) SQL

type FunctionDef = { name: string; key: string; body: string; migration: string };

function argumentCount(list: string): number {
  return splitTop(list, ",").filter((a) => a !== "").length;
}

/** The latest body of every function, keyed by name and argument count; a function renamed away is dropped. */
function latestFunctions(): Map<string, FunctionDef> {
  const dir = join(ROOT, "supabase", "migrations");
  const latest = new Map<string, FunctionDef>();
  for (const migration of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const source = readFileSync(join(dir, migration), "utf8");
    const events: ({ at: number } & ({ kind: "create"; def: FunctionDef } | { kind: "rename"; name: string }))[] = [];
    const create = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]\w*\.)?("?[a-z_]\w*"?)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(source))) {
      const name = `${(m[1] ?? "public.").toLowerCase()}${m[2].replace(/"/g, "").toLowerCase()}`;
      let i = m.index + m[0].length;
      let depth = 1;
      const start = i;
      while (depth > 0 && i < source.length) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") depth--;
        i++;
      }
      const tag = /\$([a-z_0-9]*)\$/i.exec(source.slice(i));
      if (!tag) continue;
      const bodyStart = i + tag.index + tag[0].length;
      const end = source.indexOf(tag[0], bodyStart);
      if (end < 0) continue;
      const key = `${name}/${argumentCount(source.slice(start, i - 1))}`;
      events.push({ at: m.index, kind: "create", def: { name, key, body: source.slice(bodyStart, end), migration } });
      create.lastIndex = end + tag[0].length;
    }
    for (const r of source.matchAll(/alter\s+function\s+([a-z_]\w*\.)?([a-z_]\w*)\s*\([^;]*?rename\s+to/gi)) {
      events.push({ at: r.index, kind: "rename", name: `${(r[1] ?? "public.").toLowerCase()}${r[2].toLowerCase()}` });
    }
    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.kind === "create") latest.set(event.def.key, event.def);
      else for (const key of [...latest.keys()]) if (key.startsWith(`${event.name}/`)) latest.delete(key);
    }
  }
  return latest;
}

/** The RAISE statements of a body (comments blanked), each as one line. */
function raiseStatements(body: string): string[] {
  const text = body.replace(/--[^\n]*/g, (s) => " ".repeat(s.length));
  const out: string[] = [];
  for (const m of text.matchAll(/\braise\b/gi)) {
    let j = m.index;
    let quoted = false;
    let depth = 0;
    for (; j < text.length; j++) {
      const c = text[j];
      if (quoted) {
        if (c === "'") {
          if (text[j + 1] === "'") j++;
          else quoted = false;
        }
        continue;
      }
      if (c === "'") quoted = true;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth <= 0) break;
    }
    out.push(text.slice(m.index, j).replace(/\s+/g, " ").trim());
  }
  return out;
}

/** SQL's own split: single quotes with '' inside. */
function splitSql(text: string, separator = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    current += c;
    if (quoted) {
      if (c === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i++;
        } else quoted = false;
      }
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && text.startsWith(separator, i)) {
      out.push(current.slice(0, -1).trim());
      current = "";
      i += separator.length - 1;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

type Raise = { format: string | null; args: string[]; hint: string | null; message: string | null };

/** An EXCEPTION-level raise (`raise exception ...` or a bare `raise '...'`); null for notices, warnings and a re-raise. */
function parseRaise(statement: string): Raise | null {
  let rest = statement.replace(/^raise\s*/i, "");
  const level = /^(exception|notice|warning|info|log|debug)\b/i.exec(rest);
  if (level && level[1].toLowerCase() !== "exception") return null;
  if (level) rest = rest.slice(level[0].length).trim();
  if (rest === "") return null;
  let usingAt = -1;
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quoted) {
      if (c === "'") {
        if (rest[i + 1] === "'") i++;
        else quoted = false;
      }
      continue;
    }
    if (c === "'") quoted = true;
    else if (/\s/.test(rest[i - 1] ?? " ") && /^using\b/i.test(rest.slice(i))) {
      usingAt = i;
      break;
    }
  }
  const head = (usingAt < 0 ? rest : rest.slice(0, usingAt)).trim();
  const options = usingAt < 0 ? [] : splitSql(rest.slice(usingAt + 5));
  let hint: string | null = null;
  let message: string | null = null;
  for (const option of options) {
    const h = /^hint\s*=\s*([\s\S]*)$/i.exec(option);
    if (h) hint = h[1].trim();
    const m = /^message\s*=\s*([\s\S]*)$/i.exec(option);
    if (m) message = m[1].trim();
  }
  if (!head.startsWith("'")) return { format: null, args: [], hint, message };
  const [format, ...args] = splitSql(head);
  return { format, args, hint, message };
}

/**
 * A format argument that is no record value: with casts and coalesce/left/substr stripped, a variable named as an id, a key
 * (a field name), a code, a type or kind, a column or table name, a position, or a plan number (limit, max, cap, seats, GB).
 */
const SQL_ALLOWED_ARG = /^(?:[a-z_]\w*\.)*(?:(?:[a-z]+_)*(?:id|key|code|type|kind|col|index|limit|max|cap|seats|gb|users)|tg_table_name)$/;
/** A format that echoes the caller's own key back: what it names was not found on any known list, so it is the caller's input. */
const ECHOES_CALLER = /\bunknown\b|not editable/i;
/** A static, code-like hint ('limit:max_users', 'quote:frozen'). */
const HINT_CODE = /^'[a-z][a-z0-9_]*(?::[a-z0-9_.-]+)*'$/i;

function bareSqlArg(arg: string): string {
  let a = arg.trim().replace(/::[\w ]+(\[\])?$/i, "");
  for (;;) {
    const wrapped = /^(?:coalesce|left|substr|substring)\((.*)\)$/i.exec(a);
    if (!wrapped) break;
    a = splitSql(wrapped[1])[0].trim();
  }
  return a.toLowerCase();
}

/**
 * A `using message =` value as a format and its arguments: `format('...', a, b)` gives its format and arguments; a `||`
 * concatenation gives its literal parts joined as the text and every other part as an argument; a literal alone has none.
 */
function messageOption(expression: string): { text: string; args: string[] } {
  const formatCall = /^format\s*\(([\s\S]*)\)$/i.exec(expression);
  if (formatCall) {
    const [text, ...args] = splitSql(formatCall[1]);
    return { text, args };
  }
  const parts = splitSql(expression, "||");
  return { text: parts.filter((p) => p.startsWith("'")).join(" "), args: parts.filter((p) => !p.startsWith("'")) };
}

type SqlFinding = { fn: string; migration: string; raise: string; problem: "value" | "echo" | "hint" };

function scanSql(): SqlFinding[] {
  const findings: SqlFinding[] = [];
  for (const def of latestFunctions().values()) {
    for (const statement of raiseStatements(def.body)) {
      const raise = parseRaise(statement);
      if (!raise) continue;
      const label = raise.format ?? statement.slice(0, 80);
      if (raise.format && /%(?!%)/.test(raise.format.replace(/%%/g, ""))) {
        for (const arg of raise.args) {
          if (!SQL_ALLOWED_ARG.test(bareSqlArg(arg))) findings.push({ fn: def.name, migration: def.migration, raise: label, problem: "value" });
          else if (ECHOES_CALLER.test(raise.format)) findings.push({ fn: def.name, migration: def.migration, raise: label, problem: "echo" });
        }
      }
      if (raise.message !== null) {
        const option = messageOption(raise.message);
        const optionLabel = `${label} message = ${raise.message}`;
        for (const arg of option.args) {
          if (!SQL_ALLOWED_ARG.test(bareSqlArg(arg))) findings.push({ fn: def.name, migration: def.migration, raise: optionLabel, problem: "value" });
          else if (ECHOES_CALLER.test(option.text)) findings.push({ fn: def.name, migration: def.migration, raise: optionLabel, problem: "echo" });
        }
      }
      if (raise.hint !== null && !HINT_CODE.test(raise.hint)) {
        findings.push({ fn: def.name, migration: def.migration, raise: `${label} hint = ${raise.hint}`, problem: "hint" });
      }
    }
  }
  return findings.sort((a, b) => `${a.fn} ${a.raise}`.localeCompare(`${b.fn} ${b.raise}`));
}

/**
 * Violations standing in functions already applied to the hosted database (18 November 2026). Each needs a new migration to
 * fix (the lead's decision); when one is fixed, its entry is removed here. A new violation is never added to this list.
 */
const KNOWN_SQL_VIOLATIONS: SqlFinding[] = [
  // a record value: the document's date
  {
    fn: "app.document_vat_rate",
    migration: "20261006013700_vat_rates.sql",
    raise: "'no VAT rate for a document dated %'",
    problem: "value",
  },
  // the caller's own unknown keys echoed back (a custom-field key the client sent that no definition has)
  {
    fn: "app.check_custom_fields",
    migration: "20261006020905_field_types_part_b.sql",
    raise: "'unknown custom field %'",
    problem: "echo",
  },
  {
    fn: "app.custom_fields_defined_recheck",
    migration: "20261006021194_custom_field_delete.sql",
    raise: "'unknown custom field %'",
    problem: "echo",
  },
  // a utm key from the client's $merge patch
  {
    fn: "app.merge_lead_utm",
    migration: "20261006011500_lead_campaign_fields.sql",
    raise: "'utm patch key % is not editable'",
    problem: "echo",
  },
  // the public prefill form: a field key the visitor posted
  {
    fn: "public.prefill_public_submit",
    migration: "20261006021298_prefill_link_review_1117.sql",
    raise: "'unknown field: %'",
    problem: "echo",
  },
  // the record type the caller passed to the RPC
  {
    fn: "public.record_summary",
    migration: "20261006006900_meeting_contact.sql",
    raise: "'record_summary: unknown type %'",
    problem: "echo",
  },
  // an action type stored in a rule's JSON that the engine does not know
  {
    fn: "app.run_automation_actions",
    migration: "20261006021224_automation_send_email.sql",
    raise: "'unknown action %'",
    problem: "echo",
  },
  // hints built at run time from codes (no value of a record, but not one static string)
  {
    fn: "app.enforce_count_limit",
    migration: "20261006020445_quota_outsider_guard.sql",
    raise: "'plan limit reached (% = %)' hint = 'limit:' || v_key",
    problem: "hint",
  },
  {
    fn: "app.payment_links_check",
    migration: "20261006021316_payment_link_webhook.sql",
    raise: "'the source''s module is not in the plan' hint = 'feature:' || v_key",
    problem: "hint",
  },
  {
    fn: "app.record_sms_enqueue",
    migration: "20261006021279_card_email_fields.sql",
    raise: "'feature not in plan' hint = v_refusal",
    problem: "hint",
  },
  {
    fn: "public.log_list_export",
    migration: "20261006020690_money_list_tables.sql",
    raise: "'this list is not in the plan' hint = 'feature:' || v_feature",
    problem: "hint",
  },
];

describe("error messages hold no record value or user input: SQL (latest definitions)", () => {
  it("finds the functions' latest bodies", () => {
    const latest = [...latestFunctions().values()];
    expect(latest.length).toBeGreaterThan(1000);
    // intake_submit was defined many times; its last body is 021093's (CLAUDE.md)
    expect(latest.filter((d) => d.name === "public.intake_submit").map((d) => d.migration)).toEqual([
      expect.stringMatching(/^20261006021093_/),
    ]);
    // a function renamed to *_retired is gone from its old name (set_notification_settings with two arguments, 021276)
    expect(latest.some((d) => d.key === "public.set_notification_settings/2")).toBe(false);
  });

  it("raises only ids, codes and field names, and only static code-like hints, apart from the known list", () => {
    const sortKey = (f: SqlFinding) => `${f.fn} ${f.raise} ${f.problem}`;
    const unique = (list: SqlFinding[]) => [...new Map(list.map((f) => [sortKey(f), f])).values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    expect(unique(scanSql())).toEqual(unique(KNOWN_SQL_VIOLATIONS));
  });

  it("the SQL rules judge arguments and hints", () => {
    expect(parseRaise("raise exception 'plan limit reached (%)', v_limit using errcode = 'P0001', hint = 'limit:max_users'")).toEqual({
      format: "'plan limit reached (%)'",
      args: ["v_limit"],
      hint: "'limit:max_users'",
      message: null,
    });
    expect(parseRaise("raise notice 'x %', v_name")).toBeNull();
    expect(parseRaise("raise exception using message = 'no row for ' || v_phone, hint = 'x:y'")).toMatchObject({
      format: null,
      message: "'no row for ' || v_phone",
    });
    expect(messageOption("'no row for ' || v_phone || ' today'")).toEqual({ text: "'no row for ' ' today'", args: ["v_phone"] });
    expect(messageOption("format('unknown field %s', v_key)")).toEqual({ text: "'unknown field %s'", args: ["v_key"] });
    expect(messageOption("'plain'")).toEqual({ text: "'plain'", args: [] });
    expect(parseRaise("raise")).toBeNull();
    expect(SQL_ALLOWED_ARG.test(bareSqlArg("v_lead_id::text"))).toBe(true);
    expect(SQL_ALLOWED_ARG.test(bareSqlArg("substr(v_key, 4)"))).toBe(true);
    expect(SQL_ALLOWED_ARG.test(bareSqlArg("new.field_type"))).toBe(true);
    expect(SQL_ALLOWED_ARG.test(bareSqlArg("v_phone"))).toBe(false);
    expect(SQL_ALLOWED_ARG.test(bareSqlArg("new.full_name"))).toBe(false);
    expect(SQL_ALLOWED_ARG.test(bareSqlArg("p_date"))).toBe(false);
    expect(HINT_CODE.test("'quote:frozen'")).toBe(true);
    expect(HINT_CODE.test("'limit:' || v_key")).toBe(false);
  });
});
