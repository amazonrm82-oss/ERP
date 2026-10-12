import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companySchema } from "@/features/companies/schema";
import { parseCustomFields } from "@/features/custom-fields/values";
import { inputName, type FieldDefinition } from "@/features/custom-fields/types";
import type { Database, Json } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { normalizePhone } from "@/lib/phone";
import { optionalDate, optionalEmail, optionalPhone, optionalText } from "@/lib/validation";
import { RECORD_TYPES } from "@/lib/record-types";

import { CUSTOM_PREFIX, type DuplicateModeKey, type ImportEntityKey } from "./fields";

type Client = SupabaseClient<Database>;

export type RowOutcome = { row: number; status: "created" | "updated" | "skipped" | "failed" | "ok"; message?: string };

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
};

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
  const v = value.trim();
  const dmy = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return v;
}

async function loadLookups(ctx: ImportContext): Promise<Lookups> {
  const { supabase, orgId } = ctx;
  const [statuses, sources, members] = await Promise.all([
    ctx.entity === "lead" ? supabase.from("lead_statuses").select("id, name, is_default").eq("organization_id", orgId) : Promise.resolve({ data: [] }),
    ctx.entity === "lead" ? supabase.from("lead_sources").select("id, name").eq("organization_id", orgId) : Promise.resolve({ data: [] }),
    supabase.from("memberships").select("user_id").eq("organization_id", orgId).eq("status", "active").neq("role", "viewer"),
  ]);
  const ids = (members.data ?? []).map((m) => m.user_id);
  const { data: profiles } = ids.length ? await supabase.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
  const owners = new Map<string, string>();
  for (const p of profiles ?? []) {
    if (p.email) owners.set(key(p.email), p.id);
    if (p.full_name) owners.set(key(p.full_name), p.id);
  }
  const statusRows = (statuses.data ?? []) as Array<{ id: string; name: string; is_default?: boolean }>;
  return {
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
  taxId: string | null;
  name: string | null;
  companyName: string | null;
};

/** Validates one row and turns it into column values. Returns a message when the row cannot be imported. */
function prepareRow(ctx: ImportContext, lookups: Lookups, cells: string[], row: number): Prepared | string {
  const raw: Record<string, string> = {};
  const custom = new FormData();
  ctx.mapping.forEach((target, index) => {
    if (!target) return;
    const value = String(cells[index] ?? "").trim();
    if (target.startsWith(CUSTOM_PREFIX)) {
      custom.set(inputName(target.slice(CUSTOM_PREFIX.length)), value);
    } else if (value !== "") {
      raw[target] = target === "phone" ? restorePhone(value) : value;
    }
  });

  const values: Record<string, unknown> = {};
  let name: string | null = null;
  let companyName: string | null = null;

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
    const parsed = companySchema.safeParse({
      name: raw.name,
      tax_id: raw.tax_id,
      industry: "",
      phone: raw.phone,
      email: raw.email,
      website: raw.website,
      city: raw.city,
      address_line: raw.address_line,
    });
    if (!parsed.success) return firstIssue(parsed.error);
    // the file has no country: an import never writes one, so an update keeps the
    // company's country (CON-04) and a new company gets the database default (IL)
    const { industry: _industry, country: _country, ...rest } = parsed.data;
    void _industry;
    void _country;
    Object.assign(values, rest);
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
    taxId: (values.tax_id as string | null) ?? null,
    name,
    companyName,
  };
}


type Existing = { id: string; phone_e164: string | null; email: string | null; tax_id: string | null; name: string | null };

/** A lookup that failed: the chunk fails as a whole rather than guessing (FXC-02). */
class LookupFailed extends Error {}

const present = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

/** Records already in the organization (that the user can see) matching any row of the chunk; one query in the database. */
async function findExisting(ctx: ImportContext, entity: ImportEntityKey, rows: Array<Pick<Prepared, "phoneE164" | "email" | "taxId" | "name">>): Promise<Existing[]> {
  if (rows.length === 0) return [];
  const { data, error } = await ctx.supabase.rpc("import_find_duplicates", {
    p_org: ctx.orgId,
    p_entity: entity,
    p_phones: present(rows.map((r) => r.phoneE164)),
    p_emails: present(rows.map((r) => r.email)),
    p_tax_ids: entity === "company" ? present(rows.map((r) => r.taxId)) : [],
    p_names: entity === "company" ? present(rows.map((r) => r.name)) : [],
  });
  if (error) throw new LookupFailed(error.message);
  return data;
}

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function matchExisting(entity: ImportEntityKey, existing: Existing[], row: Prepared): Existing | undefined {
  return existing.find(
    (e) =>
      (row.phoneE164 && e.phone_e164 === row.phoneE164) ||
      same(row.email, e.email) ||
      (entity === "company" && ((row.taxId && e.tax_id === row.taxId) || same(row.name, e.name))),
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
    names.map((name) => ({ phoneE164: null, email: null, taxId: null, name })),
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

async function writeChunk(ctx: ImportContext, look: Lookups, prepared: Prepared[], outcomes: RowOutcome[], jobId: string | null): Promise<RowOutcome[]> {
  const existing = ctx.mode === "create" ? [] : await findExisting(ctx, ctx.entity, prepared);
  const toInsert: Prepared[] = [];
  const seen: Prepared[] = [];
  for (const row of prepared) {
    // a repeat of an earlier row in the same chunk counts as a duplicate too
    const earlier = ctx.mode === "create" ? undefined : seen.find((s) => (row.phoneE164 && s.phoneE164 === row.phoneE164) || same(row.email, s.email));
    seen.push(row);
    const match = matchExisting(ctx.entity, existing, row);
    if (earlier || (match && ctx.mode === "skip")) {
      outcomes.push({ row: row.row, status: "skipped", message: "כבר קיים" });
    } else if (match && ctx.mode === "update") {
      if (!jobId) {
        outcomes.push({ row: row.row, status: "updated" });
        continue;
      }
      const values = { ...row.values };
      // only what the file filled in; an empty cell does not erase
      for (const [k, v] of Object.entries(values)) if (v === null) delete values[k];
      if (values.custom_fields) {
        // merged into the record in the database (FXD-04); an empty cell does not erase there either
        const filled = Object.fromEntries(Object.entries(values.custom_fields as Record<string, Json>).filter(([, v]) => v !== null));
        if (Object.keys(filled).length) values.custom_fields = { $merge: filled };
        else delete values.custom_fields;
      }
      const { data, error } = await ctx.supabase.from(RECORD_TYPES[ctx.entity].table).update(values as never).eq("organization_id", ctx.orgId).eq("id", match.id).select("id");
      if (error || !data?.length) outcomes.push({ row: row.row, status: "failed", message: error ? dbErrorMessage(error, "העדכון נכשל.") : "אין הרשאה לעדכן את הרשומה הקיימת." });
      else outcomes.push({ row: row.row, status: "updated" });
    } else {
      toInsert.push(row);
    }
  }

  if (!jobId) {
    for (const row of toInsert) outcomes.push({ row: row.row, status: "ok" });
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
      for (const row of toInsert) outcomes.push({ row: row.row, status: "created" });
    } else if (error.code === "P0001") {
      // a plan limit: stop the whole import, nothing after this will fit either
      throw new ImportStopped(dbErrorMessage(error, "הגעתם למגבלת החבילה."));
    } else {
      // one bad row fails the batch: insert one by one to find it
      for (const row of toInsert) {
        const { error: rowError } = await ctx.supabase.from(RECORD_TYPES[ctx.entity].table).insert(insertRow(row) as never);
        if (rowError?.code === "P0001") throw new ImportStopped(dbErrorMessage(rowError, "הגעתם למגבלת החבילה."));
        outcomes.push(rowError ? { row: row.row, status: "failed", message: dbErrorMessage(rowError, "השמירה נכשלה.") } : { row: row.row, status: "created" });
      }
    }
  }
  return outcomes.sort((a, b) => a.row - b.row);
}

export { loadLookups };
