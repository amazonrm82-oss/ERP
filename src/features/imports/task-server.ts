import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, TaskInsert } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { zonedIso } from "@/lib/format";

import { CUSTOM_PREFIX } from "./fields";
import { companyFound, findCompanies, findDeals, findPeople, LinkLookupFailed, linkMessage, loadOwners, orgTimeZone, ownerOf, personLookupKey, type Found, type Owners } from "./link-lookups";
import type { RowOutcome } from "./server";
import { DEFAULT_DUE_TIME, parseTaskRow, type ParsedTaskRow } from "./task-rows";

// IMP-03: importing tasks. Writes with the user's session; tasks have column-level grants (TASK-04)
// and may link only records the user can read (tasks_insert, can_read_task_links): the links are
// looked up with the same session, so a record the user cannot see is "not found". Each task is
// tagged with the import, so undoing it removes exactly those tasks. The database marks the inserts
// origin 'import' (no automations) and sends no "assigned to you" notification.
// No duplicate detection, no tags, no custom fields.

type Client = SupabaseClient<Database>;

export type TaskImportContext = { supabase: Client; orgId: string; mapping: string[] };

export type TaskLookups = { owners: Owners; timeZone: string | undefined };

const LOOKUPS_FAILED = "לא הצלחנו לקרוא את רשימת המשתמשים. נסו שוב.";
const LINKS_FAILED = "בדיקת הרשומות המקושרות נכשלה. נסו לייבא את השורה שוב.";

export class TaskImportStopped extends Error {}

export async function loadTaskLookups(ctx: TaskImportContext): Promise<TaskLookups> {
  try {
    const [owners, timeZone] = await Promise.all([loadOwners(ctx.supabase, ctx.orgId), orgTimeZone(ctx.supabase, ctx.orgId)]);
    return { owners, timeZone };
  } catch (error) {
    if (error instanceof LinkLookupFailed) throw new TaskImportStopped(LOOKUPS_FAILED);
    throw error;
  }
}

type Prepared = { row: number; parsed: ParsedTaskRow; values: Omit<TaskInsert, "organization_id"> };

function rawCells(mapping: string[], cells: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  mapping.forEach((target, index) => {
    if (!target || target.startsWith(CUSTOM_PREFIX)) return;
    const value = String(cells[index] ?? "").trim();
    if (value !== "") raw[target] = value;
  });
  return raw;
}

function prepare(ctx: TaskImportContext, look: TaskLookups, cells: string[], row: number): Prepared | string {
  const parsed = parseTaskRow(rawCells(ctx.mapping, cells));
  if (typeof parsed === "string") return parsed;
  const values: Omit<TaskInsert, "organization_id"> = { ...parsed.values };
  // the due time is the business's wall clock (as in the task form)
  if (parsed.dueDate) values.due_at = zonedIso(parsed.dueDate, `${parsed.dueTime ?? DEFAULT_DUE_TIME}:00`, look.timeZone);
  if (parsed.owner) {
    const owner = ownerOf(look.owners, parsed.owner);
    if (!owner.ok) return owner.message;
    values.owner_id = owner.id;
  }
  return { row, parsed, values };
}

/** Validates and writes one chunk. With jobId null it is a dry run (the preview): nothing is written. */
export async function processTaskChunk(
  ctx: TaskImportContext,
  lookups: TaskLookups | null,
  chunk: string[][],
  firstRow: number,
  jobId: string | null,
): Promise<{ outcomes: RowOutcome[]; stopped: string | null }> {
  const look = lookups ?? (await loadTaskLookups(ctx));
  const outcomes: RowOutcome[] = [];
  const prepared: Prepared[] = [];
  chunk.forEach((cells, i) => {
    const result = prepare(ctx, look, cells, firstRow + i);
    if (typeof result === "string") outcomes.push({ row: firstRow + i, status: "failed", message: result });
    else prepared.push(result);
  });

  const ready: Prepared[] = [];
  try {
    const [leads, contacts, companies, deals] = await Promise.all([
      findPeople(ctx.supabase, ctx.orgId, "lead", prepared.flatMap((p) => (p.parsed.lead ? [p.parsed.lead] : []))),
      findPeople(ctx.supabase, ctx.orgId, "contact", prepared.flatMap((p) => (p.parsed.contact ? [p.parsed.contact] : []))),
      findCompanies(ctx.supabase, ctx.orgId, prepared.flatMap((p) => (p.parsed.company ? [p.parsed.company] : []))),
      findDeals(ctx.supabase, ctx.orgId, prepared.flatMap((p) => (p.parsed.deal ? [p.parsed.deal] : []))),
    ]);
    for (const row of prepared) {
      const { lead, contact, company, deal } = row.parsed;
      const links: Array<[Found, "lead" | "contact" | "company" | "deal", string, "lead_id" | "contact_id" | "company_id" | "deal_id"]> = [];
      if (lead) links.push([leads.get(personLookupKey(lead) ?? "") ?? "missing", "lead", lead.value, "lead_id"]);
      if (contact) links.push([contacts.get(personLookupKey(contact) ?? "") ?? "missing", "contact", contact.value, "contact_id"]);
      if (company) links.push([companyFound(companies, company), "company", company.name, "company_id"]);
      if (deal) links.push([deals.get(deal) ?? "missing", "deal", deal, "deal_id"]);
      const bad = links.find(([found]) => typeof found === "string");
      if (bad) {
        outcomes.push({ row: row.row, status: "failed", message: linkMessage(bad[0] as "missing" | "ambiguous", bad[1], bad[2]) });
        continue;
      }
      for (const [found, , , column] of links) row.values[column] = (found as { id: string }).id;
      ready.push(row);
    }
  } catch (error) {
    if (!(error instanceof LinkLookupFailed)) throw error;
    for (const row of prepared) outcomes.push({ row: row.row, status: "failed", message: LINKS_FAILED });
    return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped: null };
  }

  if (!jobId) {
    for (const row of ready) outcomes.push({ row: row.row, status: "ok" });
    return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped: null };
  }

  const insertRow = (row: Prepared) => ({ organization_id: ctx.orgId, import_job_id: jobId, ...row.values });
  let stopped: string | null = null;
  if (ready.length) {
    const { error } = await ctx.supabase.from("tasks").insert(ready.map(insertRow));
    if (!error) {
      for (const row of ready) outcomes.push({ row: row.row, status: "created" });
    } else {
      // one row at a time: a link the database refuses, or a bad row, fails alone
      for (const row of ready) {
        if (stopped) {
          outcomes.push({ row: row.row, status: "failed", message: stopped });
          continue;
        }
        const { error: rowError } = await ctx.supabase.from("tasks").insert(insertRow(row));
        if (!rowError) outcomes.push({ row: row.row, status: "created" });
        else if (rowError.code === "P0001" && /^(limit|feature):/.test(rowError.hint ?? "")) {
          stopped = dbErrorMessage(rowError, "הגעתם למגבלת החבילה.");
          outcomes.push({ row: row.row, status: "failed", message: stopped });
        } else outcomes.push({ row: row.row, status: "failed", message: dbErrorMessage(rowError, "השמירה נכשלה.") });
      }
    }
  }
  return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped };
}
