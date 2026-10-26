import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseCustomFields } from "@/features/custom-fields/values";
import { inputName, type FieldDefinition } from "@/features/custom-fields/types";
import type { Database, DealInsert, Json } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { zoneDate } from "@/lib/format";
import { readAllPages } from "@/lib/paged-read";

import { closedAtForRow, parseDealRow, resolveStage, type PipelineRef, type StageRef } from "./deal-rows";
import { CUSTOM_PREFIX } from "./fields";
import { importNote, originalCreatedOn, type ImportNote } from "./history";
import { companyFound, findCompanies, findPeople, LinkLookupFailed, linkMessage, loadOwners, orgTimeZone, ownerOf, personLookupKey, type Owners } from "./link-lookups";
import { customCellValue, nameKey, type PersonKey } from "./record-cells";
import { recordNotes, type RowOutcome } from "./server";

// IMP-03: importing deals. Writes with the user's session (RLS decides each row, as for leads), and
// tags each deal with the import, so undoing it moves exactly those deals to the recycle bin. The
// database marks the inserts origin 'import' (no automations) and sends no assignment notification.
// No duplicate detection: deals have no key that tells two rows are the same deal.

type Client = SupabaseClient<Database>;

export type DealImportContext = { supabase: Client; orgId: string; mapping: string[]; definitions: FieldDefinition[] };

export type DealLookups = {
  pipelines: PipelineRef[];
  stages: StageRef[];
  sources: Map<string, string>;
  tags: Map<string, string>;
  owners: Owners;
  timeZone: string | undefined;
};

export const TAG_NEW = (tag: string) => `תיווצר תגית חדשה: "${tag}".`;
export const TAG_CREATED = (tag: string) => `נוצרה תגית חדשה: "${tag}".`;
const LOOKUPS_FAILED = "לא הצלחנו לקרוא את תהליכי המכירה, השלבים והתגיות. נסו שוב.";
const LINKS_FAILED = "בדיקת אנשי הקשר והחברות נכשלה. נסו לייבא את השורה שוב.";

/** A read the import cannot go on without failed: the import stops (FXC-02). */
export class DealImportStopped extends Error {}

export async function loadDealLookups(ctx: DealImportContext): Promise<DealLookups> {
  const { supabase, orgId } = ctx;
  // managed lists can pass PostgREST's 1,000 rows (RVW-2): paged, ordered by id
  const page = async <T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> =>
    (
      await readAllPages(async (from, to) => {
        const { data, error } = await read(from, to);
        if (error || !data) throw new DealImportStopped(LOOKUPS_FAILED);
        return data;
      })
    ).rows;
  const [pipelines, stages, sources, tags] = await Promise.all([
    page((f, t) => supabase.from("pipelines").select("id, name, is_default, position").eq("organization_id", orgId).is("deleted_at", null).order("id").range(f, t)),
    page((f, t) => supabase.from("stages").select("id, pipeline_id, name, kind, position").eq("organization_id", orgId).order("id").range(f, t)),
    page((f, t) => supabase.from("lead_sources").select("id, name").eq("organization_id", orgId).order("id").range(f, t)),
    page((f, t) => supabase.from("tags").select("id, name").eq("organization_id", orgId).order("id").range(f, t)),
  ]);
  let owners: Owners;
  let timeZone: string | undefined;
  try {
    [owners, timeZone] = await Promise.all([loadOwners(supabase, orgId), orgTimeZone(supabase, orgId)]);
  } catch (error) {
    if (error instanceof LinkLookupFailed) throw new DealImportStopped(LOOKUPS_FAILED);
    throw error;
  }
  return {
    pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.is_default, position: p.position })),
    stages: stages.map((s) => ({ id: s.id, pipelineId: s.pipeline_id, name: s.name, kind: s.kind, position: s.position })),
    sources: new Map(sources.map((s) => [nameKey(s.name), s.id])),
    tags: new Map(tags.map((t) => [nameKey(t.name), t.id])),
    owners,
    timeZone,
  };
}

type Prepared = {
  row: number;
  values: Omit<DealInsert, "organization_id">;
  contact: PersonKey | null;
  company: { name: string; domain: string | null } | null;
  tags: string[];
  warning: string | null;
  // GAP-12: the row's note for the timeline, and the new deal's id (made here, so the note reaches its own deal)
  history: ImportNote | null;
  id: string;
};

function cellsOf(mapping: string[], definitions: FieldDefinition[], cells: string[]): { raw: Record<string, string>; custom: FormData } {
  const raw: Record<string, string> = {};
  const custom = new FormData();
  mapping.forEach((target, index) => {
    if (!target) return;
    const value = String(cells[index] ?? "").trim();
    if (target.startsWith(CUSTOM_PREFIX)) {
      const fieldKey = target.slice(CUSTOM_PREFIX.length);
      custom.set(inputName(fieldKey), customCellValue(definitions.find((d) => d.key === fieldKey)?.type, value));
    }
    else if (value !== "") raw[target] = value;
  });
  return { raw, custom };
}

function prepare(ctx: DealImportContext, look: DealLookups, cells: string[], row: number, today: string, now: Date): Prepared | string {
  const { raw, custom } = cellsOf(ctx.mapping, ctx.definitions, cells);
  const parsed = parseDealRow(raw, today);
  if (typeof parsed === "string") return parsed;
  const { row: deal } = parsed;
  let warning = parsed.warning;
  // GAP-12: the original creation date and the note; a cell that is not a valid day is reported, never guessed
  const original = originalCreatedOn(raw.original_created_on, today);
  const noted = importNote(raw.import_note, raw.import_note_date, today);
  for (const part of [original.warning, noted.warning]) if (part) warning = warning ? `${warning} ${part}` : part;

  const stage = resolveStage(look.pipelines, look.stages, deal.pipeline, deal.stage);
  if (typeof stage === "string") return stage;
  const closed = closedAtForRow(stage.kind, deal.closedDate, deal.values.expected_close_date, today, now, look.timeZone ?? "Asia/Jerusalem");
  if (closed.warning) warning = warning ? `${warning} ${closed.warning}` : closed.warning;

  // the original date is always sent, so every row of the chunk has the same columns
  const values: Omit<DealInsert, "organization_id"> = {
    ...deal.values,
    pipeline_id: stage.pipelineId,
    stage_id: stage.stageId,
    original_created_on: original.date,
  };
  if (closed.closedAt) values.closed_at = closed.closedAt;
  if (deal.owner) {
    const owner = ownerOf(look.owners, deal.owner);
    if (!owner.ok) return owner.message;
    values.owner_id = owner.id;
  }
  if (deal.source) {
    const source = look.sources.get(nameKey(deal.source));
    if (!source) return `אין מקור בשם "${deal.source}". אפשר להוסיף אותו בהגדרות ולייבא שוב.`;
    values.source_id = source;
  }

  const mappedFields = ctx.definitions.filter((d) => ctx.mapping.includes(`${CUSTOM_PREFIX}${d.key}`));
  if (mappedFields.length > 0) {
    // never required in an import (as for leads); a value must still pass the field's rules
    const { values: customValues, errors } = parseCustomFields(
      mappedFields.map((d) => ({ ...d, isRequired: false })),
      custom,
    );
    const error = Object.values(errors)[0];
    if (error) return error;
    values.custom_fields = customValues as Json;
  }
  return { row, values, contact: deal.contact, company: deal.company, tags: deal.tags, warning, history: noted.note, id: randomUUID() };
}

/** Creates the missing tags of the chunk; returns a message per name that failed. */
async function createTags(ctx: DealImportContext, look: DealLookups, names: string[]): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  for (const name of names) {
    const { data, error } = await ctx.supabase.from("tags").insert({ organization_id: ctx.orgId, name }).select("id, name").single();
    if (!error) {
      look.tags.set(nameKey(data.name), data.id);
      continue;
    }
    if (error.code === "23505") {
      // made meanwhile (another import or a person): use it
      const { data: existing, error: readError } = await ctx.supabase.from("tags").select("id, name").eq("organization_id", ctx.orgId);
      const match = readError ? undefined : existing.find((t) => nameKey(t.name) === nameKey(name));
      if (match) {
        look.tags.set(nameKey(match.name), match.id);
        continue;
      }
    }
    failed.set(nameKey(name), dbErrorMessage(error, "לא הצלחנו ליצור את התגית."));
  }
  return failed;
}

/**
 * Validates and writes one chunk. With jobId null it is a dry run (the preview): nothing is
 * written. `stopped` says why the import cannot go on (a plan limit); the rows of the chunk that
 * were not written then carry that message.
 */
export async function processDealChunk(
  ctx: DealImportContext,
  lookups: DealLookups | null,
  chunk: string[][],
  firstRow: number,
  jobId: string | null,
): Promise<{ outcomes: RowOutcome[]; stopped: string | null }> {
  const look = lookups ?? (await loadDealLookups(ctx));
  const now = new Date();
  const today = zoneDate(now, look.timeZone);
  const outcomes: RowOutcome[] = [];
  const prepared: Prepared[] = [];
  chunk.forEach((cells, i) => {
    const result = prepare(ctx, look, cells, firstRow + i, today, now);
    if (typeof result === "string") outcomes.push({ row: firstRow + i, status: "failed", message: result });
    else prepared.push(result);
  });

  // the contact and the company of each row, read with the user's session
  let ready: Prepared[];
  try {
    const [people, companies] = await Promise.all([
      findPeople(ctx.supabase, ctx.orgId, "contact", prepared.flatMap((p) => (p.contact ? [p.contact] : []))),
      findCompanies(ctx.supabase, ctx.orgId, prepared.flatMap((p) => (p.company ? [p.company] : []))),
    ]);
    ready = [];
    for (const row of prepared) {
      if (row.contact) {
        const found = people.get(personLookupKey(row.contact) ?? "") ?? "missing";
        if (typeof found === "string") {
          outcomes.push({ row: row.row, status: "failed", message: linkMessage(found, "contact", row.contact.value) });
          continue;
        }
        row.values.contact_id = found.id;
      }
      if (row.company) {
        const found = companyFound(companies, row.company);
        if (typeof found === "string") {
          outcomes.push({ row: row.row, status: "failed", message: linkMessage(found, "company", row.company.name) });
          continue;
        }
        row.values.company_id = found.id;
      }
      ready.push(row);
    }
  } catch (error) {
    if (!(error instanceof LinkLookupFailed)) throw error;
    for (const row of prepared) outcomes.push({ row: row.row, status: "failed", message: LINKS_FAILED });
    return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped: null };
  }

  // tags: existing ones by name; a missing one is created once and announced on its first row
  const newTags = [...new Map(ready.flatMap((r) => r.tags).filter((t) => !look.tags.has(nameKey(t))).map((t) => [nameKey(t), t])).values()];
  const announced = new Set<string>();
  const announce = (row: Prepared, words: (tag: string) => string) => {
    const fresh = row.tags.filter((t) => newTags.some((n) => nameKey(n) === nameKey(t)) && !announced.has(nameKey(t)));
    for (const t of fresh) announced.add(nameKey(t));
    const notes = [row.warning, ...fresh.map(words)].filter(Boolean);
    return notes.length ? notes.join(" ") : undefined;
  };

  if (!jobId) {
    for (const row of ready) {
      const warning = announce(row, TAG_NEW);
      outcomes.push(warning ? { row: row.row, status: "ok", warning } : { row: row.row, status: "ok" });
    }
    return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped: null };
  }

  const tagFailed = await createTags(ctx, look, newTags);
  const toWrite: Array<Prepared & { note?: string }> = [];
  for (const row of ready) {
    const failedTag = row.tags.find((t) => tagFailed.has(nameKey(t)));
    if (failedTag) {
      outcomes.push({ row: row.row, status: "failed", message: tagFailed.get(nameKey(failedTag)) });
      continue;
    }
    // always sent, so every row of the chunk has the same columns and one insert takes them all
    row.values.tag_ids = [...new Set(row.tags.map((t) => look.tags.get(nameKey(t))!))];
    toWrite.push({ ...row, note: announce(row, TAG_CREATED) });
  }

  const insertRow = (row: Prepared) => ({ id: row.id, organization_id: ctx.orgId, import_job_id: jobId, ...row.values });
  const noteWork: Array<{ outcome: RowOutcome; recordId: string; note: ImportNote }> = [];
  const done = (row: Prepared & { note?: string }): RowOutcome => {
    const outcome: RowOutcome = row.note ? { row: row.row, status: "created", warning: row.note } : { row: row.row, status: "created" };
    if (row.history) noteWork.push({ outcome, recordId: row.id, note: row.history });
    return outcome;
  };

  let stopped: string | null = null;
  if (toWrite.length) {
    const { error } = await ctx.supabase.from("deals").insert(toWrite.map(insertRow));
    if (!error) {
      for (const row of toWrite) outcomes.push(done(row));
    } else {
      // one row at a time: the rows that fit go in, a bad row fails alone, a plan limit stops the import
      for (const row of toWrite) {
        if (stopped) {
          outcomes.push({ row: row.row, status: "failed", message: stopped });
          continue;
        }
        const { error: rowError } = await ctx.supabase.from("deals").insert(insertRow(row));
        if (!rowError) outcomes.push(done(row));
        else if (rowError.code === "P0001" && /^(limit|feature):/.test(rowError.hint ?? "")) {
          stopped = dbErrorMessage(rowError, "הגעתם למגבלת החבילה.");
          outcomes.push({ row: row.row, status: "failed", message: stopped });
        } else outcomes.push({ row: row.row, status: "failed", message: dbErrorMessage(rowError, "השמירה נכשלה.") });
      }
    }
  }
  await recordNotes(ctx, jobId, noteWork);
  return { outcomes: outcomes.sort((a, b) => a.row - b.row), stopped };
}
