import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type WhatsappTemplate = { id: string; name: string; body: string; position: number; kind: string | null };

/** Every WhatsApp template of the organization, in the order the admin set (WA-01). */
export async function listWhatsappTemplates(orgId: string): Promise<WhatsappTemplate[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("whatsapp_templates")
        .select("id, name, body, position, kind, created_at")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      "whatsapp templates",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, body: row.body, position: row.position, kind: row.kind }));
}
