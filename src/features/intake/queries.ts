import "server-only";

import type { FormKind } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isCallbackSlotStart, type CallbackSlotStart } from "./callback";
import { parseFieldsConfig, type FormFieldConfig } from "./fields";

export type IntakeSummary = {
  id: string;
  kind: FormKind;
  name: string;
  isActive: boolean;
  submissions30d: number;
};

/** Forms and webhooks of the organization (admins only, by RLS), newest first. */
export async function listIntakes(orgId: string): Promise<IntakeSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("forms")
    .select("id, kind, name, is_active")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`forms query failed: ${error.message}`);
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const counts = await Promise.all(
    data.map((form) =>
      supabase
        .from("form_submissions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("form_id", form.id)
        .eq("status", "accepted")
        .gte("created_at", since),
    ),
  );
  return data.map((form, i) => ({
    id: form.id,
    kind: form.kind === "webhook" ? "webhook" : "form",
    name: form.name,
    isActive: form.is_active,
    submissions30d: counts[i].count ?? 0,
  }));
}

export type IntakeDetails = {
  id: string;
  kind: FormKind;
  name: string;
  token: string;
  title: string | null;
  intro: string | null;
  submitLabel: string | null;
  successMessage: string | null;
  redirectUrl: string | null;
  fields: FormFieldConfig[];
  sourceId: string | null;
  ownerId: string | null;
  teamId: string | null;
  assignMode: "owner" | "round_robin";
  isActive: boolean;
  // CAP-05: the thank-you state's WhatsApp button; phone null = the business phone
  whatsappButton: boolean;
  whatsappPhone: string | null;
  whatsappText: string | null;
  // SPD-05: the hosted form asks when to call back; the slots switched off
  callbackChoice: boolean;
  callbackSlotsOff: CallbackSlotStart[];
};

export async function getIntake(orgId: string, formId: string): Promise<IntakeDetails | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("forms")
    .select("id, kind, name, token, title, intro, submit_label, success_message, redirect_url, fields, source_id, owner_id, team_id, assign_mode, is_active, whatsapp_button, whatsapp_phone, whatsapp_text, callback_choice, callback_slots_off")
    .eq("organization_id", orgId)
    .eq("id", formId)
    .maybeSingle();
  if (error) {
    throw new Error(`form query failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  return {
    id: data.id,
    kind: data.kind === "webhook" ? "webhook" : "form",
    name: data.name,
    token: data.token,
    title: data.title,
    intro: data.intro,
    submitLabel: data.submit_label,
    successMessage: data.success_message,
    redirectUrl: data.redirect_url,
    fields: parseFieldsConfig(data.fields),
    sourceId: data.source_id,
    ownerId: data.owner_id,
    teamId: data.team_id,
    assignMode: data.assign_mode === "round_robin" ? "round_robin" : "owner",
    isActive: data.is_active,
    whatsappButton: data.whatsapp_button,
    whatsappPhone: data.whatsapp_phone,
    whatsappText: data.whatsapp_text,
    callbackChoice: data.callback_choice,
    callbackSlotsOff: (data.callback_slots_off ?? []).filter(isCallbackSlotStart),
  };
}

export type SubmissionItem = { id: string; status: string; leadId: string | null; createdAt: string; summary: string };

type SubmissionRow = { id: string; status: string; lead_id: string | null; payload: unknown; created_at: string };

function toSubmissionItem(row: SubmissionRow): SubmissionItem {
  const payload =
    row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
  const summary = ["full_name", "phone", "email"]
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join(", ");
  return { id: row.id, status: row.status, leadId: row.lead_id, createdAt: row.created_at, summary: summary || "ללא פרטים" };
}

/** The latest submissions of a form (30). */
export async function listSubmissions(orgId: string, formId: string): Promise<SubmissionItem[]> {
  const supabase = await createClient();
  const data = must(
    await supabase
      .from("form_submissions")
      .select("id, status, lead_id, payload, created_at")
      .eq("organization_id", orgId)
      .eq("form_id", formId)
      .order("created_at", { ascending: false })
      .limit(30),
    "form submissions",
  );
  return data.map(toSubmissionItem);
}

export type KeptSubmissionItem = SubmissionItem & { formName: string };

/** CAP-04: the latest submissions whose form was deleted (30); the log outlives the form. */
export async function listKeptSubmissions(orgId: string): Promise<KeptSubmissionItem[]> {
  const supabase = await createClient();
  const data = must(
    await supabase
      .from("form_submissions")
      .select("id, status, lead_id, payload, created_at, form_name")
      .eq("organization_id", orgId)
      .is("form_id", null)
      .order("created_at", { ascending: false })
      .limit(30),
    "kept form submissions",
  );
  return data.map((row) => ({ ...toSubmissionItem(row), formName: row.form_name?.trim() || "טופס שנמחק" }));
}
