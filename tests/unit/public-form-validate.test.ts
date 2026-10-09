import { describe, expect, it } from "vitest";

import { validatePublicForm, wrongField } from "@/features/intake/public-validate";

const fields = [
  { key: "full_name" as const, required: true },
  { key: "phone" as const, required: false },
  { key: "email" as const, required: false },
];

describe("public lead form checks (FXA-02)", () => {
  it("names each wrong field", () => {
    expect(validatePublicForm(fields, { full_name: " ", email: "dana@" })).toEqual({
      full_name: "יש למלא שם מלא.",
      email: "כתובת האימייל לא תקינה. לדוגמה: name@example.co.il",
    });
  });

  it("accepts what the server accepts", () => {
    expect(validatePublicForm(fields, { full_name: "דנה", phone: "*2700" })).toEqual({});
    expect(validatePublicForm([{ key: "phone", required: false }], { phone: "050-1234567" })).toEqual({});
  });

  it("asks for a way back to the person", () => {
    expect(validatePublicForm([{ key: "phone", required: false }, { key: "message", required: false }], { message: "שלום" })).toEqual({
      phone: "יש למלא שם, טלפון או אימייל.",
    });
  });

  it("maps the database's errors to the field", () => {
    expect(wrongField("invalid email address")).toBe("email");
    expect(wrongField("a name, phone or email is required")).toBe("full_name");
    expect(wrongField("required field missing: company_name")).toBe("company_name");
    expect(wrongField("required field missing: password")).toBeUndefined();
    expect(wrongField("something else")).toBeUndefined();
  });
});
