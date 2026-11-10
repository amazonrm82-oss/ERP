// CHN-05, owner's answer (245) ג (10 November 2026): before an import runs, the wizard shows which status, source and
// stage names of the file the business does not have yet, and owners and admins may create them in one step. Pure (no
// database): the browser collects the file's distinct values, the server compares them with the lists it read with the
// person's session, and both use these functions, so the screen says exactly what the import will find.
//
// The rules, from the answer and the lead's choice:
//   - names are compared as the import compares them (`nameKey`: trimmed, spaces folded, without case);
//   - a status or source missing from the business's list may be created; a stage only inside a sales process that
//     exists (the row's own, else the default one, as `resolveStage` picks it); a sales process is never created, and a
//     row naming an unknown one keeps today's behaviour (it fails with its reason);
//   - an owner (a user) is never created: a value that is not one active member stays empty on the row, with a note;
//   - undoing the import never removes a created name.

import type { ImportEntityKey } from "./fields";
import { formatNumber } from "@/lib/format";

import { nameKey } from "./record-cells";

/** The longest names the lists take (the settings forms' own limits). */
export const STATUS_NAME_MAX = 60;
export const SOURCE_NAME_MAX = 60;
export const STAGE_NAME_MAX = 80;

/** Distinct values sent to the server per kind; a file with more is almost surely a wrongly mapped column. */
export const MAX_DISTINCT_VALUES = 500;
/** Names created in one import, at most. */
export const MAX_CREATED_NAMES = 100;

/** The file's distinct values of the list columns, each once by `nameKey`, as first written (spaces folded). */
export type ListCells = {
  statuses: string[];
  sources: string[];
  owners: string[];
  // deals: the stage with the sales process the same row names (null = the default process)
  stages: Array<{ pipeline: string | null; stage: string }>;
  // a kind had more distinct values than MAX_DISTINCT_VALUES (the rest were not sent)
  truncated: boolean;
};

/** A cell longer than this is cut (no list name is near it; it is shown as missing and cannot be created). */
export const LIST_CELL_MAX = 200;

/** A name written as the file has it, spaces folded (what is created and shown). */
export const cleanName = (text: string) => Array.from(text.trim().replace(/\s+/g, " ")).slice(0, LIST_CELL_MAX).join("").trim();

/** Which list columns an object's import reads by name. Tasks' "status" is a closed list (open / done), not a list. */
export function listColumnsOf(entity: ImportEntityKey): { status: boolean; source: boolean; stage: boolean; owner: boolean } {
  return {
    status: entity === "lead",
    source: entity === "lead" || entity === "deal",
    stage: entity === "deal",
    owner: entity !== "product",
  };
}

/** Whether the mapping holds a column whose names may be missing (or an owner). */
export function mapsListColumn(entity: ImportEntityKey, mapping: string[]): boolean {
  const cols = listColumnsOf(entity);
  return (
    (cols.status && mapping.includes("status")) ||
    (cols.source && mapping.includes("source")) ||
    (cols.stage && (mapping.includes("stage") || mapping.includes("pipeline"))) ||
    (cols.owner && mapping.includes("owner"))
  );
}

/** Collects the distinct names of the list columns of the whole file. */
export function collectListCells(entity: ImportEntityKey, mapping: string[], rows: string[][]): ListCells {
  const cols = listColumnsOf(entity);
  const at = (target: string) => (mapping.includes(target) ? mapping.indexOf(target) : -1);
  const status = cols.status ? at("status") : -1;
  const source = cols.source ? at("source") : -1;
  const owner = cols.owner ? at("owner") : -1;
  const stage = cols.stage ? at("stage") : -1;
  const pipeline = cols.stage ? at("pipeline") : -1;
  let truncated = false;

  const bag = () => {
    const seen = new Set<string>();
    const out: string[] = [];
    return {
      out,
      add(value: string | undefined) {
        const name = cleanName(value ?? "");
        if (!name || seen.has(nameKey(name))) return;
        if (out.length >= MAX_DISTINCT_VALUES) {
          truncated = true;
          return;
        }
        seen.add(nameKey(name));
        out.push(name);
      },
    };
  };
  const statuses = bag();
  const sources = bag();
  const owners = bag();
  const stageSeen = new Set<string>();
  const stages: ListCells["stages"] = [];

  for (const row of rows) {
    if (status >= 0) statuses.add(row[status]);
    if (source >= 0) sources.add(row[source]);
    if (owner >= 0) owners.add(row[owner]);
    if (stage >= 0 || pipeline >= 0) {
      // a row without a stage goes to its process's first open stage: nothing to create, but an unknown process is reported
      const stageName = stage >= 0 ? cleanName(row[stage] ?? "") : "";
      const pipelineName = pipeline >= 0 ? cleanName(row[pipeline] ?? "") || null : null;
      if (!stageName && !pipelineName) continue;
      const k = `${pipelineName === null ? "" : nameKey(pipelineName)}\u0000${nameKey(stageName)}`;
      if (stageSeen.has(k)) continue;
      if (stages.length >= MAX_DISTINCT_VALUES) {
        truncated = true;
        continue;
      }
      stageSeen.add(k);
      stages.push({ pipeline: pipelineName, stage: stageName });
    }
  }
  return { statuses: statuses.out, sources: sources.out, owners: owners.out, stages, truncated };
}

export type ListPipeline = { id: string; name: string; isDefault: boolean; position: number; stages: string[] };
export type ListSnapshot = { statuses: string[]; sources: string[]; pipelines: ListPipeline[] };

/** The names the import would not find, and what can be created of them. */
export type MissingNames = {
  statuses: string[];
  sources: string[];
  stages: Array<{ pipelineId: string; pipelineName: string; names: string[] }>;
  // named by the file but not in the business: never created; their rows fail as today
  unknownPipelines: string[];
  // values that are not one active member: the row is imported without an owner
  unknownOwners: string[];
  truncated: boolean;
};

/** The sales process a row lands in: its own by name, else the default one, else the first (as `resolveStage`). */
export function pipelineFor(pipelines: ListPipeline[], name: string | null): ListPipeline | null {
  const ordered = [...pipelines].sort((a, b) => a.position - b.position);
  if (name) return ordered.find((p) => nameKey(p.name) === nameKey(name)) ?? null;
  return ordered.find((p) => p.isDefault) ?? ordered[0] ?? null;
}

/**
 * Compares the file's names with the business's lists. `ownerKnown` answers whether a cell names exactly one active
 * member (the import's own rule, `ownerMatch`).
 */
export function missingNames(cells: ListCells, lists: ListSnapshot, ownerKnown: (cell: string) => boolean): MissingNames {
  const absent = (names: string[], have: string[]) => {
    const known = new Set(have.map(nameKey));
    return names.filter((n) => !known.has(nameKey(n)));
  };
  const stages = new Map<string, { pipelineId: string; pipelineName: string; names: string[]; seen: Set<string> }>();
  const unknownPipelines: string[] = [];
  const unknownSeen = new Set<string>();
  for (const { pipeline: pipelineName, stage } of cells.stages) {
    const pipeline = pipelineFor(lists.pipelines, pipelineName);
    if (!pipeline) {
      if (pipelineName && !unknownSeen.has(nameKey(pipelineName))) {
        unknownSeen.add(nameKey(pipelineName));
        unknownPipelines.push(pipelineName);
      }
      continue;
    }
    if (!stage || pipeline.stages.some((s) => nameKey(s) === nameKey(stage))) continue;
    const entry = stages.get(pipeline.id) ?? { pipelineId: pipeline.id, pipelineName: pipeline.name, names: [], seen: new Set<string>() };
    if (!entry.seen.has(nameKey(stage))) {
      entry.seen.add(nameKey(stage));
      entry.names.push(stage);
    }
    stages.set(pipeline.id, entry);
  }
  return {
    statuses: absent(cells.statuses, lists.statuses),
    sources: absent(cells.sources, lists.sources),
    stages: [...stages.values()].map(({ pipelineId, pipelineName, names }) => ({ pipelineId, pipelineName, names })),
    unknownPipelines,
    unknownOwners: cells.owners.filter((o) => !ownerKnown(o)),
    truncated: cells.truncated,
  };
}

/** How many names creating would add. */
export function creatableCount(missing: MissingNames): number {
  return missing.statuses.length + missing.sources.length + missing.stages.reduce((sum, p) => sum + p.names.length, 0);
}

/** A list in its new order: the open entries, then the new ones, then the closed ones (as the settings pages add). */
export function openBeforeClosed<T extends { id: string; kind: string }>(existing: T[], added: string[]): string[] {
  const open = existing.filter((e) => e.kind === "open").map((e) => e.id);
  const closed = existing.filter((e) => e.kind !== "open").map((e) => e.id);
  return [...open, ...added, ...closed];
}

// --- texts -------------------------------------------------------------------------------------------------------

/** The note on a row whose owner is not one active member: the row is imported without one. */
export const OWNER_LEFT_EMPTY = (cell: string, ambiguous: boolean) =>
  ambiguous
    ? `יש כמה משתמשים בשם "${cell}", ולכן לא נקבע אחראי. כדי לשייך, כתבו בקובץ את האימייל של האחראי.`
    : `לא נמצא משתמש פעיל "${cell}" (לפי אימייל או שם), ולכן לא נקבע אחראי.`;

export const NAMES_TITLE = "שמות שעדיין אין במערכת";
export const NAMES_CREATE_LABEL = "ליצור את השמות החסרים";
export const NAMES_CREATE_HINT = "השמות ייווצרו לפני הייבוא, ויישארו גם אם תבטלו את הייבוא. סטטוסים ושלבים חדשים נוספים כפתוחים, לפני הסגורים.";
export const NAMES_ASK_ADMIN = "בקשו ממנהל מערכת ליצור את השמות האלה בהגדרות. בינתיים שורה עם שם חסר לא תיובא.";
export const NAMES_NOT_CREATED = "בלי יצירה, שורה עם שם חסר לא תיובא, ותופיע ברשימת השורות שנכשלו.";
export const NAMES_TOO_MANY = (count: number) =>
  `בקובץ ${count} שמות חסרים. אפשר ליצור עד ${MAX_CREATED_NAMES} בכל ייבוא. בדקו שבחרתם את העמודה הנכונה, או הוסיפו את השמות בהגדרות.`;
export const NAMES_TRUNCATED = `בעמודה יש יותר מ-${MAX_DISTINCT_VALUES} ערכים שונים, ונבדקו רק הראשונים. בדקו שבחרתם את העמודה הנכונה.`;
export const PIPELINES_NOT_CREATED = "תהליך מכירה לא נוצר בייבוא. שורה עם תהליך שלא קיים לא תיובא. אפשר להוסיף אותו בהגדרות ולייבא שוב.";
export const OWNERS_LEFT_EMPTY = "משתמש לא נוצר בייבוא. בשורות האלה לא ייקבע אחראי, והשורה תיובא.";
export const NAMES_CREATED = (count: number) =>
  count === 0 ? "לא נוצרו שמות חדשים." : count === 1 ? "נוצר שם חדש אחד ברשימות." : `נוצרו ${formatNumber(count)} שמות חדשים ברשימות.`;

/** What creating the missing names did: how many were made, and each name that was not (with the reason). */
export type NameFailure = { kind: "status" | "source" | "stage"; name: string; message: string };
export type CreatedNames = { created: number; failed: NameFailure[] };
