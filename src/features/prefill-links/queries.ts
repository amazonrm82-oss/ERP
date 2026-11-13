import "server-only";

import { orgHasFeature } from "@/features/settings/queries";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isPrefillRecordType, type PrefillRecordType } from "./fields";
import type { PrefillLinkState } from "./texts";

export type PrefillFormItem = {
  id: string;
  name: string;
  recordType: PrefillRecordType;
  title: string;
  intro: string | null;
  fields: string[];
  isActive: boolean;
  draftWording: boolean;
};

/** BIZ-05: the business's prefill form templates (members read). */
export async function listPrefillForms(orgId: string): Promise<PrefillFormItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("prefill_forms")
      .select("id, name, record_type, title, intro, fields, is_active, draft_wording")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    "prefill forms",
  );
  return rows
    .filter((r) => isPrefillRecordType(r.record_type))
    .map((r) => ({
      id: r.id,
      name: r.name,
      recordType: r.record_type as PrefillRecordType,
      title: r.title,
      intro: r.intro,
      fields: r.fields,
      isActive: r.is_active,
      draftWording: r.draft_wording,
    }));
}

export type RecordPrefillLink = {
  id: string;
  formName: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
  state: PrefillLinkState;
  canRevoke: boolean;
};

const STATES: readonly PrefillLinkState[] = ["open", "submitted", "expired", "revoked"];

/** The record's links (public.prefill_links_for_record: whoever reads the record; never the token). */
export async function getRecordPrefillLinks(orgId: string, recordType: PrefillRecordType, recordId: string): Promise<RecordPrefillLink[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("prefill_links_for_record", { p_org: orgId, p_record_type: recordType, p_record_id: recordId });
  if (error) throw new Error(`prefill_links_for_record failed: ${error.code}`);
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const names = await getUserNames(rows.map((r) => str(r.created_by)));
  return rows
    .filter((r) => typeof r.id === "string" && STATES.includes(r.state as PrefillLinkState))
    .map((r) => {
      const createdBy = str(r.created_by);
      return {
        id: r.id as string,
        formName: str(r.form_name) ?? "טופס",
        createdBy,
        createdByName: createdBy ? (names.get(createdBy) ?? null) : null,
        createdAt: str(r.created_at) ?? "",
        expiresAt: str(r.expires_at) ?? "",
        submittedAt: str(r.submitted_at),
        state: r.state as PrefillLinkState,
        canRevoke: r.can_revoke === true,
      };
    });
}

/** Whether the plan holds the key (the card shows a line instead of the button). */
export async function prefillInPlan(orgId: string): Promise<boolean> {
  return orgHasFeature(orgId, "prefill_links");
}
