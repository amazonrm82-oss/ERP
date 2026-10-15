import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isMeetingFormat, meetingTypeColor, type MeetingTypeChoice } from "./schema";

/** A meeting type with its linked service, as the settings page shows it. */
export type MeetingTypeItem = MeetingTypeChoice & {
  position: number;
  productId: string | null;
  // the linked product's name and whether it can still be offered; null when none or not readable
  product: { id: string; name: string; offerable: boolean } | null;
};

/** Every meeting type of the organization, in the order the admin set (CAL-08); members read them all (RLS). */
export async function listMeetingTypes(orgId: string): Promise<MeetingTypeItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("meeting_types")
      .select(
        "id, name, duration_minutes, meeting_format, location, product_id, buffer_before_minutes, buffer_after_minutes, color, position, is_active, created_at",
      )
      .eq("organization_id", orgId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    "meeting types",
  );
  const productIds = [...new Set(rows.map((row) => row.product_id).filter((id): id is string => id !== null))];
  const products =
    productIds.length > 0
      ? must(
          await supabase.from("products").select("id, name, is_active, archived_at").eq("organization_id", orgId).in("id", productIds),
          "meeting type services",
        )
      : [];
  const byId = new Map(products.map((p) => [p.id, { id: p.id, name: p.name, offerable: p.is_active && p.archived_at === null }]));
  return rows.map((row) => ({
    ...toChoice(row),
    position: row.position,
    productId: row.product_id,
    product: row.product_id ? (byId.get(row.product_id) ?? null) : null,
  }));
}

/** The types a meeting form picks from (all of them; the form offers the active ones and the meeting's own). */
export async function listMeetingTypeChoices(orgId: string): Promise<MeetingTypeChoice[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("meeting_types")
      .select("id, name, duration_minutes, meeting_format, location, buffer_before_minutes, buffer_after_minutes, color, is_active, position, created_at")
      .eq("organization_id", orgId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    "meeting types",
  );
  return rows.map(toChoice);
}

type ChoiceRow = {
  id: string;
  name: string;
  duration_minutes: number;
  meeting_format: string | null;
  location: string | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  color: string | null;
  is_active: boolean;
};

function toChoice(row: ChoiceRow): MeetingTypeChoice {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    format: isMeetingFormat(row.meeting_format) ? row.meeting_format : null,
    location: row.location,
    bufferBefore: row.buffer_before_minutes,
    bufferAfter: row.buffer_after_minutes,
    color: meetingTypeColor(row.color),
    isActive: row.is_active,
  };
}
