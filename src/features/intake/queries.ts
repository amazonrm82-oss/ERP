import "server-only";

import type { FormKind } from "@/lib/database.types";
import { DbReadError, must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isCallbackSlotStart, type CallbackSlotStart } from "./callback";
import { parseFieldsConfig, type FormFieldConfig } from "./fields";
import { isMarketingConsentChannel, type MarketingConsentChannel } from "./marketing-consent";
import { coveredCategoryIds, mergeFormProductOptions, orderedFormCategories, type FormCategory, type FormProduct } from "./product";

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
    // BIZ-02 / SPD-07: a business card's or site widget's form is managed with its card or widget, not here
    .in("kind", ["form", "webhook"])
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
  // CON-10: the hosted form asks how the person likes to be contacted
  channelChoice: boolean;
  // CAP-08: the hosted form asks the person's preferred language
  localeChoice: boolean;
  // LEAD-04 / CAP-08: the hosted form asks for a requested product; the picked ones (null = every offerable product)
  productChoice: boolean;
  productIds: string[] | null;
  productCategoryIds: string[] | null;
  // CAP-07 / CNS-04: channels with a marketing-consent box
  marketingConsentChannels: MarketingConsentChannel[];
};

export async function getIntake(orgId: string, formId: string): Promise<IntakeDetails | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("forms")
    .select("id, kind, name, token, title, intro, submit_label, success_message, redirect_url, fields, source_id, owner_id, team_id, assign_mode, is_active, whatsapp_button, whatsapp_phone, whatsapp_text, callback_choice, callback_slots_off, channel_choice, locale_choice, product_choice, product_ids, product_category_ids, marketing_consent_channels")
    .eq("organization_id", orgId)
    .eq("id", formId)
    // BIZ-02 / SPD-07: a business card's or site widget's form is managed with its card or widget, not here
    .in("kind", ["form", "webhook"])
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
    channelChoice: data.channel_choice,
    localeChoice: data.locale_choice,
    productChoice: data.product_choice,
    productIds: data.product_ids,
    productCategoryIds: data.product_category_ids,
    marketingConsentChannels: (data.marketing_consent_channels ?? []).filter(isMarketingConsentChannel),
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

/** How many offerable products the form settings list to pick from (a longer catalog shows the first ones by name). */
export const FORM_PRODUCT_PICK_LIMIT = 500;

/**
 * LEAD-04 / CAP-08: offerable products (active, not archived) to pick for a form's product question, in the public
 * form's order: the first FORM_PRODUCT_PICK_LIMIT by name, plus every stored pick the cut left out, so a save keeps it.
 */
export async function listFormProductOptions(orgId: string, storedPicks: readonly string[] | null): Promise<FormProduct[]> {
  const supabase = await createClient();
  const offerable = () =>
    supabase.from("products").select("id, name").eq("organization_id", orgId).eq("is_active", true).is("archived_at", null);
  const listed = must(await offerable().order("name").order("id").limit(FORM_PRODUCT_PICK_LIMIT), "form product options");
  const seen = new Set(listed.map((row) => row.id));
  const missing = (storedPicks ?? []).filter((id) => !seen.has(id));
  const picked = missing.length > 0 ? must(await offerable().in("id", missing), "form product picks") : [];
  return mergeFormProductOptions(
    listed.map((row) => ({ id: row.id, name: row.name })),
    picked.map((row) => ({ id: row.id, name: row.name })),
  );
}

/** LEAD-04 / CAP-08: the business's product categories for the form's product question, tops each followed by its subs. */
export async function listFormCategoryOptions(orgId: string): Promise<Array<FormCategory & { depth: 0 | 1 }>> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("product_categories").select("id, name, parent_id").eq("organization_id", orgId).order("id").limit(1000),
    "form category options",
  );
  return orderedFormCategories(rows.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id })));
}

/**
 * How many offerable products the business has, and how many a form's choice offers (app.form_product_offer's rule:
 * picked products plus the products of the picked categories and their sub-categories; no pick = all).
 */
export async function countFormProductOffer(
  orgId: string,
  productIds: readonly string[] | null,
  categoryIds: readonly string[] | null,
  categories: readonly FormCategory[],
): Promise<{ offerable: number; offer: number }> {
  const supabase = await createClient();
  const offerable = () =>
    supabase.from("products").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("is_active", true).is("archived_at", null);
  const counted = async (query: ReturnType<typeof offerable>, what: string) => {
    const result = await query;
    if (result.error) throw new DbReadError(what, result.error);
    return result.count ?? 0;
  };
  const all = await counted(offerable(), "offerable products");
  if (!productIds && !categoryIds) {
    return { offerable: all, offer: all };
  }
  const covered = [...coveredCategoryIds(categoryIds ?? [], categories)];
  const parts = [
    ...(productIds && productIds.length > 0 ? [`id.in.(${productIds.join(",")})`] : []),
    ...(covered.length > 0 ? [`category_id.in.(${covered.join(",")})`] : []),
  ];
  if (parts.length === 0) {
    return { offerable: all, offer: 0 };
  }
  const offer = await counted(offerable().or(parts.join(",")), "form product offer");
  return { offerable: all, offer };
}
