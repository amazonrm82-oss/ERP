import { describe, expect, it } from "vitest";

import { MESSAGE_MERGE_FIELDS } from "@/features/message-templates/fields";
import {
  assertTemplateSendable,
  messageTemplateProblem,
  SERVICE_BODY_MAX,
  SERVICE_TYPE_FIELDS,
  templateProblemText,
  TemplateNotSendableError,
  type TemplateText,
} from "@/features/message-templates/service-rule";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/features/message-templates/templates";
import { SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";

import cases from "./fixtures/message-template-problems.json";
import { latestMigration } from "./helpers/migrations";

const sql = latestMigration("create or replace function app.message_template_problem(")?.sql ?? "";

describe("service template rule (MSG-02, owner (90) ג)", () => {
  it.each(cases.map((c) => [c.note, c]))("%s", (_note, c) => {
    expect(messageTemplateProblem(c as TemplateText)).toBe(c.problem);
  });

  it("the allowed fields per type equal app.message_type_fields", () => {
    expect(sql).not.toBe("");
    expect(Object.keys(SERVICE_TYPE_FIELDS).sort()).toEqual([...SERVICE_MESSAGE_TYPES].sort());
    for (const type of SERVICE_MESSAGE_TYPES) {
      const match = sql.match(new RegExp(`when '${type}' then array\\[([^\\]]*)\\]`));
      expect(match, type).not.toBeNull();
      const names = [...(match?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(names, type).toEqual(SERVICE_TYPE_FIELDS[type].map((key) => MESSAGE_MERGE_FIELDS[key].token.slice(1, -1)));
    }
  });

  it("the caps equal app.message_service_body_max", () => {
    expect(sql).toContain(
      `case p_channel when 'sms' then ${SERVICE_BODY_MAX.sms} when 'whatsapp' then ${SERVICE_BODY_MAX.whatsapp} when 'email' then ${SERVICE_BODY_MAX.email} end`,
    );
  });

  it("every default service template may be sent", () => {
    for (const d of DEFAULT_MESSAGE_TEMPLATES) expect(messageTemplateProblem(d), d.name).toBeNull();
  });

  it("says why in Hebrew, and the sender gate throws", () => {
    const base = { channel: "sms" as const, messageType: "collection" as const, subject: null };
    expect(templateProblemText({ ...base, body: "{תאריך}" })).toMatch(/^התבנית לא תישלח: .*\{תאריך\}/);
    expect(templateProblemText({ ...base, body: "www.x.com" })).toContain("קישור");
    expect(templateProblemText({ ...base, body: "א".repeat(301) })).toContain("300");
    expect(templateProblemText({ ...base, body: "שלום {שם פרטי}" })).toBeNull();
    expect(() => assertTemplateSendable({ ...base, body: "שלום", isActive: true })).not.toThrow();
    expect(() => assertTemplateSendable({ ...base, body: "שלום", isActive: false })).toThrow(TemplateNotSendableError);
    expect(() => assertTemplateSendable({ ...base, body: "https://x.com", isActive: true })).toThrow(/external_link/);
  });
});
