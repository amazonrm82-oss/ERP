"use client";

import { useActionState, useState } from "react";

import { useEditFocus } from "@/features/data-quality/use-edit-focus";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { INDUSTRIES } from "@/features/onboarding/options";
import { CustomFieldDetails } from "@/features/custom-fields/components/custom-field-details";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { RecordType } from "@/features/record-type-options/schema";
import type { FormState } from "@/lib/action-result";

import { updateCompanyAction } from "../actions";
import { countryName, ISRAEL } from "../countries";
import { CompanyFields, type CompanyValues } from "./company-fields";

export type CompanyDetailsView = CompanyValues & {
  id: string;
  ownerName: string | null;
  // CON-02: the type from the list, and the older free-text type
  typeName: string | null;
  company_type: string | null;
  // formatted on the server so server and browser output cannot differ
  createdAtText: string;
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues };
};

type Props = { orgId: string; company: CompanyDetailsView; types: RecordType[]; canEdit: boolean; focus?: string | null };

/** Company details that switch in place between reading and editing. */
export function CompanyDetailsCard({ orgId, company, types, canEdit, focus }: Props) {
  // DQL-01: a missing field on the completeness card opens the card for editing at that input
  const [editing, setEditing] = useState(Boolean(focus) && canEdit);
  useEditFocus("company-details-title", focus, editing);

  if (editing) {
    // mounted only while editing, so every edit starts with a clean form state
    return <CompanyEditForm orgId={orgId} company={company} types={types} onDone={() => setEditing(false)} />;
  }
  const israeli = (company.country ?? ISRAEL) === ISRAEL;

  return (
    <Card aria-labelledby="company-details-title">
      <CardHeader
        id="company-details-title"
        title="פרטי החברה"
        action={
          canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              עריכה
            </Button>
          ) : null
        }
      />
      <CardBody>
        <DetailList>
          <Detail label="סוג" value={company.typeName ?? company.company_type} />
          {/* CON-04: the country only when it is not Israel */}
          {israeli ? null : <Detail label="מדינת הרישום" value={countryName(company.country)} />}
          <Detail label={israeli ? "ח.פ." : "מספר רישום"} value={company.tax_id} ltr />
          <Detail label="ענף" value={INDUSTRIES.find((option) => option.value === company.industry)?.label} />
          <Detail label="טלפון" value={company.phone} ltr />
          <Detail label="אימייל" value={company.email} ltr />
          <Detail
            label="אתר"
            value={
              company.website ? (
                <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
                  {company.website.replace(/^https?:\/\//, "")}
                </a>
              ) : null
            }
            ltr
          />
          <Detail label="עיר" value={company.city} />
          <Detail label="כתובת" value={company.address_line} />
          <Detail label="אחראי" value={company.ownerName} />
          <Detail label="נוצר" value={company.createdAtText} />
          <CustomFieldDetails definitions={company.custom.definitions} values={company.custom.values} />
        </DetailList>
      </CardBody>
    </Card>
  );
}

function CompanyEditForm({ orgId, company, types, onDone }: { orgId: string; company: CompanyDetailsView; types: RecordType[]; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateCompanyAction(orgId, company.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="company-details-title">
      <CardHeader id="company-details-title" title="עריכת פרטי החברה" />
      <CardBody>
        <form action={formAction} className="space-y-4" noValidate>
          <FormGuard state={state} />
          <FormError message={failure?.message} />
          <CompanyFields values={failure?.values ?? company} errors={failure?.fieldErrors ?? {}} types={types} legacyType={company.company_type} />
          <CustomFieldInputs
            definitions={company.custom.definitions}
            stored={company.custom.values}
            submitted={failure?.values}
            errors={failure?.fieldErrors}
          />
          <div className="flex flex-wrap gap-2 pt-1">
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
