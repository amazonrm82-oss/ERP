import "server-only";

import { cache } from "react";

import type { Json, PlatformRole, PlanRow } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

import type { AdminSubprocessor } from "./subprocessors";
import type { AdminVatRate } from "./vat-rates";

export type PlatformMe = { role: PlatformRole; needsMfa: boolean };

type Obj = Record<string, unknown>;
const obj = (value: Json | null): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

/** The caller's platform role, or null for everyone else. Memoized per request. */
export const getPlatformMe = cache(async (): Promise<PlatformMe | null> => {
  const supabase = await createClient();
  const data = must(await supabase.rpc("platform_me"), "platform_me");
  const me = obj(data);
  if (typeof me.role !== "string") return null;
  return { role: me.role as PlatformRole, needsMfa: me.needs_mfa === true };
});

/**
 * For each admin page: the caller's platform role once they passed the second
 * step, else null (the page renders nothing; the layout shows the gate or a 404).
 * Pages check this themselves: Next renders a page in parallel with its layout.
 */
export async function platformReady(): Promise<PlatformMe | null> {
  const me = await getPlatformMe();
  return me && !me.needsMfa ? me : null;
}

async function call(
  name: "platform_metrics" | "platform_staff_list" | "platform_plan_waitlist" | "platform_consent_health" | "platform_trial_end_status" | "platform_suspension_cancel_status"
    | "platform_suspended_lead_notices_status",
): Promise<Json> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

export async function getPlatformMetrics(): Promise<Obj> {
  return obj(await call("platform_metrics"));
}

/** How many people asked "עדכנו אותי כשזה זמין", per plan key. */
export async function getPlanWaitlistCounts(): Promise<Record<string, number>> {
  const data = obj(await call("platform_plan_waitlist"));
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Number(value) || 0]));
}

export type ConsentHealth = { keyPresent: boolean; pendingErasures: number; erasuresStopped: number; unhashedOptOuts: number; erasureFailures7d: number };

/** The consent hash key and paused privacy erasures (CNS, owner's decision of 13 October 2026). */
export async function getConsentHealth(): Promise<ConsentHealth> {
  const h = obj(await call("platform_consent_health"));
  const n = (value: unknown) => Number(value ?? 0) || 0;
  return {
    keyPresent: h.key_present === true,
    pendingErasures: n(h.pending_erasures),
    erasuresStopped: n(h.erasures_stopped),
    unhashedOptOuts: n(h.unhashed_optouts_total),
    erasureFailures7d: n(h.erasure_failures_last_7d),
  };
}

/** The panel's warning lines; empty when all is well. Plain Hebrew, no personal data. */
export function consentHealthWarnings(h: ConsentHealth): string[] {
  const lines: string[] = [];
  if (!h.keyPresent) lines.push("מפתח ההסכמות חסר");
  if (h.pendingErasures > 0) lines.push(`${h.pendingErasures} מחיקות ממתינות`);
  if (h.erasureFailures7d > 0) lines.push(`${h.erasureFailures7d} כשלים בהשלמת מחיקה בשבוע האחרון`);
  if (h.erasuresStopped > 0) lines.push(`${h.erasuresStopped} מחיקות שהפסיקו לנסות להשלים (נדרש טיפול)`);
  if (h.unhashedOptOuts > 0) lines.push(`${h.unhashedOptOuts} בקשות הסרה שעוד לא ניתן לבדוק`);
  return lines;
}

/** BIL-08: the trial-end switch and how many businesses it covers. */
export type TrialEndStatus = { enabled: boolean; enabledAt: string | null; waiting: number; inGrace: number; readOnly: number; closed: number; assigned: number };

export async function getTrialEndStatus(): Promise<TrialEndStatus> {
  const data = obj(await call("platform_trial_end_status"));
  const n = (value: unknown) => Number(value) || 0;
  return {
    enabled: data.enabled === true,
    enabledAt: typeof data.enabled_at === "string" ? data.enabled_at : null,
    waiting: n(data.waiting),
    inGrace: n(data.in_grace),
    readOnly: n(data.read_only),
    closed: n(data.closed),
    assigned: n(data.assigned),
  };
}

/** BIL-09: the switch that cancels a business 90 days after it was suspended, and what it covers. */
export type SuspensionCancelStatus = { enabled: boolean; enabledAt: string | null; suspended: number; planned: number; cancelled: number };

export async function getSuspensionCancelStatus(): Promise<SuspensionCancelStatus> {
  const data = obj(await call("platform_suspension_cancel_status"));
  const n = (value: unknown) => Number(value) || 0;
  return {
    enabled: data.enabled === true,
    enabledAt: typeof data.enabled_at === "string" ? data.enabled_at : null,
    suspended: n(data.suspended),
    planned: n(data.planned),
    cancelled: n(data.cancelled),
  };
}

/** New-lead notices to the owner of a suspended business (0163): the switch and the leads still waiting to be told. */
export type SuspendedLeadNoticesStatus = { enabled: boolean; enabledAt: string | null; waiting: number };

export async function getSuspendedLeadNoticesStatus(): Promise<SuspendedLeadNoticesStatus> {
  const data = obj(await call("platform_suspended_lead_notices_status"));
  return {
    enabled: data.enabled === true,
    enabledAt: typeof data.enabled_at === "string" ? data.enabled_at : null,
    waiting: Number(data.waiting) || 0,
  };
}

export async function listPlatformStaff(): Promise<Obj[]> {
  return (await call("platform_staff_list")) as Obj[];
}

export type OrgListFilters = { search: string | null; status: string | null; plan: string | null; page: number };
export const ORGS_PAGE_SIZE = 50;

export async function listPlatformOrgs(filters: OrgListFilters): Promise<{ total: number; rows: Obj[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_orgs", {
    p_search: filters.search,
    p_status: filters.status,
    p_plan: filters.plan,
    p_limit: ORGS_PAGE_SIZE,
    p_offset: (filters.page - 1) * ORGS_PAGE_SIZE,
  });
  if (error) throw new Error(`platform_list_orgs failed: ${error.message}`);
  const result = obj(data);
  return { total: Number(result.total ?? 0), rows: (result.rows as Obj[]) ?? [] };
}

export async function getPlatformOrg(orgId: string): Promise<Obj | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_org", { p_org: orgId });
  if (error) throw new Error(`platform_org failed: ${error.message}`);
  return data ? obj(data) : null;
}

/** BIZ-03 (owner, 27 October 2026, answer (ה)): whether the platform switched off the business's external QR links. */
export type QrExternalBlock = { blocked: boolean; reason: string | null; changedAt: string | null };

export async function getQrExternalBlock(orgId: string): Promise<QrExternalBlock> {
  const supabase = await createClient();
  const data = obj(must(await supabase.rpc("platform_qr_external_block", { p_org: orgId }), "platform_qr_external_block"));
  return {
    blocked: data.blocked === true,
    reason: typeof data.reason === "string" ? data.reason : null,
    changedAt: typeof data.changed_at === "string" ? data.changed_at : null,
  };
}

export async function listPlatformLog(orgId: string | null, limit = 100): Promise<Obj[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_log_list", { p_org: orgId, p_limit: limit });
  if (error) throw new Error(`platform_log_list failed: ${error.message}`);
  return (data as Obj[]) ?? [];
}

export async function listPlans(): Promise<PlanRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("plans").select("*").order("position");
  if (error) throw new Error(`plans query failed: ${error.message}`);
  return data;
}

/** A user by email, with what support needs to check who is asking. Null when there is none. */
export async function findPlatformUser(email: string): Promise<Obj | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_find_user", { p_email: email });
  if (error) throw new Error(`platform_find_user failed: ${error.message}`);
  return data ? obj(data) : null;
}

/** ADM-01: every live VAT rate (cancelled rows left out), for the platform screen. A handful of rows. */
export async function listAdminVatRates(): Promise<AdminVatRate[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("vat_rates").select("id, effective_from, rate_bp, note").is("cancelled_at", null).order("effective_from", { ascending: false }),
    "vat rates",
  );
  return rows.map((row) => ({ id: row.id, effectiveFrom: row.effective_from, rateBp: row.rate_bp, note: row.note }));
}

/** ADM-01: every subprocessor entry, removed ones included (platform_list_subprocessors, all platform staff). */
export async function listAdminSubprocessors(): Promise<AdminSubprocessor[]> {
  const supabase = await createClient();
  const rows = must(await supabase.rpc("platform_list_subprocessors"), "platform_list_subprocessors");
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    dataCategories: row.data_categories,
    location: row.location,
    website: row.website,
    effectiveFrom: row.effective_from,
    endsOn: row.ends_on,
    cancelled: row.cancelled_at !== null,
  }));
}

/** ADM-01: how many notices an announcement would send now (platform owner only). */
export async function subprocessorAudience(): Promise<number> {
  const supabase = await createClient();
  return must(await supabase.rpc("platform_subprocessor_audience"), "platform_subprocessor_audience");
}
