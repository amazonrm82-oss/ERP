import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { AGREEMENT_VERSION } from "./agreement";

/** The agreement version the signed-in user signed last, or null. Memoized per request. */
export const getSignedVersion = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data } = await supabase.rpc("agreement_status");
  return typeof data === "string" ? data : null;
});

/** Sends a user who has not signed the current agreement to sign it, then back to `next`. */
export async function requireAgreement(next: string): Promise<void> {
  if ((await getSignedVersion()) !== AGREEMENT_VERSION) {
    redirect(`${paths.agreement}?next=${encodeURIComponent(next)}`);
  }
}

export type SignedAgreement = {
  version: string;
  documents: Array<{ slug: string; title: string; version: string; text: string }>;
  contentHash: string;
  fullName: string;
  email: string;
  method: "drawn" | "typed";
  signature: string | null;
  ip: string | null;
  userAgent: string | null;
  signedAt: string;
};

export async function getMyAgreement(): Promise<SignedAgreement | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("my_agreement");
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  return {
    version: String(r.version),
    documents: Array.isArray(r.documents) ? (r.documents as SignedAgreement["documents"]) : [],
    contentHash: String(r.content_hash),
    fullName: String(r.full_name),
    email: String(r.email ?? ""),
    method: r.method === "drawn" ? "drawn" : "typed",
    signature: typeof r.signature === "string" ? r.signature : null,
    ip: typeof r.ip === "string" && r.ip ? r.ip : null,
    userAgent: typeof r.user_agent === "string" ? r.user_agent : null,
    signedAt: String(r.signed_at),
  };
}
