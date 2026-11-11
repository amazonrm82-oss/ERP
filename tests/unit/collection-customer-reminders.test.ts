import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COLLECTION_CUSTOMER_STAGES_DEFAULT,
  COLLECTION_STAGE_LABELS,
  COLLECTION_TASK_ALWAYS_STAGE,
  collectionCustomerReminderLine,
  collectionCustomerReminderOf,
  collectionCustomerReminderSchema,
  collectionCustomerStagesOf,
} from "@/features/collection/customer-reminder";
import { COLLECTION_REMINDER_OFFSETS } from "@/features/collection/reminders";
import { unknownMergeFields } from "@/features/message-templates/fields";
import { messageTemplateProblem, SERVICE_BODY_MAX } from "@/features/message-templates/service-rule";
import { COLLECTION_CUSTOMER_WORDING_VERSION, DEFAULT_COLLECTION_CUSTOMER_TEMPLATES } from "@/features/message-templates/templates";
import { cardEmailTemplates } from "@/features/record-email/logic";
import { cardSmsTemplates } from "@/features/record-sms/logic";

const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20261006021226_collection_customer_reminders.sql"), "utf8");

describe("COL-07 collection reminders to the customer", () => {
  it("the switch is off by default and only 'on' turns it on", () => {
    expect(migration).toContain("collection_customer_reminder boolean not null default false");
    expect(collectionCustomerReminderOf(undefined)).toBe(false);
    expect(collectionCustomerReminderOf(null)).toBe(false);
    expect(collectionCustomerReminderOf(true)).toBe(true);
    expect(collectionCustomerReminderSchema.safeParse({ collection_customer_reminder: "on", collection_customer_stages: [] }).data).toEqual({
      collection_customer_reminder: true,
      collection_customer_stages: [],
    });
    expect(collectionCustomerReminderSchema.safeParse({ collection_customer_reminder: null }).data).toEqual({
      collection_customer_reminder: false,
      collection_customer_stages: [],
    });
    expect(collectionCustomerReminderLine({ on: false, stages: [0] })).toBe("תזכורות ללקוח: כבויות.");
    expect(collectionCustomerReminderLine({ on: true, stages: [] })).toBe("תזכורות ללקוח: פועלות, אבל לא נבחר אף שלב.");
    expect(collectionCustomerReminderLine({ on: true, stages: [0, 14] })).toBe("תזכורות ללקוח: ביום מועד התשלום, 14 ימים אחרי מועד התשלום.");
  });

  it("(256) ג the stages: COL-04's offsets, default the due date, +7 and +14; (258) ב the task always at +14", () => {
    expect(migration).toContain("collection_customer_stages smallint[] not null default '{0,7,14}'");
    expect(migration).toContain("collection_customer_stages <@ array[-3, 0, 7, 14]::smallint[]");
    expect([...COLLECTION_CUSTOMER_STAGES_DEFAULT]).toEqual([0, 7, 14]);
    expect(COLLECTION_CUSTOMER_STAGES_DEFAULT.every((s) => (COLLECTION_REMINDER_OFFSETS as readonly number[]).includes(s))).toBe(true);
    expect(Object.keys(COLLECTION_STAGE_LABELS).map(Number).sort((a, b) => a - b)).toEqual([...COLLECTION_REMINDER_OFFSETS]);
    expect(collectionCustomerStagesOf(undefined)).toEqual([0, 7, 14]);
    expect(collectionCustomerStagesOf([14, -3])).toEqual([-3, 14]);
    expect(collectionCustomerStagesOf([])).toEqual([]);
    expect(collectionCustomerStagesOf([1])).toEqual([0, 7, 14]);
    const parsed = (stages: unknown) => collectionCustomerReminderSchema.safeParse({ collection_customer_reminder: "on", collection_customer_stages: stages });
    expect(parsed(["14", "0"]).data?.collection_customer_stages).toEqual([0, 14]);
    expect(parsed("7").data?.collection_customer_stages).toEqual([7]);
    expect(parsed(["5"]).success).toBe(false);
    expect(COLLECTION_TASK_ALWAYS_STAGE).toBe(14);
    expect(migration).toContain("if v_customer_outcome is distinct from 'queued' or v_row.offset_days = 14 then");
  });

  it("the seeded templates mirror the database and pass the service rule with the collection type's own fields", () => {
    expect(DEFAULT_COLLECTION_CUSTOMER_TEMPLATES).toHaveLength(2);
    expect(migration).toContain(`'${COLLECTION_CUSTOMER_WORDING_VERSION}'`);
    for (const d of DEFAULT_COLLECTION_CUSTOMER_TEMPLATES) {
      expect(migration, d.name).toContain(`'${d.name}', '${d.channel}', ${d.subject === null ? "null::text" : `'${d.subject}'`},`);
      expect(migration, d.name).toContain(`'${d.body}'`);
      expect(d.messageType).toBe("collection");
      expect(unknownMergeFields(`${d.subject ?? ""} ${d.body}`), d.name).toEqual([]);
      // no mark is needed for its fields: the text passes as a person's collection template too
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body, noticeKind: d.noticeKind }), d.name).toBeNull();
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body }), d.name).toBeNull();
      expect([...d.body].length).toBeLessThanOrEqual(SERVICE_BODY_MAX[d.channel]);
    }
    expect(new Set(DEFAULT_COLLECTION_CUSTOMER_TEMPLATES.map((d) => d.channel))).toEqual(new Set(["sms", "email"]));
  });

  it("a system template is never offered on a card", () => {
    const base = { id: "t", name: "x", subject: null, body: "שלום", locale: "he", isActive: true, messageType: "collection" as const };
    const marked = [{ ...base, channel: "email" as const, noticeKind: "collection_reminder" }, { ...base, channel: "sms" as const, noticeKind: "collection_reminder" }];
    expect(cardEmailTemplates(marked, true)).toEqual([]);
    expect(cardSmsTemplates(marked, true)).toEqual([]);
  });
});
