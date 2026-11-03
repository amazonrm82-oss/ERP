"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { saveTerms } from "@/features/terminology/save";
import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isUuid } from "@/lib/paths";

type OfficerValues = { privacy_officer_id: string | null };

const officerSchema = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : value),
  z.string().refine(isUuid).nullable(),
);

/**
 * PRK-06: names the business's privacy officer, or clears it, with the user's session (owners and admins of a
 * writable business, RLS; the database checks that the person is an active member). Update first, insert only when
 * there is no row yet (never an upsert: organization_id has no update grant).
 */
export async function setPrivacyOfficerAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = officerSchema.safeParse(formData.get("privacy_officer_id"));
  if (!parsed.success) return fail("יש לבחור משתמש מהרשימה.");
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const supabase = context.supabase;
  const result = await saveTerms<OfficerValues>(
    {
      update: (org, v) => supabase.from("org_privacy_settings").update(v).eq("organization_id", org).select("id"),
      insert: (org, v) => supabase.from("org_privacy_settings").insert({ organization_id: org, ...v }).select("id"),
    },
    orgId,
    { privacy_officer_id: parsed.data },
  );
  if (!result.ok) {
    if (result.error?.code === "42501") return fail("רק בעלים ומנהלי מערכת קובעים את אחראי הפרטיות, ורק כשהעסק פעיל.");
    return fail(dbErrorMessage(result.error));
  }
  revalidatePath(`/o/${orgId}/settings`, "layout");
  return { ok: true, message: parsed.data ? "אחראי הפרטיות נשמר." : "הסימון של אחראי הפרטיות הוסר." };
}
