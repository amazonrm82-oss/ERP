import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { TrashableTable } from "@/lib/record-trash";
import { createClient } from "@/lib/supabase/server";

export type TrashedRecord = {
  table: TrashableTable;
  id: string;
  name: string;
  deletedAt: string;
  ownerName: string | null;
};

const PER_KIND = 100;

/** Records in the recycle bin that the user may see, newest first (up to 100 of each kind). */
export async function listTrash(orgId: string): Promise<TrashedRecord[]> {
  const supabase = await createClient();
  const [leads, contacts, companies, deals] = await Promise.all([
    supabase
      .from("leads")
      .select("id, full_name, email, phone, owner_id, deleted_at")
      .eq("organization_id", orgId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(PER_KIND),
    supabase
      .from("contacts")
      .select("id, full_name, email, phone, owner_id, deleted_at")
      .eq("organization_id", orgId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(PER_KIND),
    supabase
      .from("companies")
      .select("id, name, owner_id, deleted_at")
      .eq("organization_id", orgId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(PER_KIND),
    supabase
      .from("deals")
      .select("id, name, owner_id, deleted_at")
      .eq("organization_id", orgId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false })
      .limit(PER_KIND),
  ]);
  for (const result of [leads, contacts, companies, deals]) {
    if (result.error) {
      throw new Error(`trash query failed: ${result.error.message}`);
    }
  }

  const person = (row: { full_name: string | null; email: string | null; phone: string | null }) =>
    row.full_name || row.email || row.phone || "ללא שם";
  const records: Array<Omit<TrashedRecord, "ownerName"> & { ownerId: string | null }> = [
    ...(leads.data ?? []).map((row) => ({ table: "leads" as const, id: row.id, name: person(row), deletedAt: row.deleted_at!, ownerId: row.owner_id })),
    ...(contacts.data ?? []).map((row) => ({ table: "contacts" as const, id: row.id, name: person(row), deletedAt: row.deleted_at!, ownerId: row.owner_id })),
    ...(companies.data ?? []).map((row) => ({ table: "companies" as const, id: row.id, name: row.name, deletedAt: row.deleted_at!, ownerId: row.owner_id })),
    ...(deals.data ?? []).map((row) => ({ table: "deals" as const, id: row.id, name: row.name, deletedAt: row.deleted_at!, ownerId: row.owner_id })),
  ];
  const owners = await getUserNames(records.map((record) => record.ownerId));

  return records
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
    .map(({ ownerId, ...record }) => ({ ...record, ownerName: ownerId ? (owners.get(ownerId) ?? null) : null }));
}
