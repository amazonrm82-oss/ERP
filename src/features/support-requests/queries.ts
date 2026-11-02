import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type SupportRequestItem = {
  id: string;
  userId: string | null;
  category: string;
  subject: string;
  message: string;
  pagePath: string | null;
  status: string;
  createdAt: string;
  statusChangedAt: string | null;
};

/**
 * USR-12: the requests this person may read in the business, newest first: their own, or (owners and admins) all of
 * the business's. RLS decides; the latest 50.
 */
export async function listSupportRequests(orgId: string): Promise<SupportRequestItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("support_requests")
      .select("id, user_id, category, subject, message, page_path, status, created_at, status_changed_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(50),
    "support_requests",
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    category: row.category,
    subject: row.subject,
    message: row.message,
    pagePath: row.page_path,
    status: row.status,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
  }));
}
