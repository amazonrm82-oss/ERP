import "server-only";

import { contactPickerName } from "@/features/contacts/picker";
import type { Json } from "@/lib/database.types";
import { isUuid, paths } from "@/lib/paths";
import { RECORD_TYPES } from "@/lib/record-types";
import { createClient } from "@/lib/supabase/server";

import {
  asCustomValues,
  type FieldDefinition,
  type FieldRef,
  type LinkTarget,
} from "./types";

// FLD-06 part B: the names a page shows for record link and file values, read with the viewer's session, so RLS decides:
// a record or a file the viewer may not read (or one in the recycle bin, or gone) gets no entry, and the value is shown
// as a neutral "רשומה" / "קובץ", never by its id or name.

// at most this many ids are read per target (a large export shows the rest neutrally), in reads of CHUNK ids
const MAX_IDS = 2000;
const CHUNK = 100;

function chunks(ids: Iterable<string>): string[][] {
  const all = [...ids].slice(0, MAX_IDS);
  const out: string[][] = [];
  for (let i = 0; i < all.length; i += CHUNK) out.push(all.slice(i, i + CHUNK));
  return out;
}

type Row = {
  id: string;
  full_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** Every record link and file id the given values hold, by field type and target. */
export function refIds(
  definitions: FieldDefinition[],
  valuesList: Array<Json | undefined>,
): { links: Map<LinkTarget, Set<string>>; files: Set<string> } {
  const links = new Map<LinkTarget, Set<string>>();
  const files = new Set<string>();
  const wanted = definitions.filter(
    (field) =>
      field.type === "file" ||
      (field.type === "record_link" && field.linkTarget),
  );
  if (wanted.length === 0) return { links, files };
  for (const raw of valuesList) {
    const values = asCustomValues(raw ?? {});
    for (const field of wanted) {
      const value = values[field.key];
      if (!isUuid(value)) continue;
      if (field.type === "file") files.add(value);
      else if (field.linkTarget) {
        const set = links.get(field.linkTarget) ?? new Set<string>();
        set.add(value);
        links.set(field.linkTarget, set);
      }
    }
  }
  return { links, files };
}

function recordLabel(target: LinkTarget, row: Row): string {
  if (target === "contact" || target === "lead") {
    return contactPickerName({
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      phone: row.phone ?? null,
    });
  }
  const name = (row.name ?? "").trim();
  return name === "" ? RECORD_TYPES[target].singular : name;
}

async function readRefs(
  orgId: string,
  links: Map<LinkTarget, Set<string>>,
  files: Set<string>,
): Promise<Map<string, FieldRef>> {
  const supabase = await createClient();
  const refs = new Map<string, FieldRef>();
  const reads: Array<PromiseLike<void>> = [];
  for (const [target, set] of links) {
    for (const ids of chunks(set)) {
      const columns =
        target === "contact" || target === "lead"
          ? "id, full_name, email, phone"
          : "id, name";
      reads.push(
        supabase
          .from(
            RECORD_TYPES[target].table as
              | "leads"
              | "contacts"
              | "companies"
              | "deals",
          )
          .select(columns)
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .in("id", ids)
          .then(({ data, error }) => {
            // a failed read shows the neutral words; the page itself still works
            if (error || !data) return;
            for (const row of data as unknown as Row[]) {
              const page = RECORD_TYPES[target].page;
              refs.set(row.id, {
                label: recordLabel(target, row),
                href: page ? page(orgId, row.id) : null,
              });
            }
          }),
      );
    }
  }
  for (const ids of chunks(files)) {
    reads.push(
      supabase
        .from("files")
        .select("id, name")
        .eq("organization_id", orgId)
        .is("unconfirmed_since", null)
        .in("id", ids)
        .then(({ data, error }) => {
          if (error || !data) return;
          for (const row of data)
            refs.set(row.id, {
              label: row.name,
              href: paths.file(orgId, row.id),
            });
        }),
    );
  }
  await Promise.all(reads);
  return refs;
}

/**
 * The definitions with `refs` filled for the record link and file values of these records (a page's rows, one record's
 * values). Definitions without such fields come back as they are, without a read.
 */
export async function withFieldRefs(
  orgId: string,
  definitions: FieldDefinition[],
  valuesList: Array<Json | undefined>,
): Promise<FieldDefinition[]> {
  const { links, files } = refIds(definitions, valuesList);
  if (links.size === 0 && files.size === 0) return definitions;
  const refs = await readRefs(orgId, links, files);
  return definitions.map((field) => {
    if (field.type !== "record_link" && field.type !== "file") return field;
    const own: Record<string, FieldRef> = {};
    for (const raw of valuesList) {
      const value = asCustomValues(raw ?? {})[field.key];
      if (typeof value === "string" && refs.has(value))
        own[value] = refs.get(value) as FieldRef;
    }
    return { ...field, refs: own };
  });
}

/**
 * FLD-06 part B (review F4): the keys of the record link values in `values` that this user cannot use on a new record
 * (the linked record is gone, in the recycle bin, or not readable by them): a copy leaves them out and names them.
 */
export async function unusableLinkKeys(orgId: string, definitions: FieldDefinition[], values: Record<string, Json>): Promise<string[]> {
  const links = definitions.filter((field) => field.type === "record_link" && field.key in values);
  if (links.length === 0) return [];
  const { links: ids } = refIds(links, [values]);
  const refs = await readRefs(orgId, ids, new Set());
  return links.filter((field) => {
    const value = values[field.key];
    return !field.linkTarget || typeof value !== "string" || !refs.has(value);
  }).map((field) => field.key);
}
