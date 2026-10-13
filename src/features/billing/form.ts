import { invalid, type ActionResult } from "@/lib/action-result";
import { pick } from "@/lib/validation";

import type { BillingSubject } from "./billing";
import { BILLING_FIELD_NAMES, BILLING_MARKER, companyBillingSchema, contactBillingSchema, type CompanyBillingPatch, type ContactBillingPatch } from "./schema";

type Failure = { ok: false; failure: Extract<ActionResult, { ok: false }> };
type PatchOf<S extends BillingSubject> = S extends "company" ? CompanyBillingPatch : ContactBillingPatch;

/**
 * CON-08: the billing fields of a submitted company or contact form. When the form has no billing
 * section the patch is empty, so nothing stored is cleared.
 */
export function billingFromForm<S extends BillingSubject>(formData: FormData, subject: S): { ok: true; patch: Partial<PatchOf<S>> } | Failure {
  if (!formData.has(BILLING_MARKER)) {
    return { ok: true, patch: {} };
  }
  const input = pick(formData, BILLING_FIELD_NAMES[subject]);
  const parsed = subject === "company" ? companyBillingSchema.safeParse(input) : contactBillingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, failure: invalid(parsed.error, formData) };
  }
  return { ok: true, patch: parsed.data as PatchOf<S> };
}
