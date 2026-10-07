import "server-only";

import { cache } from "react";

import type { Json, PlatformRole, PlanRow } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type PlatformMe = { role: PlatformRole; needsMfa: boolean };

type Obj = Record<string, unknown>;
const obj = (value: Json | null): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});

/** The caller's platform role, or null for everyone else. Memoized per request. */
export const getPlatformMe = cache(async (): Promise<PlatformMe | null> => {
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_me");
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

async function call(name: "platform_metrics" | "platform_staff_list"): Promise<Json> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(name);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

export async function getPlatformMetrics(): Promise<Obj> {
  return obj(await call("platform_metrics"));
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
