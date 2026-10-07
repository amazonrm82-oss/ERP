import "server-only";

import type { MembershipRole } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type InvitationPreview = {
  organizationName: string | null;
  role: MembershipRole;
  invitedBy: string | null;
  expiresAt: string;
  status: "valid" | "expired" | "revoked" | "accepted";
  forMe: boolean;
  emailHint: string;
  alreadyMember: boolean;
};

/** What the invitation is for, as the database tells the holder of the link. Null for an unknown token. */
export async function getInvitationPreview(token: string): Promise<InvitationPreview | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("invitation_preview", { p_token: token });
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  return {
    organizationName: typeof r.organization_name === "string" ? r.organization_name : null,
    role: r.role as MembershipRole,
    invitedBy: typeof r.invited_by === "string" ? r.invited_by : null,
    expiresAt: String(r.expires_at),
    status: (["valid", "expired", "revoked", "accepted"].includes(String(r.status)) ? r.status : "expired") as InvitationPreview["status"],
    forMe: r.for_me === true,
    emailHint: String(r.email_hint ?? ""),
    alreadyMember: r.already_member === true,
  };
}
