import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sourceSchema, statusSchema } from "@/features/customization/schema";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { readAllPages } from "@/lib/paged-read";
import { saveOrder } from "@/lib/reorder";

import type { ImportEntityKey } from "./fields";
import { LinkLookupFailed, loadOwners, ownerMatch } from "./link-lookups";
import {
  creatableCount,
  listColumnsOf,
  MAX_CREATED_NAMES,
  missingNames,
  NAMES_TOO_MANY,
  openBeforeClosed,
  STAGE_NAME_MAX,
  type CreatedNames,
  type ListCells,
  type ListSnapshot,
  type NameFailure,
  type MissingNames,
} from "./list-names";

// CHN-05 (245) ג: reads the business's lists with the person's session (RLS decides; members read them all) and
// creates the missing names through the same tables and policies as the settings pages (owners and admins of a
// writable business; any limit a trigger sets answers with its own hint). Nothing here uses the service key.

type Client = SupabaseClient<Database>;

export const LISTS_UNREADABLE = "לא הצלחנו לקרוא את הרשימות של העסק. נסו שוב.";

class ReadFailed extends Error {}

type StatusRow = { id: string; name: string; kind: string; position: number };
type StageRow = { id: string; pipeline_id: string; name: string; kind: string; position: number };

type Read = { snapshot: ListSnapshot; statuses: StatusRow[]; stages: StageRow[] };

async function readLists(supabase: Client, orgId: string, entity: ImportEntityKey): Promise<Read> {
  const cols = listColumnsOf(entity);
  // managed lists can pass PostgREST's 1,000 rows (RVW-2): paged, ordered by id
  const page = async <T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> =>
    (
      await readAllPages(async (from, to) => {
        const { data, error } = await read(from, to);
        if (error || !data) throw new ReadFailed();
        return data;
      })
    ).rows;
  const none = async <T>(): Promise<T[]> => [];
  const [statuses, sources, pipelines, stages] = await Promise.all([
    cols.status
      ? page<StatusRow>((f, t) => supabase.from("lead_statuses").select("id, name, kind, position").eq("organization_id", orgId).order("id").range(f, t))
      : none<StatusRow>(),
    cols.source ? page<{ id: string; name: string }>((f, t) => supabase.from("lead_sources").select("id, name").eq("organization_id", orgId).order("id").range(f, t)) : none<{ id: string; name: string }>(),
    cols.stage
      ? page<{ id: string; name: string; is_default: boolean; position: number }>((f, t) =>
          supabase.from("pipelines").select("id, name, is_default, position").eq("organization_id", orgId).is("deleted_at", null).order("id").range(f, t),
        )
      : none<{ id: string; name: string; is_default: boolean; position: number }>(),
    cols.stage
      ? page<StageRow>((f, t) => supabase.from("stages").select("id, pipeline_id, name, kind, position").eq("organization_id", orgId).order("id").range(f, t))
      : none<StageRow>(),
  ]);
  return {
    statuses,
    stages,
    snapshot: {
      statuses: statuses.map((s) => s.name),
      sources: sources.map((s) => s.name),
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.is_default,
        position: p.position,
        stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => s.name),
      })),
    },
  };
}

/** The names of the file that the business does not have (owners: values that are not one active member). */
export async function checkListNames(supabase: Client, orgId: string, entity: ImportEntityKey, cells: ListCells): Promise<MissingNames | string> {
  try {
    const [{ snapshot }, owners] = await Promise.all([
      readLists(supabase, orgId, entity),
      cells.owners.length > 0 ? loadOwners(supabase, orgId) : Promise.resolve(new Map<string, string | null>()),
    ]);
    return missingNames(cells, snapshot, (cell) => typeof ownerMatch(owners, cell) !== "string");
  } catch (error) {
    if (error instanceof ReadFailed || error instanceof LinkLookupFailed) return LISTS_UNREADABLE;
    throw error;
  }
}

/**
 * Creates the missing names, judged again from the lists read now (never a name that exists, never a sales process).
 * Statuses and stages are added as open ones, before the closed ones, and each list's order is saved in one call.
 */
export async function createListNames(supabase: Client, orgId: string, entity: ImportEntityKey, cells: ListCells): Promise<CreatedNames | string> {
  let read: Read;
  try {
    read = await readLists(supabase, orgId, entity);
  } catch (error) {
    if (error instanceof ReadFailed) return LISTS_UNREADABLE;
    throw error;
  }
  // owners are never created, so they are not asked for here
  const missing = missingNames({ ...cells, owners: [] }, read.snapshot, () => true);
  const total = creatableCount(missing);
  if (total > MAX_CREATED_NAMES) return NAMES_TOO_MANY(total);
  const failed: NameFailure[] = [];
  let created = 0;

  if (missing.statuses.length > 0) {
    const added: string[] = [];
    for (const [i, name] of missing.statuses.entries()) {
      const parsed = statusSchema.safeParse({ name, kind: "open" });
      if (!parsed.success) {
        failed.push({ kind: "status", name, message: parsed.error.issues[0]?.message ?? "השם אינו תקין." });
        continue;
      }
      const { data, error } = await supabase
        .from("lead_statuses")
        .insert({ organization_id: orgId, name: parsed.data.name, kind: "open", position: read.statuses.length + i })
        .select("id")
        .single();
      if (error || !data) failed.push({ kind: "status", name, message: dbErrorMessage(error, "לא הצלחנו להוסיף את הסטטוס.") });
      else added.push(data.id);
    }
    created += added.length;
    if (added.length > 0) {
      const ordered = [...read.statuses].sort((a, b) => a.position - b.position);
      const orderError = await saveOrder(supabase, "lead_statuses", orgId, openBeforeClosed(ordered, added));
      // the statuses exist; only their place in the list was not saved
      if (orderError) failed.push({ kind: "status", name: "", message: ORDER_NOT_SAVED });
    }
  }

  for (const name of missing.sources) {
    const parsed = sourceSchema.safeParse({ name });
    if (!parsed.success) {
      failed.push({ kind: "source", name, message: parsed.error.issues[0]?.message ?? "השם אינו תקין." });
      continue;
    }
    const { error } = await supabase.from("lead_sources").insert({ organization_id: orgId, name: parsed.data.name, kind: "other" });
    if (error) failed.push({ kind: "source", name, message: dbErrorMessage(error, "לא הצלחנו להוסיף את המקור.") });
    else created += 1;
  }

  for (const pipeline of missing.stages) {
    const existing = read.stages.filter((s) => s.pipeline_id === pipeline.pipelineId).sort((a, b) => a.position - b.position);
    const added: string[] = [];
    for (const [i, name] of pipeline.names.entries()) {
      if (Array.from(name).length > STAGE_NAME_MAX) {
        failed.push({ kind: "stage", name, message: `השם ארוך מדי (עד ${STAGE_NAME_MAX} תווים).` });
        continue;
      }
      const { data, error } = await supabase
        .from("stages")
        .insert({ organization_id: orgId, pipeline_id: pipeline.pipelineId, name, kind: "open", position: existing.length + i })
        .select("id")
        .single();
      if (error || !data) failed.push({ kind: "stage", name, message: dbErrorMessage(error, "לא הצלחנו להוסיף את השלב.") });
      else added.push(data.id);
    }
    created += added.length;
    if (added.length > 0) {
      const orderError = await saveOrder(supabase, "stages", orgId, openBeforeClosed(existing, added));
      if (orderError) failed.push({ kind: "stage", name: "", message: ORDER_NOT_SAVED });
    }
  }
  return { created, failed };
}

const ORDER_NOT_SAVED = "השמות נוצרו, אבל לא הצלחנו לשים אותם לפני הסגורים. אפשר לסדר אותם בהגדרות.";

