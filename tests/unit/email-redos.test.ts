import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/features/custom-fields/types";
import { parseCustomFields } from "@/features/custom-fields/values";
import { type PublicField, validatePublicForm } from "@/features/intake/public-validate";

// The quadratic versions took 3.7 to 12 seconds on these inputs; the linear ones take a few
// milliseconds. A generous budget keeps the test meaningful without failing on a loaded CI runner.
const TIME_BUDGET_MS = 1000;

// RVW-3 follow-up: the email check's regex is quadratic on "a@...." with no end,
// so the length (254, as app.custom_value_ok() checks) is looked at first.

// ends in a character the regex never takes, so it tries every dot; trimming does not remove it
const HOSTILE = "a@" + ".".repeat(50_000) + " x";
const HOSTILE_AT = "a@" + ".".repeat(50_000) + "@";
const PUBLIC_EMAIL_ERROR = "כתובת האימייל לא תקינה. לדוגמה: name@example.co.il";

const emailField: FieldDefinition = {
  id: "mail",
  key: "mail",
  label: "מייל",
  type: "email",
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
};

function parseEmail(value: string) {
  const form = new FormData();
  form.append("cf_mail", value);
  return parseCustomFields([emailField], form);
}

const publicFields: PublicField[] = [
  { key: "full_name", required: false },
  { key: "email", required: false },
  { key: "cf:mail", required: false, custom: { type: "email", label: "מייל", options: [] } },
];

function timed<T>(run: () => T): T {
  const started = performance.now();
  const result = run();
  expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
  return result;
}

describe("email checks on hostile input", () => {
  it("a custom email field refuses 50,000 characters quickly", () => {
    expect(timed(() => parseEmail(HOSTILE)).errors.cf_mail).toBe("כתובת האימייל אינה תקינה.");
    expect(timed(() => parseEmail(HOSTILE_AT)).errors.cf_mail).toBe("כתובת האימייל אינה תקינה.");
  });

  it("the public form refuses it quickly, in the lead email and in a custom email field", () => {
    expect(timed(() => validatePublicForm(publicFields, { full_name: "דנה", email: HOSTILE })).email).toBe(PUBLIC_EMAIL_ERROR);
    expect(timed(() => validatePublicForm(publicFields, { full_name: "דנה", cf_mail: HOSTILE_AT })).cf_mail).toBe(
      "כתובת האימייל אינה תקינה.",
    );
  });

  it("normal emails still pass, and the limit is 254 as in the database", () => {
    expect(parseEmail("Dana@Example.co.il").values.mail).toBe("dana@example.co.il");
    expect(validatePublicForm(publicFields, { email: "dana@example.co.il", cf_mail: "x@y.example" })).toEqual({});
    const at254 = "a".repeat(254 - "@example.com".length) + "@example.com";
    expect(parseEmail(at254).errors).toEqual({});
    expect(parseEmail("a" + at254).errors.cf_mail).toBeTruthy();
    expect(parseEmail("dana@example").errors.cf_mail).toBeTruthy();
    expect(validatePublicForm(publicFields, { email: "dana@" })).toEqual({ email: PUBLIC_EMAIL_ERROR });
  });
});
