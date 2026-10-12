"use client";

import { useActionState, useState } from "react";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { CustomFieldDetails } from "@/features/custom-fields/components/custom-field-details";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { AttributionRow } from "@/features/intake/attribution";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";

import { updateLeadAction } from "../actions";
import type { LeadSourceOption } from "../queries";

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
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues };
  // CAP-02: campaign, UTM, pages and ad click ids the lead arrived with (first touch); only lines with a value
  attribution?: AttributionRow[];
};

type Props = { orgId: string; lead: LeadDetailsView; sources: LeadSourceOption[]; canWrite: boolean };

/** Lead details that switch in place between reading and editing. */
export function LeadDetailsCard({ orgId, lead, sources, canWrite }: Props) {
  const [editing, setEditing] = useState(false);
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
          <Detail label="אחראי" value={lead.ownerName} />
          <Detail label="נוצר" value={lead.createdAtText} />
          {lead.disqualifyReason ? <Detail label="סיבת פסילה" value={lead.disqualifyReason} /> : null}
          <CustomFieldDetails definitions={lead.custom.definitions} values={lead.custom.values} />
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
          <FormError message={failure?.message} />
          <TextField
            label="שם מלא"
            name="full_name"
            maxLength={200}
            autoComplete="off"
            defaultValue={values?.full_name ?? lead.fullName ?? ""}
            error={errors.full_name}
          />
          <TextField
            label="טלפון"
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="tel"
            autoComplete="off"
            defaultValue={values?.phone ?? lead.phone ?? ""}
            error={errors.phone}
          />
          <TextField
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
          <TextareaField
            label="הודעה"
            name="message"
            rows={4}
            maxLength={5000}
            defaultValue={values?.message ?? lead.message ?? ""}
            error={errors.message}
          />
          <CustomFieldInputs definitions={lead.custom.definitions} stored={lead.custom.values} submitted={values} errors={errors} />
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
