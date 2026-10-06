import type { ZodError } from "zod";

// Every Server Action returns this shape; the client never sees a thrown error.
export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | {
      ok: false;
      message: string;
      // per-field messages, keyed by form field name
      fieldErrors?: Record<string, string>;
      // what the user typed, so a failed form can be re-rendered without losing it
      // (React resets uncontrolled forms after an action). Never contains passwords.
      values?: Record<string, string>;
    };

// State type for useActionState: null until the form is submitted once.
export type FormState<T = undefined> = ActionResult<T> | null;

export function ok(): { ok: true };
export function ok<T>(data: T, message?: string): { ok: true; data: T; message?: string };
export function ok<T>(data?: T, message?: string): { ok: true; data?: T; message?: string } {
  return data === undefined ? { ok: true } : { ok: true, data, message };
}

export function fail(
  message: string,
  extra: { fieldErrors?: Record<string, string>; values?: Record<string, string> } = {},
): { ok: false; message: string; fieldErrors?: Record<string, string>; values?: Record<string, string> } {
  return { ok: false, message, ...extra };
}

export const FORM_INVALID = "יש לתקן את השדות המסומנים.";

/** First message per top-level field from a zod error. */
export function fieldErrorsFrom(error: ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_form";
    if (!(key in result)) {
      result[key] = issue.message;
    }
  }
  return result;
}

/** String entries of a submitted form, minus sensitive fields and React internals. */
export function formValues(formData: FormData, omit: string[] = ["password"]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION") && !omit.includes(key)) {
      values[key] = value;
    }
  }
  return values;
}

/** Failure result for a zod validation error, keeping what the user typed. */
export function invalid(error: ZodError, formData?: FormData) {
  const fieldErrors = fieldErrorsFrom(error);
  return fail(fieldErrors._form ?? FORM_INVALID, {
    fieldErrors,
    values: formData ? formValues(formData) : undefined,
  });
}
