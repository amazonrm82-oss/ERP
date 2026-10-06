"use client";

import { useActionState, useState } from "react";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { INDUSTRIES } from "@/features/onboarding/options";
import type { FormState } from "@/lib/action-result";

import { updateCompanyAction } from "../actions";
import { CompanyFields, type CompanyValues } from "./company-fields";

export type CompanyDetailsView = CompanyValues & {
  id: string;
  ownerName: string | null;
  // formatted on the server so server and browser output cannot differ
  createdAtText: string;
};

type Props = { orgId: string; company: CompanyDetailsView; canEdit: boolean };

/** Company details that switch in place between reading and editing. */
export function CompanyDetailsCard({ orgId, company, canEdit }: Props) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    // mounted only while editing, so every edit starts with a clean form state
    return <CompanyEditForm orgId={orgId} company={company} onDone={() => setEditing(false)} />;
  }

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
          <Detail label="ח.פ." value={company.tax_id} ltr />
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
          <Detail label="בעלים" value={company.ownerName} />
          <Detail label="נוצר" value={company.createdAtText} />
        </DetailList>
      </CardBody>
    </Card>
  );
}

function CompanyEditForm({ orgId, company, onDone }: { orgId: string; company: CompanyDetailsView; onDone: () => void }) {
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
          <FormError message={failure?.message} />
          <CompanyFields values={failure?.values ?? company} errors={failure?.fieldErrors ?? {}} />
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
