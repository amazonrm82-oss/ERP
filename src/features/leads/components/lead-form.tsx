"use client";

import { useActionState, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";

import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { CheckedTextField } from "@/features/data-quality/components/checked-field";
import { DuplicateNotice } from "@/features/data-quality/components/duplicate-notice";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createLeadAction, createLeadStayAction } from "../actions";
import { checkLeadDuplicateAction, type TypingDuplicate } from "../duplicate-actions";
import { cleanPastedPhone, duplicateLookupInput, leadFormMemoryKey, readLeadFormMemory, serializeLeadFormMemory } from "../form-memory";
import { RequestedProductPicker } from "@/features/requested-product/components/requested-product-picker";

import { LeadCampaignFields } from "./lead-campaign-fields";
import { GenderField } from "@/features/gender/components/gender-field";

import { LeadChannelField } from "./lead-channel-field";
import { LeadLocaleField } from "./lead-locale-field";
import type { LeadSourceOption, LeadStatusOption } from "../queries";

// reasons: the organization's active "not relevant" reasons (LEAD-03); empty: typed in freely
// products: LEAD-04, the requested product picker shows when the plan has the product catalog
// prefill: WAB-06, starting values from something shared to the app (full_name, phone, email, message); still editable
type Props = {
  orgId: string;
  statuses: LeadStatusOption[];
  sources: LeadSourceOption[];
  fields: FieldDefinition[];
  reasons: string[];
  products?: boolean;
  prefill?: Record<string, string>;
  // WAB-06: called with the new lead's id instead of going to its page (the share screen saves a note on it first)
  onCreated?: (id: string) => void;
  // UX-03: the signed-in user; with it the form remembers this user's last source and status in this business
  userId?: string;
};

// UX-03: how long typing must pause before the duplicate check asks
const DUPLICATE_PAUSE_MS = 600;

// UX-03: the remembered choice is read from this device's storage once per mounted form (the form's own save
// writes it again without moving what is on screen) and forgotten when the form goes away
const firstReads = new Map<string, string | null>();

function subscribeNothing() {
  return () => {};
}

function readStored(key: string | null): string | null {
  if (!key) return null;
  if (!firstReads.has(key)) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      // private window or blocked storage: the defaults
    }
    firstReads.set(key, raw);
  }
  return firstReads.get(key) ?? null;
}

/** New lead form. On success the action redirects to the lead's page, or hands the new id to `onCreated`. */
export function LeadForm({ orgId, statuses, sources, fields, reasons, products = false, prefill, onCreated, userId }: Props) {
  // which action is fixed when the form mounts (the share screen always passes onCreated)
  const [stay] = useState(() => onCreated !== undefined);
  const [state, formAction] = useActionState<FormState<{ id: string }>, FormData>(
    stay ? createLeadStayAction.bind(null, orgId) : (createLeadAction.bind(null, orgId) as (prev: FormState<{ id: string }>, form: FormData) => Promise<FormState<{ id: string }>>),
    null,
  );
  const created = useRef(onCreated);
  useEffect(() => {
    created.current = onCreated;
  });
  const createdId = state?.ok ? state.data?.id : undefined;
  useEffect(() => {
    if (createdId) created.current?.(createdId);
  }, [createdId]);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? prefill ?? {};
  // WAB-06: prefilled values are not saved yet. FormGuard takes its starting point when it mounts; this marker is then
  // emptied (its value attribute changes, which FormGuard watches), so leaving a prefilled form asks first.
  const prefillMarker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (prefillMarker.current) prefillMarker.current.value = "";
  }, []);
  const errors = failure?.fieldErrors ?? {};

  // a new lead cannot start as "converted"
  const selectable = statuses.filter((status) => status.kind !== "converted");
  const defaultStatus = values.status_id ?? selectable.find((status) => status.isDefault)?.id ?? selectable[0]?.id ?? "";
  // UX-03: start from this user's last source and status in this business (this device only), read after
  // hydration. Not over a shared prefill or a failed save's values; storage that cannot be read leaves the defaults.
  const memoryKey = userId ? leadFormMemoryKey(userId, orgId) : null;
  const [memoryAllowed] = useState(() => !failure && !prefill);
  const stored = useSyncExternalStore(subscribeNothing, () => readStored(memoryAllowed ? memoryKey : null), () => null);
  const memory = readLeadFormMemory(stored, sources, statuses);
  useEffect(() => {
    if (!memoryKey) return;
    return () => {
      firstReads.delete(memoryKey);
    };
  }, [memoryKey]);
  // null until the user picks one
  const [pickedSource, setSourceId] = useState<string | null>(null);
  const [pickedStatus, setStatusId] = useState<string | null>(null);
  const sourceId = pickedSource ?? values.source_id ?? memory.sourceId ?? "";
  // a lead that starts "not relevant" needs a reason, as in the status form (RVW-9)
  const statusId = pickedStatus ?? values.status_id ?? memory.statusId ?? defaultStatus;
  // the remembered choice is a starting value, not a change: FormGuard takes its starting point again
  const guardRound = memory.sourceId || memory.statusId ? 1 : 0;
  const [reason, setReason] = useState(values.disqualify_reason ?? "");
  const needsReason = statuses.find((status) => status.id === statusId)?.kind === "disqualified";

  const remember = () => {
    if (!memoryKey) return;
    try {
      window.localStorage.setItem(memoryKey, serializeLeadFormMemory({ sourceId: sourceId || null, statusId: statusId || null }));
    } catch {
      // private window or blocked storage: the next form starts with the defaults
    }
  };

  // UX-03: the DQL-02 duplicate check while typing (a warning only; the save checks again and asks)
  const [phone, setPhone] = useState(values.phone ?? "");
  const [email, setEmail] = useState(values.email ?? "");
  const lookup = duplicateLookupInput(phone, email);
  const lookupKey = lookup ? `${lookup.phone ?? ""}\n${lookup.email ?? ""}` : "";
  const [found, setFound] = useState<{ key: string; duplicate: TypingDuplicate | null }>({ key: "", duplicate: null });
  const [, startCheck] = useTransition();
  useEffect(() => {
    if (!lookupKey) return;
    const [askPhone, askEmail] = lookupKey.split("\n");
    const timer = setTimeout(() => {
      startCheck(async () => {
        const result = await checkLeadDuplicateAction(orgId, askPhone, askEmail);
        setFound({ key: lookupKey, duplicate: result.ok ? (result.data ?? null) : null });
      });
    }, DUPLICATE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [lookupKey, orgId]);
  // shown only for what is in the boxes now, and not next to the save's own duplicate notice
  const typingDuplicate = !errors.allow_duplicate && lookupKey && found.key === lookupKey ? found.duplicate : null;

  return (
    <form action={formAction} onSubmit={remember} className="space-y-4" noValidate>
      <FormGuard key={guardRound} state={state} />
      {prefill ? <input ref={prefillMarker} type="hidden" name="prefill_unsaved" defaultValue="1" /> : null}
      <FormError message={failure?.message} />
      {errors.allow_duplicate ? <DuplicateNotice href={errors.allow_duplicate} createLabel="ליצור ליד חדש בכל זאת" /> : null}
      <TextField
        label="שם מלא"
        name="full_name"
        autoComplete="off"
        maxLength={200}
        hint="חובה למלא לפחות אחד: שם, טלפון או אימייל."
        defaultValue={values.full_name}
        error={errors.full_name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <CheckedTextField
          check="phone"
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          defaultValue={values.phone}
          error={errors.phone}
          onValueChange={setPhone}
          cleanPaste={cleanPastedPhone}
        />
        <CheckedTextField
          check="email"
          label="אימייל"
          name="email"
          type="email"
          dir="ltr"
          inputMode="email"
          autoComplete="off"
          defaultValue={values.email}
          error={errors.email}
          onValueChange={setEmail}
        />
      </div>
      {typingDuplicate ? (
        <p role="status" className="text-sm text-warning">
          {typingDuplicate.message}{" "}
          <Link href={typingDuplicate.href} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
            לפתוח את הרשומה הקיימת
          </Link>
        </p>
      ) : null}
      <TextField
        label="חברה"
        name="company_name"
        autoComplete="off"
        maxLength={200}
        defaultValue={values.company_name}
        error={errors.company_name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="מקור" name="source_id" value={sourceId} onChange={(event) => setSourceId(event.target.value)} error={errors.source_id}>
          <option value="">ללא מקור</option>
          {sources.filter((source) => source.isActive).map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="סטטוס"
          name="status_id"
          required
          value={statusId}
          onChange={(event) => setStatusId(event.target.value)}
          error={errors.status_id}
        >
          {selectable.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      </div>
      {needsReason ? (
        <DisqualifyReasonField
          reasons={reasons}
          label="למה הליד לא רלוונטי?"
          name="disqualify_reason"
          value={reason}
          onChange={setReason}
          error={errors.disqualify_reason}
        />
      ) : null}
      {products ? <RequestedProductPicker orgId={orgId} initial={null} error={errors.requested_product_id} /> : null}
      <LeadChannelField value={values.preferred_channel ?? ""} error={errors.preferred_channel} />
      <LeadLocaleField value={values.preferred_locale ?? ""} error={errors.preferred_locale} />
      <GenderField value={values.gender ?? ""} error={errors.gender} className="sm:max-w-xs" />
      <LeadCampaignFields values={values} errors={errors} />
      <TextareaField
        label="הודעה או הערה ראשונה"
        name="message"
        rows={4}
        maxLength={5000}
        defaultValue={values.message}
        error={errors.message}
      />
      <CustomFieldInputs definitions={fields} submitted={failure?.values} errors={errors} objectType="lead" />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצרים ליד…">יצירת ליד</SubmitButton>
        <ButtonLink href={paths.leads(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}
