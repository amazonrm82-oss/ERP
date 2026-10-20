import "server-only";

import { getOrgTerms } from "@/features/terminology/queries";
import { DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { notificationHref } from "./links";
import { notificationText } from "./notification-text";
import { NOTIFICATION_KINDS, type NotificationSettings } from "./settings";
import { must } from "@/lib/db-read";

export type NotificationView = {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  // formatted on the server so server and browser output cannot differ
  when: string;
  createdAt: string;
};

const COLUMNS = "id, type, title, body, entity_type, entity_id, read_at, created_at";

type Row = { id: string; type: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null; read_at: string | null; created_at: string };

/** FLD-10 part three: the title and body are redrawn in the business's words (notification-text.ts). */
export function toNotificationView(orgId: string, row: Row, terms: OrgTerms = DEFAULT_TERMS): NotificationView {
  const text = notificationText(row, terms);
  return {
    id: row.id,
    title: text.title,
    body: text.body,
    href: notificationHref(orgId, row.entity_type, row.entity_id),
    read: row.read_at !== null,
    when: formatDateTime(row.created_at),
    createdAt: row.created_at,
  };
}

/** The user's latest notifications in this organization (RLS: only their own). */
export async function listNotifications(orgId: string, userId: string, limit: number): Promise<NotificationView[]> {
  const supabase = await createClient();
  const [terms, { data, error }] = await Promise.all([
    getOrgTerms(orgId),
    supabase
    .from("notifications")
    .select(COLUMNS)
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit),
  ]);
  if (error) {
    throw new Error(`notifications query failed: ${error.message}`);
  }
  return data.map((row) => toNotificationView(orgId, row, terms));
}

export async function countUnread(orgId: string, userId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) {
    throw new Error(`unread count failed: ${error.message}`);
  }
  return count ?? 0;
}

/** The signed-in user's choices; a kind with no choice gets everything. */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const supabase = await createClient();
  const data = must(await supabase.from("notification_settings").select("muted, no_push").maybeSingle(), "notification_settings");
  const settings = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k.key, "all"])) as NotificationSettings;
  for (const kind of NOTIFICATION_KINDS) {
    if (data?.no_push.includes(kind.key)) settings[kind.key] = "bell";
    if (data?.muted.includes(kind.key)) settings[kind.key] = "off";
  }
  return settings;
}
