import "server-only";

import { must } from "@/lib/db-read";
import type { BusinessCardField } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

import { CARD_FIELD_KEYS } from "./model";

export type BusinessCard = {
  id: string;
  userId: string;
  token: string;
  isActive: boolean;
  jobTitle: string | null;
  about: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  publicFields: BusinessCardField[];
};

/** The cards the user may see: their own, and (owners and admins) everyone's. RLS decides. */
export async function listBusinessCards(orgId: string): Promise<BusinessCard[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("business_cards")
      .select("id, user_id, token, is_active, job_title, about, phone, email, website, public_fields")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    "business_cards",
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    token: row.token,
    isActive: row.is_active,
    jobTitle: row.job_title,
    about: row.about,
    phone: row.phone,
    email: row.email,
    website: row.website,
    publicFields: row.public_fields.filter((f): f is BusinessCardField => (CARD_FIELD_KEYS as string[]).includes(f)),
  }));
}
