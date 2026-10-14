"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { useEditFocus } from "@/features/data-quality/use-edit-focus";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { CompanyOption } from "@/features/companies/queries";
import { CustomFieldDetails } from "@/features/custom-fields/components/custom-field-details";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { RecordType } from "@/features/record-type-options/schema";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { updateContactAction } from "../actions";
import { channelTypeLabel, draftsFrom, type ChannelKind } from "../channels";
import { channelLabel, localeLabel } from "../preferences";
import { ContactFields, type ContactValues } from "./contact-fields";

export type ContactDetailsView = ContactValues & {
  id: string;
  full_name: string | null;
  companyName: string | null;
  sourceName: string | null;
  // CON-02: the type from the list, and the older free-text type
  typeName: string | null;
  contact_type: string | null;
  ownerName: string | null;
  birthDateText: string | null;
  // formatted on the server so server and browser output cannot differ
  createdAtText: string;
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues; builtins?: Record<string, string | null> };
};

type Props = { orgId: string; contact: ContactDetailsView; companies: CompanyOption[]; types: RecordType[]; canEdit: boolean; focus?: string | null };

/** Contact details that switch in place between reading and editing. */
export function ContactDetailsCard({ orgId, contact, companies, types, canEdit, focus }: Props) {
  // DQL-01: a missing field on the completeness card opens the card for editing at that input
  const [editing, setEditing] = useState(Boolean(focus) && canEdit);
  useEditFocus("contact-details-title", focus, editing);

  if (editing) {
    // mounted only while editing, so every edit starts with a clean form state
    return <ContactEditForm orgId={orgId} contact={contact} companies={companies} types={types} onDone={() => setEditing(false)} />;
  }

  return (
    <Card aria-labelledby="contact-details-title">
      <CardHeader
        id="contact-details-title"
        title="פרטי איש הקשר"
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
          <Detail label="שם מלא" value={contact.full_name} />
          <Detail label="טלפון" value={<ChannelList kind="phone" contact={contact} />} />
          <Detail label="אימייל" value={<ChannelList kind="email" contact={contact} />} />
          <Detail label="תפקיד" value={contact.job_title} />
          <Detail
            label="חברה"
            value={
              contact.company_id && contact.companyName ? (
                <Link href={paths.company(orgId, contact.company_id)} className="text-accent underline underline-offset-4">
                  {contact.companyName}
                </Link>
              ) : null
            }
          />
          <Detail label="סוג" value={contact.typeName ?? contact.contact_type} />
          <Detail label="יום הולדת" value={contact.birthDateText} />
          <Detail label="שפה מועדפת" value={localeLabel(contact.preferred_locale)} />
          <Detail label="ערוץ מועדף" value={channelLabel(contact.preferred_channel)} />
          <Detail label="מקור" value={contact.sourceName} />
          <Detail label="אחראי" value={contact.ownerName} />
          <Detail label="נוצר" value={contact.createdAtText} />
          <CustomFieldDetails definitions={contact.custom.definitions} values={contact.custom.values} objectType="contact" builtins={contact.custom.builtins} />
        </DetailList>
      </CardBody>
    </Card>
  );
}

type EditProps = { orgId: string; contact: ContactDetailsView; companies: CompanyOption[]; types: RecordType[]; onDone: () => void };

function ContactEditForm({ orgId, contact, companies, types, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateContactAction(orgId, contact.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="contact-details-title">
      <CardHeader id="contact-details-title" title="עריכת איש הקשר" />
      <CardBody>
        <form action={formAction} className="space-y-4" noValidate>
          <FormGuard state={state} />
          <FormError message={failure?.message} />
          <ContactFields values={failure?.values ?? contact} errors={failure?.fieldErrors ?? {}} companies={companies}
            types={types}
            legacyType={contact.contact_type}
          />
          <CustomFieldInputs
            definitions={contact.custom.definitions}
            stored={contact.custom.values}
            objectType="contact"
            builtins={contact.custom.builtins}
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

/**
 * CON-01: the primary phone (or email) first, marked, then the further ones, each with its
 * type and a link that dials or writes. The call and WhatsApp buttons at the top use the primary.
 */
function ChannelList({ kind, contact }: { kind: ChannelKind; contact: ContactDetailsView }) {
  const rows = draftsFrom(kind, kind === "phone" ? contact.phone : contact.email, kind === "phone" ? contact.phone_type : contact.email_type, contact.channels ?? []);
  if (rows.length === 0) {
    return (
      <>
        <span aria-hidden="true" className="text-ink-soft">
          –
        </span>
        <span className="sr-only">לא הוזן</span>
      </>
    );
  }
  return (
    <ul className="space-y-1">
      {rows.map((row) => {
        // a primary without a stored type shows none (the form only suggests one)
        const type = channelTypeLabel(kind, row.primary ? (kind === "phone" ? contact.phone_type : contact.email_type) : row.type);
        const href = kind === "phone" ? `tel:${row.value.replace(/[^\d+]/g, "")}` : `mailto:${row.value}`;
        return (
          <li key={`${row.id ?? "primary"}-${row.value}`} className="flex flex-wrap items-baseline gap-x-2">
            <a href={href} dir="ltr" className="break-all text-accent underline underline-offset-4">
              {row.value}
            </a>
            {type || row.primary ? (
              <span className="text-sm text-ink-soft">{[type, row.primary && rows.length > 1 ? "ראשי" : null].filter(Boolean).join(" · ")}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
