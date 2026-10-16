import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { QrTargetKind } from "./model";

export type QrCode = {
  id: string;
  name: string;
  kind: QrTargetKind;
  // null when the target was deleted
  targetId: string | null;
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
      .select("id, name, target_kind, form_id, booking_page_id, token, is_active, created_at")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    "qr_codes",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.target_kind === "booking" ? "booking" : "form",
    targetId: row.target_kind === "booking" ? row.booking_page_id : row.form_id,
    token: row.token,
    isActive: row.is_active,
    createdAt: row.created_at,
  }));
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

/** What a code may open: the business's web forms and booking pages (an inactive one is listed and marked). */
export async function listQrTargets(orgId: string): Promise<{ forms: QrTargetOption[]; pages: QrTargetOption[] }> {
  const supabase = await createClient();
  const [forms, pages] = await Promise.all([
    supabase.from("forms").select("id, name, is_active").eq("organization_id", orgId).eq("kind", "form").order("name").order("id"),
    supabase.from("booking_pages").select("id, title, is_active").eq("organization_id", orgId).order("title").order("id"),
  ]);
  return {
    forms: must(forms, "forms").map((f) => ({ value: `form:${f.id}`, label: f.name, active: f.is_active })),
    pages: must(pages, "booking_pages").map((p) => ({ value: `booking:${p.id}`, label: p.title, active: p.is_active })),
  };
}
