import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

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
