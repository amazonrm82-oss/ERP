import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { choiceFromProfile, type ThemeChoice } from "@/features/theme/theme";

import { AVATARS_BUCKET } from "./avatar";
import { readWorkingHours, type WorkingHours } from "./working-hours";

export type MyProfile = {
  fullName: string;
  phone: string;
  locale: string;
  // null: the organization's time zone applies
  timeZone: string | null;
  // null: not set yet
  workingHours: WorkingHours | null;
  signature: string;
  // a short-lived signed link to the photo, or null
  avatarUrl: string | null;
  // USR-07: light, dark or by the device
  theme: ThemeChoice;
};

/** The signed-in user's own profile, for "החשבון שלי". */
export async function getMyProfile(userId: string): Promise<MyProfile> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("profiles").select("full_name, phone, locale, timezone, working_hours, signature, avatar_url, theme").eq("id", userId).maybeSingle(),
    "profiles",
  );
  let avatarUrl: string | null = null;
  if (row?.avatar_url) {
    // the photo is a nicety: without a link the page shows initials
    const { data, error } = await supabase.storage.from(AVATARS_BUCKET).createSignedUrl(row.avatar_url, 300);
    avatarUrl = error ? null : (data?.signedUrl ?? null);
  }
  return {
    fullName: row?.full_name ?? "",
    phone: row?.phone ?? "",
    locale: row?.locale ?? "he",
    timeZone: row?.timezone ?? null,
    workingHours: readWorkingHours(row?.working_hours ?? null),
    signature: row?.signature ?? "",
    avatarUrl,
    theme: choiceFromProfile(row?.theme),
  };
}
