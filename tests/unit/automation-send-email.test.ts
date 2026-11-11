import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { toDbRule } from "@/features/automations/convert";
import { actionOffered, actionsFor, ACTION_LABELS } from "@/features/automations/definitions";
import { describeRule, STEP_ERRORS, STEP_WARNINGS, stepWarningText } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import {
  describeSendEmail,
  EMAIL_AUTOMATION_TYPES,
  EMAIL_COLLECTION_NEEDS_PAYMENTS,
  offeredEmailTemplates,
  SEND_EMAIL_ENTITIES,
  sendEmailAction,
  sendEmailDraft,
} from "@/features/automations/send-email";
import { recordEmailParts } from "@/features/messaging/send-handler";
import { planHintMessage } from "@/lib/errors";

const dir = join(__dirname, "..", "..", "supabase", "migrations");
const read = (suffix: string) => {
  const file = readdirSync(dir).find((f) => f.endsWith(suffix));
  if (!file) throw new Error(`${suffix} missing`);
  return readFileSync(join(dir, file), "utf8");
};
const migration = read("_automation_send_email.sql");
const recordEmail = read("_record_email.sql");

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const emailTemplates = [
  { id: id(1), name: "מסמך", messageType: "requested_document", isActive: true },
  { id: id(2), name: "מבצע", messageType: "marketing", isActive: true },
  { id: id(3), name: "כבויה", messageType: "marketing", isActive: false },
  { id: id(4), name: "תזכורת", messageType: "meeting_reminder", isActive: true },
  { id: id(5), name: "גבייה", messageType: "collection", isActive: true },
];

describe("AUT-08: the automation step send_email", () => {
  it("is offered on lead, contact and deal rules only, without a plan flag", () => {
    expect(ACTION_LABELS.send_email).toBe("שליחת אימייל");
    for (const entity of ["lead", "contact", "deal", "company", "task"] as const) {
      expect(actionsFor(entity).includes("send_email"), entity).toBe(SEND_EMAIL_ENTITIES.includes(entity));
    }
    expect(actionOffered("send_email", {})).toBe(true);
  });

  it("the types equal marketing + app.record_email_service_types", () => {
    const match = /function app\.record_email_service_types\(\)[^$]*\$\$ select array\[([^\]]*)\]::text\[\] \$\$/.exec(recordEmail);
    expect(match).not.toBeNull();
    const service = (match?.[1] ?? "").split(",").map((s) => s.trim().replaceAll("'", ""));
    expect([...EMAIL_AUTOMATION_TYPES]).toEqual(["marketing", ...service]);
  });

  it("the builder offers active templates of an allowed type, and keeps a saved rule's own", () => {
    expect(offeredEmailTemplates(emailTemplates).map((t) => t.id)).toEqual([id(1), id(2), id(5)]);
    expect(offeredEmailTemplates(emailTemplates, id(3)).map((t) => t.id)).toEqual([id(1), id(2), id(3), id(5)]);
  });

  it("stores {type, template_id}; refuses another record type, a gone or off template; collection only for a payment recorder", () => {
    expect(sendEmailAction("lead", { template_id: id(1) }, { emailTemplates })).toEqual({ type: "send_email", template_id: id(1) });
    expect(sendEmailAction("deal", { template_id: id(2) }, { emailTemplates })).toEqual({ type: "send_email", template_id: id(2) });
    expect(typeof sendEmailAction("task", { template_id: id(1) }, { emailTemplates })).toBe("string");
    expect(typeof sendEmailAction("company", { template_id: id(1) }, { emailTemplates })).toBe("string");
    expect(sendEmailAction("lead", { template_id: id(9) }, { emailTemplates })).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(sendEmailAction("lead", { template_id: id(4) }, { emailTemplates })).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(sendEmailAction("lead", { template_id: id(3) }, { emailTemplates })).toContain("כבויה");
    expect(sendEmailAction("lead", { template_id: id(5) }, { emailTemplates })).toBe(EMAIL_COLLECTION_NEEDS_PAYMENTS);
    expect(sendEmailAction("lead", { template_id: id(5) }, { canRecordPayments: true, emailTemplates })).toEqual({ type: "send_email", template_id: id(5) });
    expect(EMAIL_COLLECTION_NEEDS_PAYMENTS).toBe(planHintMessage("automation:email_collection"));
    expect(sendEmailDraft({ type: "send_email", template_id: id(1) })).toEqual({ type: "send_email", template_id: id(1) });
    expect(sendEmailDraft({ type: "send_email" })).toEqual({ type: "send_email", template_id: "" });
    expect(describeSendEmail({ template_id: id(2) }, { emailTemplates })).toBe('"מבצע"');
    expect(describeSendEmail({ template_id: id(9) }, { emailTemplates })).toBe("תבנית שנמחקה");
  });

  it("goes through the schema, toDbRule and describeRule", () => {
    const lookups: Lookups = { statuses: [], sources: [], tags: [], pipelines: [], members: [], teams: [], reasons: [], fields: {}, emailTemplates };
    const parse = (trigger: string, actions: Array<Record<string, string>>) => ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions });
    const rule = toDbRule(parse("lead:created", [{ type: "send_email", template_id: id(1) }]), lookups);
    if (typeof rule === "string") throw new Error(rule);
    expect(rule.actions).toEqual([{ type: "send_email", template_id: id(1) }]);
    expect(toDbRule(parse("lead:created", [{ type: "send_email", template_id: id(9) }]), lookups)).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "lead:created", conditions: [], actions: [{ type: "send_email", template_id: "x" }] }).success).toBe(false);
    const described = describeRule({ entity: "lead", triggerType: "created", triggerConfig: {}, conditions: [], actions: [{ type: "send_email", template_id: id(1) }] }, lookups);
    expect(described.actions).toEqual(['שליחת אימייל: "מסמך"']);
  });

  it("every error the step raises, and its warnings, read in Hebrew", () => {
    const body = migration.slice(migration.indexOf("create or replace function app.automation_send_email"), migration.indexOf("create or replace function app.run_automation_actions"));
    const errors = [...body.matchAll(/raise exception '((?:[^']|'')+)'/g)].map((m) => m[1].replaceAll("''", "'"));
    expect(errors.length).toBeGreaterThan(9);
    for (const error of errors) expect(STEP_ERRORS[error], error).toBeTruthy();
    for (const warning of ["customer sending is paused", "an email was already sent today by this rule", "too many emails this hour by the person who pressed"]) {
      expect(body).toContain(`'${warning}'`);
      expect(stepWarningText(warning)).toBe(STEP_WARNINGS[warning]);
    }
    // the engine lists send_email among the steps that carry a warning
    expect(migration).toContain("'create_quote', 'send_sms', 'send_email') and v_warning is not null");
  });

  it("the send handler names an automation's email by its rule", () => {
    expect(recordEmailParts({ automation_id: id(1), template_id: id(2) })).toEqual({
      templateId: id(2),
      dealId: null,
      fileIds: [],
      libraryFileIds: [],
      replyToUserId: null,
      automationId: id(1),
    });
    expect(recordEmailParts({ reply_to_user_id: id(1) })).not.toHaveProperty("automationId");
  });
});
