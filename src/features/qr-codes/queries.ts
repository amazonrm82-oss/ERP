import "server-only";

import { listMembers } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { QrTargetKind } from "./model";

const KINDS: readonly QrTargetKind[] = ["form", "booking", "card", "url"];

export type QrCode = {
  id: string;
  name: string;
  kind: QrTargetKind;
  // a form, booking page or business card; null when the target was deleted (and for a link)
  targetId: string | null;
  // the stored https link of a "url" code
  url: string | null;
  token: string;
  isActive: boolean;
  createdAt: string;
};

export type QrCounts = { total: number; recent: number; lastDay: string | null };

export type QrTargetOption = { value: string; label: string; active: boolean };

/** The business's codes (owners and admins; RLS decides). */
export async function listQrCodes(orgId: string): Promise<QrCode[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("qr_codes")
      .select("id, name, target_kind, form_id, booking_page_id, business_card_id, target_url, token, is_active, created_at")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    "qr_codes",
  );
  return rows.map((row) => {
    const kind = (KINDS as string[]).includes(row.target_kind) ? (row.target_kind as QrTargetKind) : "form";
    return {
      id: row.id,
      name: row.name,
      kind,
      targetId: kind === "booking" ? row.booking_page_id : kind === "card" ? row.business_card_id : kind === "url" ? null : row.form_id,
      url: kind === "url" ? row.target_url : null,
      token: row.token,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  });
}

/** Scans per code: all time and the last `days` days (the business's zone). Codes with no scan are missing. */
export async function qrScanCounts(orgId: string, days = 30): Promise<Map<string, QrCounts>> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("qr_code_scans", { p_org: orgId, p_days: days }), "qr_code_scans");
  const counts = new Map<string, QrCounts>();
  for (const row of Array.isArray(data) ? data : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.qr_code_id !== "string") continue;
    counts.set(r.qr_code_id, {
      total: Number(r.total) || 0,
      recent: Number(r.recent) || 0,
      lastDay: typeof r.last_day === "string" ? r.last_day : null,
    });
  }
  return counts;
}

/**
 * What a code may open: the business's web forms and booking pages (an inactive one is listed and marked), and the reps'
 * business cards the user sees (owners and admins see every card; RLS decides). A card counts as active while its own page
 * would show it: on, and its rep an active member who is not a viewer (the plan flag is shown on the card's own screen).
 */
export async function listQrTargets(
  orgId: string,
): Promise<{ forms: QrTargetOption[]; pages: QrTargetOption[]; cards: QrTargetOption[] }> {
  const supabase = await createClient();
  const [forms, pages, cards, members] = await Promise.all([
    supabase.from("forms").select("id, name, is_active").eq("organization_id", orgId).eq("kind", "form").order("name").order("id"),
    supabase.from("booking_pages").select("id, title, is_active").eq("organization_id", orgId).order("title").order("id"),
    supabase.from("business_cards").select("id, user_id, is_active").eq("organization_id", orgId).order("created_at").order("id"),
    listMembers(orgId),
  ]);
  const people = new Map(members.map((m) => [m.userId, m]));
  return {
    forms: must(forms, "forms").map((f) => ({ value: `form:${f.id}`, label: f.name, active: f.is_active })),
    pages: must(pages, "booking_pages").map((p) => ({ value: `booking:${p.id}`, label: p.title, active: p.is_active })),
    cards: must(cards, "business_cards")
      .map((c) => {
        const rep = people.get(c.user_id);
        return {
          value: `card:${c.id}`,
          label: rep?.name ?? "נציג",
          active: c.is_active && rep?.status === "active" && rep.role !== "viewer",
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "he")),
  };
}

/**
 * BIZ-03 (owner, 27 October 2026, answer (ה)): true while the platform has switched off the business's external links. The
 * database answers one boolean, and only to a member of the business.
 */
export async function qrExternalBlocked(orgId: string): Promise<boolean> {
  const supabase = await createClient();
  return must(await supabase.rpc("qr_external_blocked", { p_org: orgId }), "qr_external_blocked") === true;
}
