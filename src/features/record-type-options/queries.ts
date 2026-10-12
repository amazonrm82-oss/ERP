import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { RecordType, RecordTypeObject } from "./schema";

/** Every type of the organization for contacts or companies, hidden ones included, in the order the admin set. */
export const listRecordTypes = cache(async (orgId: string, object: RecordTypeObject): Promise<RecordType[]> => {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("record_type_options")
        .select("id, name, position, is_active, created_at")
        .eq("organization_id", orgId)
        .eq("object_type", object)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      "record types",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position, isActive: row.is_active }));
});

/** Type names by id, for list rows and cards. */
export async function recordTypeNames(orgId: string, object: RecordTypeObject): Promise<Map<string, string>> {
  return new Map((await listRecordTypes(orgId, object)).map((type) => [type.id, type.name]));
}
