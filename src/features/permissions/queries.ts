import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isMemberPermission, type MemberPermission } from "./keys";

/**
 * PRM-01: the keys the signed-in user holds in this business (every key for owners
 * and admins; the granted ones for a manager or member while the plan holds the
 * capability; none for a viewer or a support session). For the screens only: the
 * database checks every action again. Read once per request.
 */
export const getMyPermissions = cache(async (orgId: string): Promise<MemberPermission[]> => {
  const supabase = await createClient();
  const data = must(await supabase.rpc("my_permissions", { p_org: orgId }), "my_permissions");
  return (data ?? []).filter(isMemberPermission);
});

/** Owners and admins: the granted keys of every member who has a row, by user id. */
export async function getMemberPermissions(orgId: string): Promise<Map<string, MemberPermission[]>> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("member_permissions").select("user_id, permissions").eq("organization_id", orgId),
    "member_permissions",
  );
  return new Map((rows ?? []).map((row) => [row.user_id, row.permissions.filter(isMemberPermission)]));
}
