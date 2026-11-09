import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { DEFAULT_WINDOW_FROM, DEFAULT_WINDOW_UNTIL, shortTime, type SendingHours } from "./hours";
import { parseMessageUsage, type MessageUsage } from "./usage";

/** MSG-06: the business's sending hours; members read them, no row = 08:00-20:00 with rest days off. */
export const getSendingHours = cache(async (orgId: string): Promise<SendingHours> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_message_settings").select("window_from, window_until, skip_rest_days").eq("organization_id", orgId).maybeSingle(),
    "message settings",
  );
  return {
    from: shortTime(row?.window_from, DEFAULT_WINDOW_FROM),
    until: shortTime(row?.window_until, DEFAULT_WINDOW_UNTIL),
    skipRestDays: row?.skip_rest_days ?? true,
  };
});

export type MessageCaps = { email: number | null; sms: number | null; whatsapp: number | null };

/** MSG-05: the business's monthly caps of marketing messages (null = none). */
export const getMessageCaps = cache(async (orgId: string): Promise<MessageCaps> => {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("org_message_settings")
      .select("monthly_cap_email, monthly_cap_sms, monthly_cap_whatsapp")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "message caps",
  );
  return { email: row?.monthly_cap_email ?? null, sms: row?.monthly_cap_sms ?? null, whatsapp: row?.monthly_cap_whatsapp ?? null };
});

/** MSG-05: this month's usage per channel (public.message_usage; owners and admins, anyone else gets allowed: false). */
export async function getMessageUsage(orgId: string): Promise<MessageUsage> {
  const supabase = await createClient();
  return parseMessageUsage(must(await supabase.rpc("message_usage", { p_org: orgId }), "message usage"));
}

export type MeetingMessages = { confirm: boolean; day: boolean; hour: boolean };

/** CAL-12: the business's meeting messages to the customer (no row = all off). */
export const getMeetingMessages = cache(async (orgId: string): Promise<MeetingMessages> => {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("org_message_settings")
      .select("meeting_confirm, meeting_remind_day, meeting_remind_hour")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "meeting messages",
  );
  return { confirm: row?.meeting_confirm ?? false, day: row?.meeting_remind_day ?? false, hour: row?.meeting_remind_hour ?? false };
});
