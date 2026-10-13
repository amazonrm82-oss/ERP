import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { Json } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

export type AuditChange = { field: string; old: Json; new: Json };

export type AuditItem = {
  id: number;
  createdAt: string;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: AuditChange[];
  // contents erased on a privacy request (migration 0027)
  erased: boolean;
};

export type AuditFilters = { entityType: string | null; actorId: string | null; from: string | null; to: string | null; page: number };

export const AUDIT_PAGE = 50;

function isErased(changes: Json): boolean {
  return !!changes && typeof changes === "object" && !Array.isArray(changes) && changes.erased === true;
}

function toChanges(action: string, changes: Json): AuditChange[] {
  if (isErased(changes)) return [];
  if (action !== "update" && action !== "trash" && action !== "restore") return [];
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.entries(changes).flatMap(([field, value]) => {
    // only {old, new} pairs are changes; a plain value is context (REC-05: which record a note was on)
    if (!value || typeof value !== "object" || Array.isArray(value) || !("old" in value || "new" in value)) return [];
    const pair = value as Record<string, Json>;
    if (field === "utm") return utmChanges(pair.old ?? null, pair.new ?? null);
    return [{ field, old: pair.old ?? null, new: pair.new ?? null }];
  });
}

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** LEAD-01: a change of leads.utm, key by key ("utm.utm_source"), only the keys that changed. */
export function utmChanges(oldValue: Json, newValue: Json): AuditChange[] {
  const before = asObject(oldValue);
  const after = asObject(newValue);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    const o = before[key] ?? null;
    const n = after[key] ?? null;
    return JSON.stringify(o) === JSON.stringify(n) ? [] : [{ field: `utm.${key}`, old: o, new: n }];
  });
}

/** How many days back the plan keeps the audit log (null: unlimited). */
async function retentionDays(orgId: string): Promise<number | null> {
  const supabase = await createClient();
  const sub = must(await supabase.from("subscriptions").select("plan_key, limit_overrides").eq("organization_id", orgId).maybeSingle(), "subscriptions");
  if (!sub) return null;
  const overrides = sub.limit_overrides as Record<string, Json> | null;
  if (overrides && "audit_log_days" in overrides) return typeof overrides.audit_log_days === "number" ? overrides.audit_log_days : null;
  const plan = must(await supabase.from("plans").select("limits").eq("key", sub.plan_key).maybeSingle(), "plans");
  const days = (plan?.limits as Record<string, Json> | undefined)?.audit_log_days;
  return typeof days === "number" ? days : null;
}

/** The organization's audit log (RLS: admins only), newest first, within the plan's window. */
export async function listAudit(orgId: string, filters: AuditFilters): Promise<{ items: AuditItem[]; more: boolean; days: number | null }> {
  const supabase = await createClient();
  const days = await retentionDays(orgId);
  let query = supabase
    .from("audit_log")
    .select("id, created_at, actor_id, action, entity_type, entity_id, changes")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((filters.page - 1) * AUDIT_PAGE, filters.page * AUDIT_PAGE);
  if (days !== null) query = query.gte("created_at", new Date(Date.now() - days * 86_400_000).toISOString());
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  if (filters.actorId) query = query.eq("actor_id", filters.actorId);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lt("created_at", filters.to);
  const { data, error } = await query;
  if (error) throw new Error(`audit query failed: ${error.message}`);
  const rows = data.slice(0, AUDIT_PAGE);
  const names = await getUserNames(rows.map((r) => r.actor_id));
  return {
    items: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      actorName: r.actor_id ? (names.get(r.actor_id) ?? "משתמש") : null,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      changes: toChanges(r.action, r.changes),
    erased: isErased(r.changes),
    })),
    more: data.length > AUDIT_PAGE,
    days,
  };
}

/** Changes of one record (admins only; others get an empty list from RLS). */
export async function listRecordHistory(orgId: string, entityType: string, entityId: string): Promise<AuditItem[]> {
  const supabase = await createClient();
  const data = must(await supabase
    .from("audit_log")
    .select("id, created_at, actor_id, action, entity_type, entity_id, changes")
    .eq("organization_id", orgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(30), "audit_log");
  const rows = data ?? [];
  const names = await getUserNames(rows.map((r) => r.actor_id));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    actorName: r.actor_id ? (names.get(r.actor_id) ?? "משתמש") : null,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    changes: toChanges(r.action, r.changes),
    erased: isErased(r.changes),
  }));
}

export type LoginEvent = { createdAt: string; action: string; ip: string | null; userName: string };

export async function listLoginEvents(orgId: string): Promise<LoginEvent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("org_login_events", { p_org: orgId, p_limit: 200 });
  if (error) return [];
  const rows = (Array.isArray(data) ? data : []) as Array<{ created_at: string; action: string; ip: string | null; user_id: string | null }>;
  const names = await getUserNames(rows.map((r) => r.user_id));
  return rows.map((r) => ({ createdAt: r.created_at, action: r.action, ip: r.ip || null, userName: r.user_id ? (names.get(r.user_id) ?? "משתמש") : "—" }));
}

export type EraseCandidate = { entityType: string; entityId: string; deletedAt: string; name: string | null; email: string | null; phone: string | null };

/** Permanently deleted leads, contacts, companies and deals in the log that match a name, phone or email. */
export async function findEraseCandidates(orgId: string, query: string): Promise<EraseCandidate[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("audit_erase_candidates", { p_org: orgId, p_query: query });
  if (error || !Array.isArray(data)) return [];
  return (data as Array<Record<string, string | null>>).map((r) => ({
    entityType: r.entity_type ?? "",
    entityId: r.entity_id ?? "",
    deletedAt: r.deleted_at ?? "",
    name: r.name || null,
    email: r.email || null,
    phone: r.phone || null,
  }));
}
