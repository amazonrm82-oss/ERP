import "server-only";

import type { MembershipRole } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type MyOrganization = { id: string; name: string; role: MembershipRole };

/** Organizations the user is an active member of, oldest membership first. */
export async function listMyOrganizations(userId: string): Promise<MyOrganization[]> {
  const supabase = await createClient();

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("organization_id, role, created_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`memberships query failed: ${error.message}`);
  }
  if (memberships.length === 0) {
    return [];
  }

  const { data: organizations, error: orgError } = await supabase
    .from("organizations")
    .select("id, name")
    .in(
      "id",
      memberships.map((m) => m.organization_id),
    )
    .is("deleted_at", null);
  if (orgError) {
    throw new Error(`organizations query failed: ${orgError.message}`);
  }

  const names = new Map(organizations.map((org) => [org.id, org.name]));
  return memberships.flatMap((m) => {
    const name = names.get(m.organization_id);
    return name === undefined ? [] : [{ id: m.organization_id, name, role: m.role }];
  });
}
