import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { toDbRule } from "@/features/automations/convert";
import { actionsFor, ACTION_LABELS } from "@/features/automations/definitions";
import { describeRule, STEP_ERRORS, STEP_WARNINGS, stepWarningText } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";
import { describeSendSms, offeredSmsTemplates, SEND_SMS_ENTITIES, sendSmsAction, sendSmsDraft, SMS_AUTOMATION_TYPES, SMS_COLLECTION_NEEDS_PAYMENTS, SMS_NOT_IN_PLAN } from "@/features/automations/send-sms";
import { actionOffered } from "@/features/automations/definitions";
import { planHintMessage } from "@/lib/errors";
import type { ClaimedJob } from "@/features/jobs/registry";
import { clearFakeSentMessages, createFakeProvider, fakeSentMessages } from "@/features/messaging/providers/fake";
import { createSendHandler, smsMessageParts } from "@/features/messaging/send-handler";
import {
  cardSmsTemplates,
  queuedSms,
  queuedSmsMessage,
  queuedSmsStateText,
  RECORD_SMS_HOURLY_LIMIT,
  SMS_SERVICE_TYPES,
  SMS_TOO_LONG,
  smsParts,
  smsPreview,
} from "@/features/record-sms/logic";
import { dbErrorMessage } from "@/lib/errors";

const root = join(__dirname, "..", "..");
const migration = (() => {
  const dir = join(root, "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_sms_b_send.sql"));
  if (!file) throw new Error("sms_b_send migration missing");
  return readFileSync(join(dir, file), "utf8");
})();

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const template = (over: Partial<Parameters<typeof cardSmsTemplates>[0][number]> = {}) => ({
  id: id(1),
  name: "מסמך",
  channel: "sms",
  messageType: "requested_document" as const,
  subject: null,
  body: "שלום {שם פרטי}, המסמך בדרך. {שם העסק}",
  isActive: true,
  ...over,
});

describe("SMS-02: the card's rules equal the database's", () => {
  it("the hourly limit and the service types are the migration's", () => {
    expect(migration).toContain(`select ${RECORD_SMS_HOURLY_LIMIT} $$`);
    expect(migration).toContain(`select array[${SMS_SERVICE_TYPES.map((t) => `'${t}'`).join(", ")}]::text[]`);
    expect([...SMS_AUTOMATION_TYPES]).toEqual(["marketing", ...SMS_SERVICE_TYPES]);
  });

  it("offers active SMS templates of marketing or a card's service type; collection only to a payment recorder", () => {
    const list = [
      template({ id: id(1) }),
      template({ id: id(2), channel: "email" }),
      template({ id: id(3), isActive: false }),
      template({ id: id(4), messageType: "meeting_reminder" }),
      template({ id: id(5), messageType: "marketing" }),
      template({ id: id(6), messageType: "collection" }),
      template({ id: id(7), messageType: "verification_code" }),
      template({ id: id(8), messageType: "punch_card_notice" }),
    ];
    expect(cardSmsTemplates(list, false).map((t) => t.id)).toEqual([id(1), id(5)]);
    expect(cardSmsTemplates(list, true).map((t) => t.id)).toEqual([id(1), id(5), id(6)]);
  });

  it("every hint the card's functions raise has a Hebrew message", () => {
    const hints = [...migration.matchAll(/hint = '(record_sms:[a-z_]+)'/g)].map((m) => m[1]);
    expect(hints.length).toBeGreaterThan(8);
    for (const hint of [...new Set(hints)]) {
      const message = dbErrorMessage({ code: "P0001", message: "x", hint }, "fallback");
      expect(message, hint).not.toBe("fallback");
    }
  });
});

describe("SMS-03 (card side): the SMS as it goes out", () => {
  const values = { firstName: "דנה", businessName: "מקסוז", businessPhone: "03-1234567", businessAddress: "הרצל 1, תל אביב" };

  it("a service SMS is filled as written; a marketing SMS gets 'פרסומת: ' in front, the sender line and the unsubscribe line", () => {
    const service = smsPreview({ messageType: "requested_document", body: "שלום {שם פרטי}, המסמך בדרך. {שם העסק}" }, values);
    expect(service).toMatchObject({ body: "שלום דנה, המסמך בדרך. מקסוז", marketing: false, tooLong: false, parts: 1 });
    const marketing = smsPreview({ messageType: "marketing", body: "שלום {שם פרטי}, מבצע החודש" }, values);
    expect(marketing.body.startsWith("פרסומת: שלום דנה, מבצע החודש")).toBe(true);
    expect(marketing.body).toContain("מקסוז · 03-1234567 · הרצל 1, תל אביב");
    expect(marketing.body).toContain("להסרה מרשימת התפוצה: {קישור הסרה}");
    expect(marketing.unfilled).toEqual(["{קישור הסרה}"]);
    expect(marketing.marketing).toBe(true);
  });

  it("is too long past 300 (service) or 600 (marketing, with the envelope) after filling, as app.message_filled_problem", () => {
    expect(smsPreview({ messageType: "requested_document", body: "א".repeat(300) }, values).tooLong).toBe(false);
    expect(smsPreview({ messageType: "requested_document", body: "א".repeat(301) }, values).tooLong).toBe(true);
    // a field filled long makes it too long
    expect(smsPreview({ messageType: "requested_document", body: `${"א".repeat(295)} {שם פרטי}` }, { firstName: "אברהםיצחק" }).tooLong).toBe(true);
    const short = smsPreview({ messageType: "marketing", body: "א".repeat(450) }, values);
    expect(short.tooLong).toBe(false);
    expect(smsPreview({ messageType: "marketing", body: "א".repeat(580) }, values).tooLong).toBe(true);
    expect(SMS_TOO_LONG).toContain("300");
  });

  it("counts SMS parts: Hebrew 70 / 67, the GSM alphabet 160 / 153", () => {
    expect(smsParts("")).toEqual({ characters: 0, parts: 0 });
    expect(smsParts("a".repeat(160))).toEqual({ characters: 160, parts: 1 });
    expect(smsParts("a".repeat(161))).toEqual({ characters: 161, parts: 2 });
    expect(smsParts("א".repeat(70))).toEqual({ characters: 70, parts: 1 });
    expect(smsParts("א".repeat(71))).toEqual({ characters: 71, parts: 2 });
    expect(smsParts("א".repeat(135))).toEqual({ characters: 135, parts: 3 });
    // one Hebrew letter makes the whole message 70 a part
    expect(smsParts(`${"a".repeat(100)}א`).parts).toBe(2);
  });
});

describe("SMS-02: the card's list", () => {
  it("parses the list and leaves malformed rows out", () => {
    expect(
      queuedSms([
        { job_id: "j1", created_at: "2026-11-10T08:00:00Z", template_name: "מסמך", sender_id: "u", state: "waiting", reason: null },
        { job_id: "j2", created_at: "2026-11-10T08:00:00Z", state: "not_sent", reason: "consent" },
        { job_id: "j3", created_at: "2026-11-10T08:00:00Z", state: "bogus" },
        { created_at: "x", state: "sent" },
        null,
      ]),
    ).toEqual([
      { jobId: "j1", createdAt: "2026-11-10T08:00:00Z", templateName: "מסמך", senderId: "u", state: "waiting", reason: null },
      { jobId: "j2", createdAt: "2026-11-10T08:00:00Z", templateName: null, senderId: null, state: "not_sent", reason: "consent" },
    ]);
    expect(queuedSms({})).toEqual([]);
  });

  it("says each state in plain words, never a code", () => {
    expect(queuedSmsStateText({ state: "waiting", reason: null })).toBe("ממתין לשליחה");
    expect(queuedSmsStateText({ state: "sent", reason: null })).toBe("נשלח");
    expect(queuedSmsStateText({ state: "not_sent", reason: "consent" })).toContain("SMS");
    expect(queuedSmsStateText({ state: "not_sent", reason: "paused" })).toContain("עצורה");
    expect(queuedSmsStateText({ state: "not_sent", reason: "other" })).toBe("לא נשלח");
    expect(queuedSmsMessage(true)).toContain("עצורה");
    expect(queuedSmsMessage(false)).toBe("ה-SMS ממתין לשליחה.");
  });
});

describe("SMS-02: the automation step send_sms", () => {
  const smsTemplates = [
    { id: id(1), name: "מסמך", messageType: "requested_document", isActive: true },
    { id: id(2), name: "מבצע", messageType: "marketing", isActive: true },
    { id: id(3), name: "כבויה", messageType: "marketing", isActive: false },
    { id: id(4), name: "תזכורת", messageType: "meeting_reminder", isActive: true },
    { id: id(5), name: "גבייה", messageType: "collection", isActive: true },
  ];

  it("is offered on lead, contact and deal rules only", () => {
    expect(ACTION_LABELS.send_sms).toBe("שליחת SMS");
    for (const entity of ["lead", "contact", "deal", "company", "task"] as const) {
      expect(actionsFor(entity).includes("send_sms"), entity).toBe(SEND_SMS_ENTITIES.includes(entity));
    }
  });

  it("the builder offers active templates of an allowed type, and keeps a saved rule's own", () => {
    expect(offeredSmsTemplates(smsTemplates).map((t) => t.id)).toEqual([id(1), id(2), id(5)]);
    expect(offeredSmsTemplates(smsTemplates, id(3)).map((t) => t.id)).toEqual([id(1), id(2), id(3), id(5)]);
  });

  it("stores {type, template_id} for an active template of the business; refuses another record type, a gone or off template", () => {
    expect(sendSmsAction("lead", { template_id: id(1) }, { sms: true, smsTemplates })).toEqual({ type: "send_sms", template_id: id(1) });
    expect(sendSmsAction("deal", { template_id: id(2) }, { sms: true, smsTemplates })).toEqual({ type: "send_sms", template_id: id(2) });
    expect(typeof sendSmsAction("task", { template_id: id(1) }, { sms: true, smsTemplates })).toBe("string");
    expect(typeof sendSmsAction("company", { template_id: id(1) }, { sms: true, smsTemplates })).toBe("string");
    expect(sendSmsAction("lead", { template_id: id(9) }, { sms: true, smsTemplates })).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(sendSmsAction("lead", { template_id: id(4) }, { sms: true, smsTemplates })).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(sendSmsAction("lead", { template_id: id(3) }, { sms: true, smsTemplates })).toContain("כבויה");
    // review F1: never without the plan's sms flag, and the builder offers the step only with it (a saved rule keeps its own)
    expect(sendSmsAction("lead", { template_id: id(1) }, { smsTemplates })).toBe(SMS_NOT_IN_PLAN);
    expect(sendSmsAction("lead", { template_id: id(1) }, { sms: false, smsTemplates })).toBe(SMS_NOT_IN_PLAN);
    expect(SMS_NOT_IN_PLAN).toBe(planHintMessage("feature:sms"));
    // review (2): a collection step only for a payment recorder (= trigger automations_sms_collection)
    expect(sendSmsAction("lead", { template_id: id(5) }, { sms: true, smsTemplates })).toBe(SMS_COLLECTION_NEEDS_PAYMENTS);
    expect(sendSmsAction("lead", { template_id: id(5) }, { sms: true, canRecordPayments: true, smsTemplates })).toEqual({ type: "send_sms", template_id: id(5) });
    expect(SMS_COLLECTION_NEEDS_PAYMENTS).toBe(planHintMessage("automation:sms_collection") ?? dbErrorMessage({ hint: "automation:sms_collection" }));
    expect(actionOffered("send_sms", {})).toBe(false);
    expect(actionOffered("send_sms", { sms: true })).toBe(true);
    expect(actionOffered("send_sms", {}, "send_sms")).toBe(true);
    expect(sendSmsDraft({ type: "send_sms", template_id: id(1) })).toEqual({ type: "send_sms", template_id: id(1) });
    expect(sendSmsDraft({ type: "send_sms" })).toEqual({ type: "send_sms", template_id: "" });
    expect(describeSendSms({ template_id: id(2) }, { smsTemplates })).toBe('"מבצע"');
    expect(describeSendSms({ template_id: id(9) }, { smsTemplates })).toBe("תבנית שנמחקה");
  });

  it("goes through the schema, toDbRule and describeRule", () => {
    const lookups: Lookups = { statuses: [], sources: [], tags: [], pipelines: [], members: [], teams: [], reasons: [], fields: {}, sms: true, smsTemplates };
    const parse = (trigger: string, actions: Array<Record<string, string>>) => ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions });
    const rule = toDbRule(parse("lead:created", [{ type: "send_sms", template_id: id(1) }]), lookups);
    if (typeof rule === "string") throw new Error(rule);
    expect(rule.actions).toEqual([{ type: "send_sms", template_id: id(1) }]);
    expect(toDbRule(parse("lead:created", [{ type: "send_sms", template_id: id(9) }]), lookups)).toBe("התבנית שנבחרה כבר לא קיימת.");
    expect(ruleSchema.safeParse({ name: "כלל", trigger: "lead:created", conditions: [], actions: [{ type: "send_sms", template_id: "x" }] }).success).toBe(false);
    const described = describeRule({ entity: "lead", triggerType: "created", triggerConfig: {}, conditions: [], actions: [{ type: "send_sms", template_id: id(1) }] }, lookups);
    expect(described.actions).toEqual(['שליחת SMS: "מסמך"']);
  });

  it("every error the step raises, and its warning, read in Hebrew", () => {
    const body = migration.slice(migration.indexOf("create or replace function app.automation_send_sms"), migration.indexOf("create or replace function app.run_automation_actions"));
    const errors = [...body.matchAll(/raise exception '((?:[^']|'')+)'/g)].map((m) => m[1].replaceAll("''", "'"));
    expect(errors.length).toBeGreaterThan(8);
    for (const error of errors) expect(STEP_ERRORS[error], error).toBeTruthy();
    expect(body).toContain("then 'customer sending is paused' end");
    expect(body).toContain("return 'an SMS was already sent today by this rule'");
    expect(stepWarningText("an SMS was already sent today by this rule")).toBe(STEP_WARNINGS["an SMS was already sent today by this rule"]);
    expect(stepWarningText("customer sending is paused")).toBe(STEP_WARNINGS["customer sending is paused"]);
  });
});

describe("SMS-02: the send handler hands an SMS's ids to the provider", () => {
  beforeEach(() => clearFakeSentMessages());
  const job = (payload: Record<string, unknown>): ClaimedJob => ({
    id: id(1),
    lease: id(2),
    kind: "message.send",
    organization_id: id(3),
    payload,
    attempt: 1,
  });

  it("reads the SMS ids, and only on an SMS", () => {
    expect(smsMessageParts({ channel: "sms", lead_id: id(4), template_id: id(5) })).toBeUndefined();
    expect(smsMessageParts({ template_id: id(5), sent_by_user_id: id(6) })).toEqual({ templateId: id(5), dealId: null, sentByUserId: id(6), automationId: null });
    expect(smsMessageParts({ deal_id: id(7), automation_id: id(8) })).toEqual({ templateId: null, dealId: id(7), sentByUserId: null, automationId: id(8) });
  });

  it("SMS-01b: a sender-number check's code goes to the provider as a sender_check, nothing a record carries", async () => {
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => createFakeProvider({ channel: "sms" }) });
    const result = await handler(job({ channel: "sms", message_type: "verification_code", sender_check_id: id(9) }));
    expect(result).toMatchObject({ status: "done" });
    expect(fakeSentMessages()[0]).toMatchObject({ channel: "sms", recordType: "sender_check", recordId: id(9), messageType: "verification_code" });
    // any other type naming a check is not a message
    expect(await handler(job({ channel: "sms", message_type: "marketing", sender_check_id: id(9) }))).toMatchObject({ status: "failed", error: "payload" });
  });

  it("gives the fake provider the SMS parts of a card's SMS", async () => {
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => createFakeProvider({ channel: "sms" }) });
    const result = await handler(job({ channel: "sms", contact_id: id(4), deal_id: id(7), message_type: "marketing", template_id: id(5), sent_by_user_id: id(6) }));
    expect(result).toMatchObject({ status: "done" });
    expect(fakeSentMessages()[0]).toMatchObject({
      channel: "sms",
      recordType: "contact",
      recordId: id(4),
      purpose: "marketing",
      sms: { templateId: id(5), dealId: id(7), sentByUserId: id(6), automationId: null },
    });
    expect(fakeSentMessages()[0]).not.toHaveProperty("email");
  });
});
