import { describe, expect, it } from "vitest";

import { fillMessage, MERGE_FIELD_NAMES, unknownMergeFields } from "@/features/message-templates/fields";
import { messageTemplateProblem, SERVICE_BODY_MAX, SERVICE_TYPE_FIELDS } from "@/features/message-templates/service-rule";
import { DEFAULT_MEETING_CUSTOMER_TEMPLATES, MEETING_MESSAGE_WORDING_VERSION } from "@/features/message-templates/templates";
import {
  CONFIRM_EXPIRES_HOURS,
  CONFIRM_MIN_LEAD_MINUTES,
  MEETING_DAY_CAP,
  MEETING_REMINDERS_FEATURE,
  meetingChannel,
  REMINDER_WINDOWS,
  reminderDue,
} from "@/features/message-sending/meeting-messages";
import { meetingMessagesSchema } from "@/features/message-sending/schema";
import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";
import { dbErrorMessage } from "@/lib/errors";
import { PLAN_KEY_FALLBACK, PLAN_VALUES, SOLD_PLANS } from "@/lib/plan-keys";

import { latestMigration } from "./helpers/migrations";

const migration = latestMigration("create or replace function app.seed_meeting_customer_templates");
const sql = migration?.sql ?? "";

describe("meeting messages to the customer (CAL-12)", () => {
  it("owner (182): the eight templates equal their seed and pass the service rule as SMS and email", () => {
    expect(migration).toBeDefined();
    const seed = sql.slice(sql.indexOf("create or replace function app.seed_meeting_customer_templates"));
    expect(sql).toContain(`select '${MEETING_MESSAGE_WORDING_VERSION}'::text`);
    for (const d of DEFAULT_MEETING_CUSTOMER_TEMPLATES) {
      expect(seed, d.name).toContain(`'${d.name}', '${d.channel}', '${d.messageType}', ${d.subject === null ? "null::text" : `'${d.subject}'`},`);
      expect(seed, d.name).toContain(`'${d.body}', '${d.noticeKind}'`);
      expect(unknownMergeFields(`${d.subject ?? ""} ${d.body}`), d.name).toEqual([]);
      expect(messageTemplateProblem({ channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body }), d.name).toBeNull();
      if (d.channel === "sms") expect([...d.body].length, d.name).toBeLessThanOrEqual(SERVICE_BODY_MAX.sms);
    }
    expect(new Set(DEFAULT_MEETING_CUSTOMER_TEMPLATES.map((d) => `${d.noticeKind}:${d.channel}`)).size).toBe(8);
    expect(sql).toContain("'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour'));");
  });

  it("the optional location part shows only with a location; a preview keeps it as written", () => {
    const hour = DEFAULT_MEETING_CUSTOMER_TEMPLATES.find((d) => d.noticeKind === "meeting_hour")?.body ?? "";
    const base = { businessName: "הסטודיו", time: "10:00", businessPhone: "03-1234567" };
    expect(fillMessage(hour, { ...base, meetingLocation: "רחוב הרצל 5" })).toBe("הפגישה שלך עם הסטודיו מתחילה בשעה 10:00, ב-רחוב הרצל 5. הסטודיו, 03-1234567");
    expect(fillMessage(hour, { ...base, meetingLocation: null })).toBe("הפגישה שלך עם הסטודיו מתחילה בשעה 10:00. הסטודיו, 03-1234567");
    expect(fillMessage(hour, { ...base, meetingLocation: "  " })).toBe("הפגישה שלך עם הסטודיו מתחילה בשעה 10:00. הסטודיו, 03-1234567");
    expect(fillMessage(hour, base)).toContain("{, ב-{מיקום}}");
    const day = DEFAULT_MEETING_CUSTOMER_TEMPLATES.find((d) => d.noticeKind === "meeting_day")?.body ?? "";
    expect(fillMessage(day, { ...base, date: "12.11.2026", manageLink: "https://x", meetingLocation: "תל אביב" })).toContain("פגישה עם הסטודיו ב-תל אביב.");
    // a gender block is never read as an optional part
    expect(fillMessage("{זכר: שלום | נקבה: שלום לך | ניטרלי: היי} {שם פרטי}", { firstName: "דנה", gender: "female", meetingLocation: null })).toBe("שלום לך דנה");
  });

  it("the meeting's location and link are merge fields a meeting message may hold", () => {
    expect(MERGE_FIELD_NAMES.slice(-2)).toEqual(["מיקום", "קישור"]);
    expect(SERVICE_TYPE_FIELDS.meeting_reminder).toEqual(expect.arrayContaining(["meetingLocation", "manageLink"]));
    expect(SERVICE_TYPE_FIELDS.punch_card_notice).not.toContain("manageLink");
  });

  it("the timing and caps equal the migration's", () => {
    expect(sql).toContain(
      `('day', interval '${REMINDER_WINDOWS.day.from / 60} hours', interval '${REMINDER_WINDOWS.day.until / 60} hours', interval '${REMINDER_WINDOWS.day.afterConfirm / 60} hours')`,
    );
    expect(sql).toContain(
      `('hour', interval '${REMINDER_WINDOWS.hour.from} minutes', interval '${REMINDER_WINDOWS.hour.until} minutes', interval '${REMINDER_WINDOWS.hour.afterConfirm} minutes')`,
    );
    expect(sql).toContain(`new.starts_at > now() + interval '${CONFIRM_MIN_LEAD_MINUTES} minutes'`);
    expect(sql).toContain(`least(p_starts_at, now() + interval '${CONFIRM_EXPIRES_HOURS} hours')`);
    expect(sql).toContain(`select least(${MEETING_DAY_CAP}, greatest(1, coalesce(nullif(current_setting('app.meeting_customer_day_cap', true), '')::integer, ${MEETING_DAY_CAP})))`);
    expect(reminderDue("day", 24 * 60)).toBe(true);
    expect(reminderDue("day", 23 * 60 + 1)).toBe(true);
    expect(reminderDue("day", 23 * 60)).toBe(false);
    expect(reminderDue("day", 24 * 60 + 1)).toBe(false);
    expect(reminderDue("hour", 60)).toBe(true);
    expect(reminderDue("hour", 16)).toBe(true);
    expect(reminderDue("hour", 15)).toBe(false);
    expect(reminderDue("hour", 0)).toBe(false);
  });

  it("the channel: preferred SMS or email, then SMS, then email, with an address and a template", () => {
    const both = ["sms", "email"] as const;
    expect(meetingChannel({ preferred: "email", hasPhone: true, hasEmail: true, templates: both })).toBe("email");
    expect(meetingChannel({ preferred: "whatsapp", hasPhone: true, hasEmail: true, templates: both })).toBe("sms");
    expect(meetingChannel({ preferred: null, hasPhone: false, hasEmail: true, templates: both })).toBe("email");
    expect(meetingChannel({ preferred: "sms", hasPhone: true, hasEmail: true, templates: ["email"] })).toBe("email");
    expect(meetingChannel({ preferred: null, hasPhone: false, hasEmail: false, templates: both })).toBeNull();
    expect(sql).toContain("(values (cu.preferred_channel, 0), ('sms', 1), ('email', 2))");
  });

  it("owner (178) ב: the key in the plans of lead_distribution, off elsewhere; its gate has a message and a card line", () => {
    expect(SOLD_PLANS.map((plan) => PLAN_VALUES[plan].features[MEETING_REMINDERS_FEATURE])).toEqual(
      SOLD_PLANS.map((plan) => PLAN_VALUES[plan].features.lead_distribution),
    );
    expect((PLAN_KEY_FALLBACK.features as Record<string, boolean>)[MEETING_REMINDERS_FEATURE]).toBe(false);
    expect(sql).toContain(`hint = 'feature:${MEETING_REMINDERS_FEATURE}'`);
    expect(dbErrorMessage({ code: "P0001", message: "x", hint: `feature:${MEETING_REMINDERS_FEATURE}` })).not.toBe(
      dbErrorMessage({ code: "P0001", message: "x", hint: "feature:__none__" }),
    );
    expect(PLAN_CAPABILITIES.find((c) => c.feature === MEETING_REMINDERS_FEATURE)?.built).toBe(true);
  });

  it("the form: three boxes, unticked = off", () => {
    expect(meetingMessagesSchema.parse({ meeting_confirm: "on", meeting_remind_day: null, meeting_remind_hour: "on" })).toEqual({
      meeting_confirm: true,
      meeting_remind_day: false,
      meeting_remind_hour: true,
    });
  });
});
