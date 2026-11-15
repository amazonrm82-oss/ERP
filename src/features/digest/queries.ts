import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { digestSettingsFromRow, type DigestSettings } from "./settings";

/** The signed-in person's own daily summary setting in this business (RLS: own row only); no row = off at 07:30. */
export async function getDigestSettings(orgId: string): Promise<DigestSettings> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("digest_settings").select("enabled, send_at, stopped_by_link_at").eq("organization_id", orgId).maybeSingle(),
    "digest_settings",
  );
  return digestSettingsFromRow(row);
}
