import { SelectField, TextField } from "@/components/ui/field";
import type { CompanyOption } from "@/features/companies/queries";
import { RecordTypeField } from "@/features/record-type-options/components/type-field";
import type { RecordType } from "@/features/record-type-options/schema";

import { draftsFrom, type ChannelDraft, type ChannelKind, type StoredChannel } from "../channels";
import { CHANNEL_OPTIONS, LOCALE_OPTIONS } from "../preferences";
import { ChannelsEditor } from "./channels-editor";

export type ContactValues = {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  job_title?: string | null;
  company_id?: string | null;
  birth_date?: string | null;
  // CON-10
  preferred_locale?: string | null;
  preferred_channel?: string | null;
  // CON-02
  type_id?: string | null;
  // CON-01: the primary's types and the further phones and emails as stored ...
  phone_type?: string | null;
  email_type?: string | null;
  channels?: StoredChannel[];
  // ... or as the form sent them (JSON), after a failed save
  phones?: string;
  emails?: string;
};

/** The editor's rows: what the form sent when a save failed, else what is stored. */
function initialDrafts(kind: ChannelKind, values: ContactValues): ChannelDraft[] {
  const sent = kind === "phone" ? values.phones : values.emails;
  if (typeof sent === "string") {
    try {
      const rows: unknown = JSON.parse(sent);
      if (Array.isArray(rows)) {
        return rows
          .filter((r): r is ChannelDraft => typeof r === "object" && r !== null && typeof r.value === "string" && typeof r.type === "string")
          .map((r) => ({ id: typeof r.id === "string" ? r.id : null, type: r.type, value: r.value, primary: r.primary === true }));
      }
    } catch {
      // fall back to what is stored
    }
  }
  return kind === "phone"
    ? draftsFrom("phone", values.phone, values.phone_type, values.channels ?? [])
    : draftsFrom("email", values.email, values.email_type, values.channels ?? []);
}

type Props = {
  values: ContactValues;
  errors: Record<string, string>;
  // LEAD-08: null = the companies module is switched off (no picker; the stored company is kept)
  companies: CompanyOption[] | null;
  // the organization's contact types, and the older free-text type of the contact
  types: RecordType[];
  legacyType?: string | null;
};

/** The fields of a contact, shared by the create form and the edit form. */
export function ContactFields({ values, errors, companies, types, legacyType }: Props) {
  const companyId = values.company_id ?? "";
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="שם פרטי"
          name="first_name"
          autoComplete="off"
          maxLength={100}
          defaultValue={values.first_name ?? ""}
          error={errors.first_name}
        />
        <TextField
          label="שם משפחה"
          name="last_name"
          autoComplete="off"
          maxLength={100}
          defaultValue={values.last_name ?? ""}
          error={errors.last_name}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ChannelsEditor kind="phone" initial={initialDrafts("phone", values)} error={errors.phones} />
        <ChannelsEditor kind="email" initial={initialDrafts("email", values)} error={errors.emails} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="תפקיד"
          name="job_title"
          autoComplete="off"
          maxLength={120}
          defaultValue={values.job_title ?? ""}
          error={errors.job_title}
        />
        {/* key: a select only takes defaultValue on mount */}
        {companies ? (
          <SelectField key={`company-${companyId}`} label="חברה" name="company_id" defaultValue={companyId} error={errors.company_id}>
            <option value="">ללא חברה</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </SelectField>
        ) : (
          // LEAD-08: companies switched off; the stored company is sent back unchanged
          <input type="hidden" name="company_id" value={companyId} />
        )}
      </div>
      <RecordTypeField types={types} value={values.type_id} legacy={legacyType} label="סוג איש קשר" error={errors.type_id} className="sm:max-w-xs" />
      <TextField label="יום הולדת" name="birth_date" type="date" defaultValue={values.birth_date ?? ""} error={errors.birth_date} className="sm:max-w-56" />
      {/* CON-10: how the person likes to be addressed; shown on the card, nothing sends by it yet */}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          key={`locale-${values.preferred_locale ?? ""}`}
          label="שפה מועדפת"
          name="preferred_locale"
          defaultValue={values.preferred_locale ?? ""}
          error={errors.preferred_locale}
        >
          <option value="">לא צוין</option>
          {LOCALE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          key={`channel-${values.preferred_channel ?? ""}`}
          label="ערוץ מועדף"
          name="preferred_channel"
          defaultValue={values.preferred_channel ?? ""}
          error={errors.preferred_channel}
        >
          <option value="">לא צוין</option>
          {CHANNEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </div>
      <p className="text-sm text-ink-soft">חובה למלא לפחות אחד: שם, טלפון או אימייל.</p>
    </>
  );
}
