"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { useEditFocus } from "@/features/data-quality/use-edit-focus";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { INDUSTRIES } from "@/features/onboarding/options";
import { LayoutDetails } from "@/features/card-layout/components/layout-details";
import type { CardLayoutGroup } from "@/features/card-layout/layout";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { RecordType } from "@/features/record-type-options/schema";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { updateCompanyAction } from "../actions";
import { countryName, ISRAEL } from "../countries";
import type { CompanyParent } from "../queries";
import { CompanyFields, type CompanyValues } from "./company-fields";
import type { ParentChoice } from "./parent-company-picker";

export type CompanyDetailsView = CompanyValues & {
  id: string;
  ownerName: string | null;
  // CON-02: the type from the list, and the older free-text type
  typeName: string | null;
  company_type: string | null;
  // formatted on the server so server and browser output cannot differ
  createdAtText: string;
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues; builtins?: Record<string, string | null> };
  // CON-07
  parent: CompanyParent | null;
};

const HIDDEN_PARENT = "חברה שאין לכם גישה אליה";

/** The parent as the picker starts with it: an unchanged pick is saved as it is. */
function parentChoice(parent: CompanyParent | null): ParentChoice {
  if (!parent) return null;
  if (parent.state === "hidden") return { id: parent.id, name: HIDDEN_PARENT };
  return { id: parent.id, name: parent.state === "trashed" ? `${parent.name} (בסל המחזור)` : parent.name };
}

function ParentValue({ orgId, parent }: { orgId: string; parent: CompanyParent | null }) {
  if (!parent) return null;
  if (parent.state === "hidden") return <span className="text-ink-soft">{HIDDEN_PARENT}</span>;
  if (parent.state === "trashed") {
    return (
      <span>
        <bdi>{parent.name}</bdi> <span className="text-ink-soft">(בסל המחזור)</span>
      </span>
    );
  }
  return (
    <Link href={paths.company(orgId, parent.id)} className="text-accent underline underline-offset-4">
      <bdi>{parent.name}</bdi>
    </Link>
  );
}

// layout: the business's card layout (FLD-08); null or missing = the default layout
type Props = { orgId: string; company: CompanyDetailsView; types: RecordType[]; canEdit: boolean; focus?: string | null; layout?: CardLayoutGroup[] | null };

/** Company details that switch in place between reading and editing. */
export function CompanyDetailsCard({ orgId, company, types, canEdit, focus, layout = null }: Props) {
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
        <LayoutDetails
          type="company"
          idPrefix="company-details"
          layout={layout}
          custom={company.custom}
          builtIn={{
            type: { value: company.typeName ?? company.company_type },
            parent_company_id: { value: company.parent ? <ParentValue orgId={orgId} parent={company.parent} /> : null },
            // CON-04: the country only when it is not Israel
            country: israeli ? null : { value: countryName(company.country) },
            tax_id: { value: company.tax_id, ltr: true, label: israeli ? "ח.פ." : "מספר רישום" },
            industry: { value: INDUSTRIES.find((option) => option.value === company.industry)?.label },
            phone: { value: company.phone, ltr: true },
            email: { value: company.email, ltr: true },
            website: {
              ltr: true,
              value: company.website ? (
                <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
                  {company.website.replace(/^https?:\/\//, "")}
                  <span className="sr-only"> (נפתח בחלון חדש)</span>
                </a>
              ) : null,
            },
            city: { value: company.city },
            address_line: { value: company.address_line },
            owner_id: { value: company.ownerName },
            created_at: { value: company.createdAtText },
          }}
        />
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
          <CompanyFields
            values={failure?.values ?? company}
            errors={failure?.fieldErrors ?? {}}
            types={types}
            legacyType={company.company_type}
            parent={{ orgId, companyId: company.id, initial: parentChoice(company.parent) }}
          />
          <CustomFieldInputs
            definitions={company.custom.definitions}
            stored={company.custom.values}
            objectType="company"
            record={{ object: "company", id: company.id }}
            builtins={company.custom.builtins}
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
