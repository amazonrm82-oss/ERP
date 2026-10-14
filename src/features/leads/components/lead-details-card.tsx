"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { CheckedTextField } from "@/features/data-quality/components/checked-field";
import { useEditFocus } from "@/features/data-quality/use-edit-focus";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { CustomFieldDetails } from "@/features/custom-fields/components/custom-field-details";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { AttributionRow } from "@/features/intake/attribution";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";
import { productPath } from "@/features/products/paths";
import { RequestedProductPicker } from "@/features/requested-product/components/requested-product-picker";
import type { RequestedProduct } from "@/features/requested-product/queries";

import { updateLeadAction } from "../actions";
import type { LeadSourceOption } from "../queries";
import { budgetInputValue, LEAD_UTM_KEYS, type LeadUtmKey } from "../schema";
import { LeadCampaignFields } from "./lead-campaign-fields";

export type LeadDetailsView = {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  companyName: string | null;
  sourceId: string | null;
  message: string | null;
  disqualifyReason: string | null;
  // formatted on the server so server and browser output cannot differ
  ownerName: string | null;
  createdAtText: string;
  // LEAD-02: the last contact logged on the timeline, formatted on the server; null when none yet
  lastContactText: string | null;
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues; builtins?: Record<string, string | null> };
  // CAP-02: campaign, UTM, pages and ad click ids the lead arrived with (first touch); only lines with a value
  attribution?: AttributionRow[];
  // LEAD-01: the editable part of it, plus the budget (agorot)
  campaign?: string | null;
  budgetAgorot?: number | null;
  utm?: Partial<Record<LeadUtmKey, string>>;
  // LEAD-04: the requested product (null: none, or not readable) and whether the plan has products
  requestedProduct?: { enabled: boolean; product: RequestedProduct | null };
};

type Props = { orgId: string; lead: LeadDetailsView; sources: LeadSourceOption[]; canWrite: boolean; focus?: string | null };

/** Lead details that switch in place between reading and editing. */
export function LeadDetailsCard({ orgId, lead, sources, canWrite, focus }: Props) {
  // DQL-01: a missing field on the completeness card opens the card for editing at that input
  const [editing, setEditing] = useState(Boolean(focus) && canWrite);
  useEditFocus("lead-details-title", focus, editing);
  const sourceName = sources.find((source) => source.id === lead.sourceId)?.name ?? null;

  if (editing) {
    // mounted only while editing, so every edit starts with a clean form state
    return <LeadEditForm orgId={orgId} lead={lead} sources={sources} onDone={() => setEditing(false)} />;
  }

  return (
    <Card aria-labelledby="lead-details-title">
      <CardHeader
        id="lead-details-title"
        title="פרטי הליד"
        action={
          canWrite ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              עריכה
            </Button>
          ) : null
        }
      />
      <CardBody>
        <DetailList>
          <Detail label="שם מלא" value={lead.fullName} />
          <Detail label="טלפון" value={lead.phone} ltr />
          <Detail label="אימייל" value={lead.email} ltr />
          <Detail label="חברה" value={lead.companyName} />
          <Detail label="מקור" value={sourceName} />
          {lead.requestedProduct && (lead.requestedProduct.enabled || lead.requestedProduct.product) ? (
            <Detail label="מוצר מבוקש" value={lead.requestedProduct.product ? <RequestedProductValue orgId={orgId} product={lead.requestedProduct.product} /> : null} />
          ) : null}
          <Detail label="אחראי" value={lead.ownerName} />
          <Detail label="תקציב" value={lead.budgetAgorot != null ? formatMoney(lead.budgetAgorot) : null} />
          <Detail label="מגע אחרון" value={lead.lastContactText ?? "אין עדיין"} />
          <Detail label="נוצר" value={lead.createdAtText} />
          {lead.disqualifyReason ? <Detail label="סיבת פסילה" value={lead.disqualifyReason} /> : null}
          <CustomFieldDetails definitions={lead.custom.definitions} values={lead.custom.values} objectType="lead" builtins={lead.custom.builtins} />
        </DetailList>
        {lead.message ? (
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-sm text-ink-soft">הודעה</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-md">{lead.message}</p>
          </div>
        ) : null}
        {lead.attribution && lead.attribution.length > 0 ? (
          <section aria-labelledby="lead-attribution-title" className="mt-4 border-t border-line pt-4">
            <h3 id="lead-attribution-title" className="mb-3 text-sm text-ink-soft">
              מאיפה הגיע הליד
            </h3>
            <DetailList>
              {lead.attribution.map((row) => (
                <Detail key={row.label} label={row.label} value={row.value} ltr={row.ltr} />
              ))}
            </DetailList>
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}

function RequestedProductValue({ orgId, product }: { orgId: string; product: RequestedProduct }) {
  return (
    <span>
      <Link href={productPath(orgId, product.id)} className="text-accent underline underline-offset-4">
        <bdi>{product.name}</bdi>
      </Link>
      {product.note ? <span className="text-sm text-ink-soft"> ({product.note})</span> : null}
    </span>
  );
}

type EditProps = { orgId: string; lead: LeadDetailsView; sources: LeadSourceOption[]; onDone: () => void };

function LeadEditForm({ orgId, lead, sources, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateLeadAction(orgId, lead.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const sourceValue = values?.source_id ?? lead.sourceId ?? "";

  return (
    <Card aria-labelledby="lead-details-title">
      <CardHeader id="lead-details-title" title="עריכת פרטי הליד" />
      <CardBody>
        <form action={formAction} className="space-y-4" noValidate>
          <FormGuard state={state} />
          <FormError message={failure?.message} />
          <TextField
            label="שם מלא"
            name="full_name"
            maxLength={200}
            autoComplete="off"
            defaultValue={values?.full_name ?? lead.fullName ?? ""}
            error={errors.full_name}
          />
          <CheckedTextField
            check="phone"
            label="טלפון"
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            autoComplete="off"
            defaultValue={values?.phone ?? lead.phone ?? ""}
            error={errors.phone}
          />
          <CheckedTextField
            check="email"
            label="אימייל"
            name="email"
            type="email"
            dir="ltr"
            inputMode="email"
            autoComplete="off"
            defaultValue={values?.email ?? lead.email ?? ""}
            error={errors.email}
          />
          <TextField
            label="חברה"
            name="company_name"
            maxLength={200}
            autoComplete="off"
            defaultValue={values?.company_name ?? lead.companyName ?? ""}
            error={errors.company_name}
          />
          <SelectField key={`source-${sourceValue}`} label="מקור" name="source_id" defaultValue={sourceValue} error={errors.source_id}>
            <option value="">ללא מקור</option>
            {sources.filter((source) => source.isActive || source.id === lead.sourceId).map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </SelectField>
          {lead.requestedProduct?.enabled ? (
            <RequestedProductPicker
              orgId={orgId}
              initial={lead.requestedProduct.product ? { id: lead.requestedProduct.product.id, name: lead.requestedProduct.product.name, note: lead.requestedProduct.product.note } : null}
              error={errors.requested_product_id}
            />
          ) : null}
          <TextareaField
            label="הודעה"
            name="message"
            rows={4}
            maxLength={5000}
            defaultValue={values?.message ?? lead.message ?? ""}
            error={errors.message}
          />
          <LeadCampaignFields
            values={{
              campaign: values?.campaign ?? lead.campaign ?? "",
              budget: values?.budget ?? budgetInputValue(lead.budgetAgorot ?? null),
              ...Object.fromEntries(LEAD_UTM_KEYS.map((key) => [key, values?.[key] ?? lead.utm?.[key] ?? ""])),
            }}
            errors={errors}
            readOnlyNote
          />
          <CustomFieldInputs definitions={lead.custom.definitions} stored={lead.custom.values} submitted={values} errors={errors} objectType="lead" builtins={lead.custom.builtins} />
          <div className="flex flex-wrap gap-2">
            <SubmitButton size="sm">שמירה</SubmitButton>
            <Button variant="ghost" size="sm" onClick={onDone}>
              ביטול
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
