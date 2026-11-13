import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseEmailHealth, type EmailHealth } from "./email-health";
import { parseAdminSupportList, SUPPORT_LIST_PAGE, type AdminSupportList } from "./support-requests";

/** ADM-05: support requests, newest first, optionally of one status (platform owner and support). */
export async function listAdminSupportRequests(status: string | null, page: number): Promise<AdminSupportList> {
  const supabase = await createClient();
  return parseAdminSupportList(
    must(
      await supabase.rpc("platform_list_support_requests", { p_status: status, p_limit: SUPPORT_LIST_PAGE, p_offset: (page - 1) * SUPPORT_LIST_PAGE }),
      "platform_list_support_requests",
    ),
  );
}

export type SupportCounts = { open: number; inProgress: number };

/** ADM-05 (owner (48) ג): the dashboard's counter. */
export async function getSupportRequestCounts(): Promise<SupportCounts> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("platform_support_request_counts"), "platform_support_request_counts");
  const row = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { open: Number(row.open) || 0, inProgress: Number(row.in_progress) || 0 };
}

/** EML-01 owner (7) ב: emails stopped by a refused Resend key in the last 24 hours (platform owner and support). */
export async function getEmailHealth(): Promise<EmailHealth> {
  const supabase = await createClient();
  return parseEmailHealth(must(await supabase.rpc("platform_email_health"), "platform_email_health"));
}
