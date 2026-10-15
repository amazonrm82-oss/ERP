import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ISRAEL } from "@/features/companies/countries";
import { companySchema } from "@/features/companies/schema";
import { companyTaxId, foreignCompanyNumber } from "@/features/companies/tax-id";
import { parseCustomFields } from "@/features/custom-fields/values";
import { inputName, type FieldDefinition } from "@/features/custom-fields/types";
import type { Database, Json } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { normalizePhone } from "@/lib/phone";
import { israeliIdNumber } from "@/lib/israeli-id";
import { optionalDate, optionalEmail, optionalPhone, optionalText } from "@/lib/validation";
import { readAllPagesByIds } from "@/lib/paged-read";
import { RECORD_TYPES } from "@/lib/record-types";

import { customCellValue } from "./record-cells";
import { COUNTRY_UNKNOWN, foreignNumberKey, importCountry } from "./country";
import { CUSTOM_PREFIX, type DuplicateModeKey, type RecordImportEntity as ImportEntityKey } from "./fields";

type Client = SupabaseClient<Database>;

// warning: the row is imported, but something in it was not kept (shown in the preview and the summary)
export type RowOutcome = { row: number; status: "created" | "updated" | "skipped" | "failed" | "ok"; message?: string; warning?: string };

export type ImportContext = {
  supabase: Client;
  orgId: string;
  userId: string;
  entity: ImportEntityKey;
  mode: DuplicateModeKey;
  // per column: target key, "" = not imported
  mapping: string[];
  definitions: FieldDefinition[];
};

type Lookups = {
  statuses: Map<string, string>;
  defaultStatus: string | null;
  sources: Map<string, string>;
  owners: Map<string, string>;
  // leads: the ids of the "not relevant" statuses and the names of the active reasons (RVW-9)
  disqualified?: Set<string>;
  reasons?: Set<string>;
};

/** The reason a file gave is not on the list: the row is imported without it (RVW-9). */
// REC-03: the request header that marks an import's update (app.import_write_running reads it)
export const IMPORT_HEADER = "x-crm-import";

export const REASON_NOT_ON_LIST = (reason: string) => `הסיבה "${reason}" לא ברשימת הסיבות ולא נשמרה. השורה יובאה בלעדיה.`;
export const REASON_NEEDED_TO_DISQUALIFY = 'כדי להעביר ליד קיים ל"לא רלוונטי" צריך סיבה מרשימת הסיבות.';
export const REASON_LIST_EMPTY = 'כדי להעביר ליד קיים ל"לא רלוונטי" צריך סיבה, אבל רשימת הסיבות ריקה. אפשר להוסיף סיבות בהגדרות, בעמוד "סיבות לליד לא רלוונטי".';
export const NO_PERMISSION_TO_UPDATE = "אין הרשאה לעדכן את הרשומה הקיימת.";
export const REASONS_UNREADABLE = "לא הצלחנו לקרוא את רשימת הסיבות ללידים לא רלוונטיים. נסו שוב.";

const key = (text: string) => text.trim().toLowerCase();

/** A phone typed into Excel as a number loses its leading 0 (0521234567 -> 521234567). */
export function restorePhone(value: string): string {
  const digits = value.trim();
  if (/^5\d{8}$/.test(digits) || /^[23489]\d{7}$/.test(digits) || /^7\d{8}$/.test(digits)) {
    return `0${digits}`;
  }
  return value;
}

/** "31/12/1980", "31.12.1980" or "1980-12-31" -> "1980-12-31"; anything else is returned as is (and fails validation). */
export function normalizeDate(value: string): string {
  // a time after the day is dropped (an Excel date cell with a time of day, IMP-03 cellText)
  const v = value.trim().replace(/(?:[T\s]+)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/, "");
  const dmy = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return v;
}

async function loadLookups(ctx: ImportContext): Promise<Lookups> {
  const { supabase, orgId } = ctx;
  const [statuses, sources, reasons, members] = await Promise.all([
    ctx.entity === "lead" ? supabase.from("lead_statuses").select("id, name, is_default, kind").eq("organization_id", orgId) : Promise.resolve({ data: [] }),
    ctx.entity === "lead" ? supabase.from("lead_sources").select("id, name").eq("organization_id", orgId) : Promise.resolve({ data: [] }),
    ctx.entity === "lead" ? supabase.from("disqualify_reasons").select("name").eq("organization_id", orgId).eq("is_active", true) : Promise.resolve({ data: [], error: null }),
    supabase.from("memberships").select("user_id").eq("organization_id", orgId).eq("status", "active").neq("role", "viewer"),
  ]);
  const ids = (members.data ?? []).map((m) => m.user_id);
  const { data: profiles } = ids.length ? await supabase.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
  const owners = new Map<string, string>();
  for (const p of profiles ?? []) {
    if (p.email) owners.set(key(p.email), p.id);
    if (p.full_name) owners.set(key(p.full_name), p.id);
  }
  // without the list every reason would be dropped as "not on the list": stop rather than guess (FXC-02)
  if (reasons.error) throw new ImportStopped(REASONS_UNREADABLE);
  const statusRows = (statuses.data ?? []) as Array<{ id: string; name: string; is_default?: boolean; kind?: string }>;
  return {
    disqualified: new Set(statusRows.filter((s) => s.kind === "disqualified").map((s) => s.id)),
    reasons: new Set(((reasons.data ?? []) as Array<{ name: string }>).map((r) => r.name)),
    statuses: new Map(statusRows.map((s) => [key(s.name), s.id])),
    defaultStatus: statusRows.find((s) => s.is_default)?.id ?? statusRows[0]?.id ?? null,
    sources: new Map(((sources.data ?? []) as Array<{ id: string; name: string }>).map((s) => [key(s.name), s.id])),
    owners,
  };
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "השורה אינה תקינה.";
}

const leadRowSchema = z
  .object({
    full_name: optionalText(200, "השם ארוך מדי (עד 200 תווים)."),
    phone: optionalPhone,
    email: optionalEmail,
    company_name: optionalText(200, "שם החברה ארוך מדי (עד 200 תווים)."),
    job_title: optionalText(120, "התפקיד ארוך מדי (עד 120 תווים)."),
    campaign: optionalText(200, "שם הקמפיין ארוך מדי."),
    message: optionalText(5000, "ההודעה ארוכה מדי (עד 5,000 תווים)."),
  })
  .refine((l) => Boolean(l.full_name || l.phone || l.email), { error: "חסר שם, טלפון או אימייל." });

const contactRowSchema = z
  .object({
    first_name: optionalText(100, "השם ארוך מדי (עד 100 תווים)."),
    last_name: optionalText(100, "שם המשפחה ארוך מדי (עד 100 תווים)."),
    phone: optionalPhone,
    email: optionalEmail,
    job_title: optionalText(120, "התפקיד ארוך מדי (עד 120 תווים)."),
    birth_date: optionalDate,
  })
  .refine((c) => Boolean(c.first_name || c.last_name || c.phone || c.email), { error: "חסר שם, טלפון או אימייל." });

type Prepared = {
  row: number;
  // the columns to write (insert or update)
  values: Record<string, unknown>;
  // for duplicate detection
  phoneE164: string | null;
  email: string | null;
  // companies: the values the number may be stored as, and its foreign match keys
  // ("GB:AB1234", or "*:AB1234" without a country), for duplicate detection
  taxIds: string[];
  taxKeys: string[];
  // companies: the country the file gave, or null (a number then matches in any country)
  country: string | null;
  name: string | null;
  companyName: string | null;
  // companies with a number but no country in the file: checked once the country is
  // known (an existing company's own, otherwise Israel)
  pendingTaxId: string | null;
  // something in the row that is not kept (the row is still imported)
  warning: string | null;
};

/** Validates one row and turns it into column values. Returns a message when the row cannot be imported. */
function prepareRow(ctx: ImportContext, lookups: Lookups, cells: string[], row: number): Prepared | string {
  const raw: Record<string, string> = {};
  const custom = new FormData();
  ctx.mapping.forEach((target, index) => {
    if (!target) return;
    const value = String(cells[index] ?? "").trim();
    if (target.startsWith(CUSTOM_PREFIX)) {
      const fieldKey = target.slice(CUSTOM_PREFIX.length);
      custom.set(inputName(fieldKey), customCellValue(ctx.definitions.find((d) => d.key === fieldKey)?.type, value));
    } else if (value !== "") {
      raw[target] = target === "phone" ? restorePhone(value) : value;
    }
  });

  const values: Record<string, unknown> = {};
  let name: string | null = null;
  let companyName: string | null = null;
  let taxIds: string[] = [];
  let taxKeys: string[] = [];
  let pendingTaxId: string | null = null;
  let warning: string | null = null;

  if (ctx.entity === "lead") {
    const parsed = leadRowSchema.safeParse({
      full_name: raw.full_name ?? [raw.first_name, raw.last_name].filter(Boolean).join(" "),
      phone: raw.phone,
      email: raw.email,
      company_name: raw.company_name,
      job_title: raw.job_title,
      campaign: raw.campaign,
      message: raw.message,
    });
    if (!parsed.success) return firstIssue(parsed.error);
    Object.assign(values, parsed.data);
    if (raw.status) {
      const status = lookups.statuses.get(key(raw.status));
      if (!status) return `אין סטטוס בשם "${raw.status}".`;
      values.status_id = status;
    }
    if (raw.source) {
      const source = lookups.sources.get(key(raw.source));
      if (!source) return `אין מקור בשם "${raw.source}". אפשר להוסיף אותו בהגדרות ולייבא שוב.`;
      values.source_id = source;
    }
    // RVW-9: an optional reason. Kept when it is a name on the active list (after trimming);
    // any other reason is dropped with a warning and the row is imported. A status that is
    // not "not relevant" takes no reason, so there is nothing to keep or warn about.
    const statusTakesReason = values.status_id === undefined || Boolean(lookups.disqualified?.has(values.status_id as string));
    if (raw.disqualify_reason && statusTakesReason) {
      if (lookups.reasons?.has(raw.disqualify_reason)) values.disqualify_reason = raw.disqualify_reason;
      else warning = REASON_NOT_ON_LIST(raw.disqualify_reason);
    }
    name = parsed.data.full_name;
  } else if (ctx.entity === "contact") {
    let first: string | undefined = raw.first_name;
    let last: string | undefined = raw.last_name;
    if (!first && !last && raw.full_name) {
      const [head, ...rest] = raw.full_name.split(/\s+/);
      first = head;
      last = rest.join(" ") || undefined;
    }
    const parsed = contactRowSchema.safeParse({
      first_name: first,
      last_name: last,
      phone: raw.phone,
      email: raw.email,
      job_title: raw.job_title,
      birth_date: raw.birth_date ? normalizeDate(raw.birth_date) : undefined,
    });
    if (!parsed.success) return firstIssue(parsed.error);
    Object.assign(values, parsed.data);
    companyName = raw.company ?? null;
    if (companyName && companyName.length > 200) return "שם החברה ארוך מדי (עד 200 תווים).";
    name = [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" ") || null;
  } else {
    // CON-04: the number is checked by the company's country. A row with a country
    // checks it now; a row without one waits until the import knows whether it
    // updates an existing company (its stored country) or creates one (Israel).
    const country = raw.country ? importCountry(raw.country) : null;
    if (raw.country && !country) return COUNTRY_UNKNOWN(raw.country);
    const parsed = companySchema.safeParse({
      name: raw.name,
      country: country ?? ISRAEL,
      tax_id: country ? raw.tax_id : undefined,
      industry: "",
      phone: raw.phone,
      email: raw.email,
      website: raw.website,
      city: raw.city,
      address_line: raw.address_line,
    });
    if (!parsed.success) return firstIssue(parsed.error);
    const { industry: _industry, country: _country, tax_id: taxId, ...rest } = parsed.data;
    void _industry;
    void _country;
    Object.assign(values, rest);
    if (country) {
      // only a filled cell writes the country; an empty one keeps an existing company's
      values.country = country;
      values.tax_id = taxId;
      if (taxId) taxIds = [taxId];
      if (taxId && country !== ISRAEL) taxKeys = [`${country}:${foreignNumberKey(taxId)}`];
    } else if (raw.tax_id) {
      pendingTaxId = raw.tax_id;
      const foreign = foreignCompanyNumber(raw.tax_id);
      taxIds = present([israeliIdNumber(raw.tax_id), foreign]);
      if (foreign) taxKeys = [`*:${foreignNumberKey(foreign)}`];
    }
    name = parsed.data.name;
  }

  if (raw.owner) {
    const owner = lookups.owners.get(key(raw.owner));
    if (!owner) return `לא נמצא משתמש פעיל "${raw.owner}" (לפי אימייל או שם).`;
    values.owner_id = owner;
  }

  const mappedFields = ctx.definitions.filter((d) => ctx.mapping.includes(`${CUSTOM_PREFIX}${d.key}`));
  if (mappedFields.length > 0) {
    const { values: customValues, errors } = parseCustomFields(
      mappedFields.map((d) => ({ ...d, isRequired: false })),
      custom,
    );
    const error = Object.values(errors)[0];
    if (error) return error;
    values.custom_fields = customValues as Json;
  }

  return {
    row,
    values,
    phoneE164: normalizePhone(values.phone as string | null),
    email: (values.email as string | null) ?? null,
    taxIds,
    taxKeys,
    country: ctx.entity === "company" && typeof values.country === "string" ? values.country : null,
    name,
    companyName,
    pendingTaxId,
    warning,
  };
}


// viaChannel: a contact found by a further phone or email (CON-01), whose primary ones an update keeps
type Existing = { id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null; viaChannel?: boolean };

/** A lookup that failed: the chunk fails as a whole rather than guessing (FXC-02). */
class LookupFailed extends Error {}

const present = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

/** Records already in the organization (that the user can see) matching any row of the chunk; one query in the database. */
async function findExisting(ctx: ImportContext, entity: ImportEntityKey, rows: Array<Pick<Prepared, "phoneE164" | "email" | "taxIds" | "taxKeys" | "name">>): Promise<Existing[]> {
  if (rows.length === 0) return [];
  const { data, error } = await ctx.supabase.rpc("import_find_duplicates", {
    p_org: ctx.orgId,
    p_entity: entity,
    p_phones: present(rows.map((r) => r.phoneE164)),
    p_emails: present(rows.map((r) => r.email)),
    p_tax_ids: entity === "company" ? present(rows.flatMap((r) => [...r.taxIds, ...r.taxKeys])) : [],
    p_names: entity === "company" ? present(rows.map((r) => r.name)) : [],
  });
  if (error) throw new LookupFailed(error.message);
  if (entity !== "contact") return data;
  // CON-01: a contact's further phones and emails count too
  const { data: channels, error: channelError } = await ctx.supabase.rpc("contact_channel_matches", {
    p_org: ctx.orgId,
    p_phones: present(rows.map((r) => r.phoneE164)),
    p_emails: present(rows.map((r) => r.email)),
  });
  if (channelError) throw new LookupFailed(channelError.message);
  const extra: Existing[] = channels.map((c) => ({
    id: c.contact_id,
    phone_e164: c.kind === "phone" ? c.value : null,
    email: c.kind === "email" ? c.value : null,
    tax_id: null,
    name: null,
    viaChannel: true,
  }));
  return [...data, ...extra];
}

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * How a row's number matches a company: "equal" (the stored value), "key" (outside Israel,
 * without case, spaces, '-', '.' and '/'), or null. A row with a country matches only
 * companies of that country: an import never moves a company to another country because
 * of a number (lead's decision); that stays a manual edit.
 */
function taxMatch(row: Prepared, e: Existing, country: string | undefined): "equal" | "key" | null {
  if (e.tax_id === null || !country) return null;
  if (row.country && row.country !== country) return null;
  if (row.taxIds.includes(e.tax_id)) return "equal";
  if (country === ISRAEL) return null;
  const k = foreignNumberKey(e.tax_id);
  return row.taxKeys.includes(`${country}:${k}`) || row.taxKeys.includes(`*:${k}`) ? "key" : null;
}

export const TAX_ID_AMBIGUOUS_COUNTRIES = "המספר מתאים לכמה חברות במדינות שונות. הוסיפו עמודת מדינה לקובץ.";
export const TAX_ID_AMBIGUOUS = "המספר מתאים לכמה חברות קיימות. עדכנו אותן ידנית.";

/** The message when a row's number matches more than one company: the import never picks one. */
function ambiguousTaxId(existing: Existing[], row: Prepared, countries: Map<string, string>): string | null {
  const hits = existing.filter((e) => taxMatch(row, e, countries.get(e.id)) !== null);
  if (new Set(hits.map((e) => e.id)).size < 2) return null;
  return new Set(hits.map((e) => countries.get(e.id))).size > 1 ? TAX_ID_AMBIGUOUS_COUNTRIES : TAX_ID_AMBIGUOUS;
}

function matchExisting(entity: ImportEntityKey, existing: Existing[], row: Prepared, countries: Map<string, string>): Existing | undefined {
  return existing.find(
    (e) =>
      (row.phoneE164 && e.phone_e164 === row.phoneE164) ||
      same(row.email, e.email) ||
      (entity === "company" && (taxMatch(row, e, countries.get(e.id)) !== null || same(row.name, e.name))),
  );
}

/** Company ids by name for contacts. Missing companies are created, tagged with the import, so undoing it removes them. */
async function resolveCompanies(ctx: ImportContext, rows: Prepared[], jobId: string): Promise<Map<string, string>> {
  const names = present(rows.map((r) => r.companyName));
  const ids = new Map<string, string>();
  if (names.length === 0) return ids;
  const found = await findExisting(
    ctx,
    "company",
    names.map((name) => ({ phoneE164: null, email: null, taxIds: [], taxKeys: [], name })),
  );
  for (const c of found) if (c.name && names.some((n) => same(n, c.name))) ids.set(key(c.name), c.id);
  const missing = names.filter((n) => !ids.has(key(n)));
  if (missing.length) {
    const { data: created, error } = await ctx.supabase
      .from("companies")
      .insert(missing.map((n) => ({ organization_id: ctx.orgId, name: n, import_job_id: jobId })))
      .select("id, name");
    if (error?.code === "P0001") throw new ImportStopped(dbErrorMessage(error, "הגעתם למגבלת החבילה."));
    if (error) throw new LookupFailed(error.message);
    for (const c of created) ids.set(key(c.name), c.id);
  }
  return ids;
}

export class ImportStopped extends Error {}

/**
 * Validates and writes one chunk. With jobId null it is a dry run (the preview):
 * nothing is written and valid rows come back as "ok", or "skipped"/"updated"
 * when they match an existing record.
 */
export async function processChunk(ctx: ImportContext, lookups: Lookups | null, chunk: string[][], firstRow: number, jobId: string | null): Promise<RowOutcome[]> {
  const look = lookups ?? (await loadLookups(ctx));
  const outcomes: RowOutcome[] = [];
  const prepared: Prepared[] = [];
  chunk.forEach((cells, i) => {
    const result = prepareRow(ctx, look, cells, firstRow + i);
    if (typeof result === "string") outcomes.push({ row: firstRow + i, status: "failed", message: result });
    else prepared.push(result);
  });

  try {
    return await writeChunk(ctx, look, prepared, outcomes, jobId);
  } catch (error) {
    if (!(error instanceof LookupFailed)) throw error;
    // rows already updated keep their outcome; the rest of the chunk was not written
    const done = new Set(outcomes.map((o) => o.row));
    for (const row of prepared) {
      if (!done.has(row.row)) outcomes.push({ row: row.row, status: "failed", message: "בדיקת הכפילויות נכשלה. נסו לייבא את השורה שוב." });
    }
    return outcomes.sort((a, b) => a.row - b.row);
  }
}

/** The stored country of each matched company, read with the user's session (CON-04). */
async function companyCountries(ctx: ImportContext, existing: Existing[]): Promise<Map<string, string>> {
  const countries = new Map<string, string>();
  const ids = present(existing.map((e) => e.id));
  if (ctx.entity !== "company" || ids.length === 0) return countries;
  const { data, error } = await ctx.supabase.from("companies").select("id, country").eq("organization_id", ctx.orgId).in("id", ids);
  if (error) throw new LookupFailed(error.message);
  for (const c of data) countries.set(c.id, c.country);
  return countries;
}

/** The current status of each matched lead, read with the user's session; only when a row could move one into "not relevant". */
async function leadStatuses(ctx: ImportContext, look: Lookups, existing: Existing[], prepared: Prepared[]): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  const ids = present(existing.map((e) => e.id));
  if (ctx.entity !== "lead" || ctx.mode !== "update" || ids.length === 0 || !prepared.some((row) => needsReasonCheck(look, row))) return statuses;
  // paged with a stable order: a read returns at most 1,000 rows (RVW-2)
  const rows = await readAllPagesByIds(ids, async (slice, from, to) => {
    const { data, error } = await ctx.supabase
      .from("leads")
      .select("id, status_id")
      .eq("organization_id", ctx.orgId)
      .in("id", slice)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new LookupFailed(error.message);
    return data;
  });
  for (const l of rows) statuses.set(l.id, l.status_id);
  return statuses;
}

/** A lead row in a "not relevant" status without a reason that is kept. */
function needsReasonCheck(look: Lookups, row: Prepared): boolean {
  return typeof row.values.status_id === "string" && Boolean(look.disqualified?.has(row.values.status_id)) && !row.values.disqualify_reason;
}

export const FOREIGN_HINT = "לחברה מחוץ לישראל הוסיפו עמודת מדינה.";

/** Checks a number that waited for its company's country; sets it on the row, or returns the message. */
function settleTaxId(row: Prepared, country: string): string | null {
  if (row.pendingTaxId === null) return null;
  const taxId = companyTaxId(row.pendingTaxId, country);
  if (!taxId.ok) {
    // a file of foreign companies without a country column: say what to add
    return country === ISRAEL && foreignCompanyNumber(row.pendingTaxId) ? `${taxId.message} ${FOREIGN_HINT}` : taxId.message;
  }
  row.values.tax_id = taxId.value;
  return null;
}

const withWarning = (row: Prepared, status: "created" | "updated" | "ok"): RowOutcome =>
  row.warning ? { row: row.row, status, warning: row.warning } : { row: row.row, status };

async function writeChunk(ctx: ImportContext, look: Lookups, prepared: Prepared[], outcomes: RowOutcome[], jobId: string | null): Promise<RowOutcome[]> {
  const existing = ctx.mode === "create" ? [] : await findExisting(ctx, ctx.entity, prepared);
  const countries = await companyCountries(ctx, existing);
  const currentStatus = await leadStatuses(ctx, look, existing, prepared);
  const toInsert: Prepared[] = [];
  const seen: Prepared[] = [];
  for (const row of prepared) {
    // a repeat of an earlier row in the same chunk counts as a duplicate too
    const earlier = ctx.mode === "create" ? undefined : seen.find((s) => (row.phoneE164 && s.phoneE164 === row.phoneE164) || same(row.email, s.email));
    seen.push(row);
    const match = matchExisting(ctx.entity, existing, row, countries);
    if (earlier || (match && ctx.mode === "skip")) {
      outcomes.push({ row: row.row, status: "skipped", message: "כבר קיים" });
    } else if (match && ctx.mode === "update") {
      const ambiguous = ctx.entity === "company" ? ambiguousTaxId(existing, row, countries) : null;
      if (ambiguous) {
        outcomes.push({ row: row.row, status: "failed", message: ambiguous });
        continue;
      }
      // an update keeps the company's country, so its number is checked against that one
      const matchCountry = countries.get(match.id) ?? ISRAEL;
      const taxError = settleTaxId(row, matchCountry);
      if (taxError) {
        outcomes.push({ row: row.row, status: "failed", message: taxError });
        continue;
      }
      // the same number spelled differently: the company keeps its stored spelling
      if (ctx.entity === "company" && taxMatch(row, match, matchCountry) === "key") delete row.values.tax_id;
      // RVW-9: an update is a change like a person's (it carries no import job), so moving an
      // existing lead into "not relevant" needs a reason from the list; said before writing
      if (ctx.entity === "lead" && needsReasonCheck(look, row)) {
        const current = currentStatus.get(match.id);
        if (!current) {
          // found as a duplicate but not readable now (deleted meanwhile, or no rights)
          outcomes.push({ row: row.row, status: "failed", message: NO_PERMISSION_TO_UPDATE });
          continue;
        }
        if (!look.disqualified?.has(current)) {
          outcomes.push({ row: row.row, status: "failed", message: look.reasons?.size ? REASON_NEEDED_TO_DISQUALIFY : REASON_LIST_EMPTY });
          continue;
        }
      }
      if (!jobId) {
        outcomes.push(withWarning(row, "updated"));
        continue;
      }
      const values = { ...row.values };
      // CON-01: a file value that is already a further phone or email of this contact is not
      // written as its primary (it would replace the primary and repeat the further one)
      const further = existing.filter((e) => e.viaChannel && e.id === match.id);
      if (row.phoneE164 && further.some((e) => e.phone_e164 === row.phoneE164)) delete values.phone;
      if (row.email && further.some((e) => same(e.email, row.email))) delete values.email;
      // only what the file filled in; an empty cell does not erase
      for (const [k, v] of Object.entries(values)) if (v === null) delete values[k];
      if (values.custom_fields) {
        // merged into the record in the database (FXD-04); an empty cell does not erase there either
        const filled = Object.fromEntries(Object.entries(values.custom_fields as Record<string, Json>).filter(([, v]) => v !== null));
        if (Object.keys(filled).length) values.custom_fields = { $merge: filled };
        else delete values.custom_fields;
      }
      // REC-03 (owner, 14 October 2026): an import's change tells no follower; the database accepts the
      // header only for this user's running job (app.import_write_running)
      const { data, error } = await ctx.supabase
        .from(RECORD_TYPES[ctx.entity].table)
        .update(values as never)
        .eq("organization_id", ctx.orgId)
        .eq("id", match.id)
        .setHeader(IMPORT_HEADER, jobId)
        .select("id");
      if (error || !data?.length) outcomes.push({ row: row.row, status: "failed", message: error ? dbErrorMessage(error, "העדכון נכשל.") : NO_PERMISSION_TO_UPDATE });
      else outcomes.push(withWarning(row, "updated"));
    } else {
      // a new company without a country in the file gets the default, Israel
      const taxError = settleTaxId(row, ISRAEL);
      if (taxError) outcomes.push({ row: row.row, status: "failed", message: taxError });
      else toInsert.push(row);
    }
  }

  if (!jobId) {
    for (const row of toInsert) outcomes.push(withWarning(row, "ok"));
    return outcomes.sort((a, b) => a.row - b.row);
  }

  const companies = ctx.entity === "contact" ? await resolveCompanies(ctx, toInsert, jobId) : new Map<string, string>();
  const insertRow = (row: Prepared) => ({
    organization_id: ctx.orgId,
    import_job_id: jobId,
    ...(ctx.entity === "lead" && !row.values.status_id ? { status_id: look.defaultStatus } : {}),
    ...(row.companyName ? { company_id: companies.get(key(row.companyName)) ?? null } : {}),
    ...row.values,
  });

  if (toInsert.length) {
    const { error } = await ctx.supabase.from(RECORD_TYPES[ctx.entity].table).insert(toInsert.map(insertRow) as never);
    if (!error) {
      for (const row of toInsert) outcomes.push(withWarning(row, "created"));
    } else if (error.code === "P0001") {
      // a plan limit: stop the whole import, nothing after this will fit either
      throw new ImportStopped(dbErrorMessage(error, "הגעתם למגבלת החבילה."));
    } else {
      // one bad row fails the batch: insert one by one to find it
      for (const row of toInsert) {
        const { error: rowError } = await ctx.supabase.from(RECORD_TYPES[ctx.entity].table).insert(insertRow(row) as never);
        if (rowError?.code === "P0001") throw new ImportStopped(dbErrorMessage(rowError, "הגעתם למגבלת החבילה."));
        outcomes.push(rowError ? { row: row.row, status: "failed", message: dbErrorMessage(rowError, "השמירה נכשלה.") } : withWarning(row, "created"));
      }
    }
  }
  return outcomes.sort((a, b) => a.row - b.row);
}

export { loadLookups };
