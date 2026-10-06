import { SelectField, TextField } from "@/components/ui/field";
import type { CompanyOption } from "@/features/companies/queries";

export type ContactValues = {
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  job_title?: string | null;
  company_id?: string | null;
};

type Props = { values: ContactValues; errors: Record<string, string>; companies: CompanyOption[] };

/** The fields of a contact, shared by the create form and the edit form. */
export function ContactFields({ values, errors, companies }: Props) {
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
        <TextField
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          defaultValue={values.phone ?? ""}
          error={errors.phone}
        />
        <TextField
          label="אימייל"
          name="email"
          type="email"
          dir="ltr"
          inputMode="email"
          autoComplete="off"
          defaultValue={values.email ?? ""}
          error={errors.email}
        />
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
        <SelectField key={`company-${companyId}`} label="חברה" name="company_id" defaultValue={companyId} error={errors.company_id}>
          <option value="">ללא חברה</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </SelectField>
      </div>
      <p className="text-sm text-ink-soft">חובה למלא לפחות אחד: שם, טלפון או אימייל.</p>
    </>
  );
}
