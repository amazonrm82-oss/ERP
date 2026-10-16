import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { WidgetPosition } from "./public";

export type SiteWidget = {
  id: string;
  name: string;
  token: string;
  isActive: boolean;
  buttonLabel: string;
  showWhatsapp: boolean;
  showCall: boolean;
  showForm: boolean;
  phone: string | null;
  position: WidgetPosition;
  assignMode: "owner" | "round_robin";
  ownerId: string | null;
  teamId: string | null;
};

/** The business's widgets (owners and admins; RLS decides). */
export async function listSiteWidgets(orgId: string): Promise<SiteWidget[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("site_widgets")
      .select("id, name, token, is_active, button_label, show_whatsapp, show_call, show_form, phone, position, assign_mode, owner_id, team_id")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    "site_widgets",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    token: row.token,
    isActive: row.is_active,
    buttonLabel: row.button_label,
    showWhatsapp: row.show_whatsapp,
    showCall: row.show_call,
    showForm: row.show_form,
    phone: row.phone,
    position: row.position === "right" ? "right" : "left",
    assignMode: row.assign_mode === "owner" ? "owner" : "round_robin",
    ownerId: row.owner_id,
    teamId: row.team_id,
  }));
}
