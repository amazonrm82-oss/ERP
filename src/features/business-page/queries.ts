import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

/** BIZ-01: the business page's settings as the settings screen shows them (owners and admins only, by RLS). */
export type BusinessPageSettings = {
  id: string;
  token: string;
  isActive: boolean;
  about: string | null;
  showPhone: boolean;
  showWhatsapp: boolean;
  showWebsite: boolean;
  showHours: boolean;
  showForm: boolean;
  bookingPageIds: string[];
  /** BIZ-01 (314) ב: who gets the form's leads (null and null = the business's regular distribution) */
  ownerUserId: string | null;
  teamId: string | null;
};

export async function getBusinessPage(orgId: string): Promise<BusinessPageSettings | null> {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("business_pages")
      .select("id, token, is_active, about, show_phone, show_whatsapp, show_website, show_hours, show_form, booking_page_ids, owner_user_id, team_id")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "business page",
  );
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    isActive: row.is_active,
    about: row.about,
    showPhone: row.show_phone,
    showWhatsapp: row.show_whatsapp,
    showWebsite: row.show_website,
    showHours: row.show_hours,
    showForm: row.show_form,
    bookingPageIds: row.booking_page_ids ?? [],
    ownerUserId: row.owner_user_id,
    teamId: row.team_id,
  };
}

/** The business's own details the page shows (the same row the business details screen edits). */
export async function getBusinessPageSource(orgId: string): Promise<{ phone: string | null; website: string | null }> {
  const supabase = await createClient();
  const row = must(await supabase.from("organizations").select("phone, website").eq("id", orgId).maybeSingle(), "business details");
  return { phone: row?.phone ?? null, website: row?.website ?? null };
}
