import "server-only";

import { isMessageChannel, isMessageType, type MessageChannel, type MessageType } from "@/features/messaging/providers/types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type MessageTemplate = {
  id: string;
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string | null;
  body: string;
  locale: string;
  isActive: boolean;
  // SGN-03 review M1: the system's own mark (server only); such a template is sent by its own job, never from a card
  noticeKind: string | null;
};

/** Every message template of the business (MSG-02), by channel then name, with the user's session (members read). */
export async function listMessageTemplates(orgId: string): Promise<MessageTemplate[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("message_templates")
        .select("id, name, channel, message_type, subject, body, locale, is_active, notice_kind")
        .eq("organization_id", orgId)
        .order("channel", { ascending: true })
        .order("name", { ascending: true })
        .order("id", { ascending: true }),
      "message templates",
    ) ?? [];
  // the table's checks hold the same closed lists; a row outside them (none can exist) is skipped
  return rows.flatMap((row) => {
    if (!isMessageChannel(row.channel) || !isMessageType(row.message_type)) return [];
    return [
      {
        id: row.id,
        name: row.name,
        channel: row.channel,
        messageType: row.message_type,
        subject: row.subject,
        body: row.body,
        locale: row.locale,
        isActive: row.is_active,
        noticeKind: row.notice_kind,
      },
    ];
  });
}
