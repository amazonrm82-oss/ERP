import { SelectField, TextField } from "@/components/ui/field";
import { INDUSTRIES } from "@/features/onboarding/options";

export type CompanyValues = {
  name?: string | null;
  tax_id?: string | null;
  industry?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  city?: string | null;
  address_line?: string | null;
};

type Props = { values: CompanyValues; errors: Record<string, string> };

/** The fields of a company, shared by the create form and the edit form. */
export function CompanyFields({ values, errors }: Props) {
  const industry = values.industry ?? "";
  return (
    <>
      <TextField
        label="שם החברה"
        name="name"
        required
        maxLength={200}
        autoComplete="off"
        defaultValue={values.name ?? ""}
        error={errors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="ח.פ. או עוסק מורשה"
          name="tax_id"
          dir="ltr"
          inputMode="numeric"
          maxLength={20}
          autoComplete="off"
          defaultValue={values.tax_id ?? ""}
          error={errors.tax_id}
        />
        {/* key: a select only takes defaultValue on mount */}
        <SelectField key={`industry-${industry}`} label="ענף" name="industry" defaultValue={industry} error={errors.industry}>
          <option value="">לא נבחר</option>
          {INDUSTRIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
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
      <TextField
        label="אתר"
        name="website"
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        placeholder="example.co.il"
        defaultValue={values.website ?? ""}
        error={errors.website}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="עיר" name="city" maxLength={100} autoComplete="off" defaultValue={values.city ?? ""} error={errors.city} />
        <TextField
          label="כתובת"
          name="address_line"
          maxLength={200}
          autoComplete="off"
          defaultValue={values.address_line ?? ""}
          error={errors.address_line}
        />
      </div>
    </>
  );
}
