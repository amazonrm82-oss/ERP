import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseSmsBalance, type SmsBalance } from "./packs";

/** SMS-06: the business's SMS balance and its last movements, for owners and admins (null for anyone else). */
export async function getSmsBalance(orgId: string): Promise<SmsBalance | null> {
  const supabase = await createClient();
  return parseSmsBalance(must(await supabase.rpc("sms_balance_summary", { p_org: orgId }), "sms balance"));
}

/** SMS-06: the balance as platform staff see it (the admin's organization card). */
export async function getPlatformSmsBalance(orgId: string): Promise<SmsBalance | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_sms_balance", { p_org: orgId });
  if (error) return null;
  return parseSmsBalance(data);
}
