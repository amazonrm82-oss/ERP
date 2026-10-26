"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";
import { useEditFocus } from "@/features/data-quality/use-edit-focus";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { CompanyOption } from "@/features/companies/queries";
import { LayoutDetails } from "@/features/card-layout/components/layout-details";
import type { CardLayoutGroup } from "@/features/card-layout/layout";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { RecordType } from "@/features/record-type-options/schema";
import type { FormState } from "@/lib/action-result";
import { Detail, DetailList } from "@/components/detail-list";
import { paths } from "@/lib/paths";
import type { AttributionRow } from "@/features/intake/attribution";

import { updateContactAction } from "../actions";
import { channelTypeLabel, draftsFrom, type ChannelKind } from "../channels";
import { channelDetail, localeLabel } from "../preferences";
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
  // CON-10: form | manual (server-maintained); a form's value is marked on the card
  preferred_channel_source?: string | null;
  // formatted on the server so server and browser output cannot differ
  createdAtText: string;
  // SEG-02: the first source's campaign and UTM, and the latest automatic inquiry (source, campaign, UTM, time)
  firstSource?: AttributionRow[];
  lastSource?: AttributionRow[];
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues; builtins?: Record<string, string | null> };
};

// layout: the business's card layout (FLD-08); null or missing = the default layout
type Props = {
  orgId: string;
  contact: ContactDetailsView;
  // LEAD-08: null = the companies module is switched off (no picker; the stored company is kept)
  companies: CompanyOption[] | null;
  types: RecordType[];
  canEdit: boolean;
  focus?: string | null;
  layout?: CardLayoutGroup[] | null;
  // FLD-10: the business's words
  terms?: OrgTerms;
};

/** Contact details that switch in place between reading and editing. */
export function ContactDetailsCard({ orgId, contact, companies, types, canEdit, focus, layout = null, terms = DEFAULT_TERMS }: Props) {
  // DQL-01: a missing field on the completeness card opens the card for editing at that input
  const [editing, setEditing] = useState(Boolean(focus) && canEdit);
  useEditFocus("contact-details-title", focus, editing);

  if (editing) {
    // mounted only while editing, so every edit starts with a clean form state
    return <ContactEditForm orgId={orgId} contact={contact} companies={companies} types={types} onDone={() => setEditing(false)} terms={terms} />;
  }

  return (
    <Card aria-labelledby="contact-details-title">
      <CardHeader
        id="contact-details-title"
        title={`פרטי ${terms.contact.theSingular}`}
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
          type="contact"
          idPrefix="contact-details"
          layout={layout}
          custom={contact.custom}
          builtIn={{
            full_name: { value: contact.full_name },
            phone: { value: <ChannelList kind="phone" contact={contact} /> },
            email: { value: <ChannelList kind="email" contact={contact} /> },
            job_title: { value: contact.job_title },
            company_id: companies
              ? {
                  value:
                    contact.company_id && contact.companyName ? (
                      <Link href={paths.company(orgId, contact.company_id)} className="text-accent underline underline-offset-4">
                        {contact.companyName}
                      </Link>
                    ) : null,
                }
              : null,
            type: { value: contact.typeName ?? contact.contact_type },
            birth_date: { value: contact.birthDateText },
            preferred_locale: { value: localeLabel(contact.preferred_locale) },
            // CON-10: "(מטופס)" when the channel came from a public form
            preferred_channel: { value: channelDetail(contact.preferred_channel, contact.preferred_channel_source) },
            source_id: { value: contact.sourceName },
            owner_id: { value: contact.ownerName },
            created_at: { value: contact.createdAtText },
          }}
        />
        <SourceSection id="contact-first-source-title" title="פרטי המקור הראשון" rows={contact.firstSource} />
        <SourceSection id="contact-last-source-title" title="פנייה אחרונה" rows={contact.lastSource} />
      </CardBody>
    </Card>
  );
}

function SourceSection({ id, title, rows }: { id: string; title: string; rows?: AttributionRow[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section aria-labelledby={id} className="mt-4 border-t border-line pt-4">
      <h3 id={id} className="mb-3 text-sm text-ink-soft">
        {title}
      </h3>
      <DetailList>
        {rows.map((row) => (
          <Detail key={row.label} label={row.label} value={row.value} ltr={row.ltr} />
        ))}
      </DetailList>
    </section>
  );
}

type EditProps = { orgId: string; contact: ContactDetailsView; companies: CompanyOption[] | null; types: RecordType[]; onDone: () => void; terms: OrgTerms };

function ContactEditForm({ orgId, contact, companies, types, onDone, terms }: EditProps) {
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
      <CardHeader id="contact-details-title" title={`עריכת ${terms.contact.theSingular}`} />
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
            record={{ object: "contact", id: contact.id }}
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
