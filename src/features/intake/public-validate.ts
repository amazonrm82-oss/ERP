import { INTAKE_FIELD_LABELS, isIntakeField, type FormFieldConfig } from "./fields";

// The same rules intake_submit() applies (migration 0007), checked in the
// browser first so each wrong field gets its own message (FXA-02).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePublicForm(fields: FormFieldConfig[], values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  const value = (key: string) => (values[key] ?? "").trim();
  for (const field of fields) {
    if (field.required && !value(field.key)) {
      errors[field.key] = `יש למלא ${INTAKE_FIELD_LABELS[field.key]}.`;
    }
  }
  if (value("email") && !EMAIL.test(value("email"))) {
    errors.email = "כתובת האימייל לא תקינה. לדוגמה: name@example.co.il";
  }
  // a lead needs a way back to the person
  const shown = new Set(fields.map((field) => field.key));
  if (!value("full_name") && !value("phone") && !value("email")) {
    const first = (["full_name", "phone", "email"] as const).find((key) => shown.has(key));
    if (first && !errors[first]) errors[first] = "יש למלא שם, טלפון או אימייל.";
  }
  return errors;
}

/** The field an intake_submit() validation error is about (its messages are fixed in migration 0007). */
export function wrongField(message: string): string | undefined {
  if (message.startsWith("invalid email")) return "email";
  if (message.startsWith("a name, phone or email")) return "full_name";
  const missing = /^required field missing: (\w+)$/.exec(message);
  return missing && isIntakeField(missing[1]) ? missing[1] : undefined;
}
