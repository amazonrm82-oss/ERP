import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

import { deletionStatusFrom, NO_DELETION, type OrgDeletionStatus } from "./texts";

/**
 * ADM-03: the business's deletion state, read with the user's session (members). Once per request; a failed read shows
 * nothing (the business shell never breaks over it; the read-only rule itself lives in the database).
 */
export const getOrgDeletionStatus = cache(async (orgId: string): Promise<OrgDeletionStatus> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("org_deletion_status", { p_org: orgId });
    return error ? NO_DELETION : deletionStatusFrom(data);
  } catch {
    return NO_DELETION;
  }
});
