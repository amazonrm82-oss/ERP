import { SelectField, TextField } from "@/components/ui/field";
import { CheckedTextField } from "@/features/data-quality/components/checked-field";
import { INDUSTRIES } from "@/features/onboarding/options";
import { RecordTypeField } from "@/features/record-type-options/components/type-field";
import type { RecordType } from "@/features/record-type-options/schema";

import { CompanyNumberFields } from "./company-number-fields";
import { ParentCompanyPicker, type ParentChoice } from "./parent-company-picker";

export type CompanyValues = {
  name?: string | null;
  // CON-04: ISO code, "IL" by default
  country?: string | null;
  tax_id?: string | null;
  industry?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  city?: string | null;
  address_line?: string | null;
  // CON-02
  type_id?: string | null;
};

type Props = {
  values: CompanyValues;
  errors: Record<string, string>;
  // the organization's company types, and the older free-text type of the company
  types: RecordType[];
  legacyType?: string | null;
  // CON-07: the parent company picker; the company being edited ("" on the create form)
  parent: { orgId: string; companyId: string; initial: ParentChoice };
};

/** The fields of a company, shared by the create form and the edit form. */
export function CompanyFields({ values, errors, types, legacyType, parent }: Props) {
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
      <CompanyNumberFields country={values.country} taxId={values.tax_id} errors={errors} />
      {/* key: a select only takes defaultValue on mount */}
      <SelectField
        key={`industry-${industry}`}
        label="ענף"
        name="industry"
        defaultValue={industry}
        error={errors.industry}
        className="sm:max-w-xs"
      >
        <option value="">לא נבחר</option>
        {INDUSTRIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        <CheckedTextField
          check="phone"
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          defaultValue={values.phone ?? ""}
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
          defaultValue={values.email ?? ""}
          error={errors.email}
        />
      </div>
      <RecordTypeField types={types} value={values.type_id} legacy={legacyType} label="סוג חברה" error={errors.type_id} className="sm:max-w-xs" />
      <ParentCompanyPicker orgId={parent.orgId} companyId={parent.companyId} initial={parent.initial} error={errors.parent_company_id} />
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
