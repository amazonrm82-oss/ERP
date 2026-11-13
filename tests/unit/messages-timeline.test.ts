import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mergeTimeline, messageEntryLabel, messageEntryText, REFUSED } from "@/features/messaging/timeline-entry";

const root = join(__dirname, "..", "..");

describe("MSG-03: messages on the timeline", () => {
  it("names channel and direction, and says the delivery status only", () => {
    expect(messageEntryLabel({ channel: "sms", direction: "outbound", status: "sent" })).toBe("SMS יוצא");
    expect(messageEntryLabel({ channel: "email", direction: "inbound", status: "received" })).toBe("אימייל נכנס");
    expect(messageEntryLabel({ channel: "whatsapp", direction: "outbound", status: "read" })).toBe("הודעת WhatsApp יוצאת");
    expect(messageEntryLabel({ channel: "fax", direction: "outbound", status: "sent" })).toBe("הודעה יוצאת");
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed" })).toBe("השליחה נכשלה.");
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "delivered" })).toBe("נמסרה.");
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "unknown" })).toBe("");
    // owner (96): a message refused for its filled length reads "ארוכה מדי"
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed", provider_error_code: "too_long" })).toBe("לא נשלחה: ארוכה מדי.");
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed", provider_error_code: "E42" })).toBe("השליחה נכשלה.");
    // review item 7: a provider's own code that reads too_long is a provider failure
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed", provider: "fake", provider_error_code: "too_long" })).toBe(
      "השליחה נכשלה.",
    );
  });

  // RVW-89: every final refusal of the SMS composer has its own Hebrew line on the timeline
  it("has a line for every refusal code the SMS composer ends a job with", () => {
    const file = readdirSync(join(root, "supabase", "migrations")).find((f) => f.endsWith("_sms_compose.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(root, "supabase", "migrations", file as string), "utf8");
    const literal = [...sql.matchAll(/'refused', '([a-z_]+)'/g)].map((m) => m[1]);
    // the codes it passes on: app.message_template_sendable / app.message_filled_problem, app.collection_customer_refusal,
    // public.meeting_reminder_link and public.consent_preference_link_for_job
    const passed = ["not_found", "inactive", "field_not_allowed", "external_link", "glued_address", "offer", "too_long",
      "reminder_off", "stage_off", "business_off", "debt_settled", "customer_changed",
      "business", "meeting_changed", "no_link_field", "not_a_meeting_message", "no_customer", "service_type"];
    // never final: the worker tries the job again (send-handler.ts), so no message row carries them
    const retried = new Set(["stale", "paused", "site_url"]);
    const codes = [...new Set([...literal, ...passed])].filter((c) => !retried.has(c));
    expect(codes.length).toBeGreaterThan(30);
    for (const code of codes) {
      expect(REFUSED[code], code).toMatch(/^לא נשלחה: .+\.$/);
      expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed", provider_error_code: code })).toBe(REFUSED[code]);
    }
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed", provider_error_code: "unfilled_field" })).toContain("כתובת או טלפון העסק");
    expect(messageEntryText({ channel: "sms", direction: "outbound", status: "failed", provider_error_code: "constructor" })).toBe("השליחה נכשלה.");
  });

  it("keeps pinned entries on top and puts messages among the rest by time", () => {
    const e = (id: string, at: string, pinned = false) => ({ id, occurredAt: at, pinned });
    const merged = mergeTimeline(
      [e("pin", "2026-01-01T00:00:00Z", true), e("note-new", "2026-03-01T00:00:00Z"), e("note-old", "2026-01-15T00:00:00Z")],
      [e("msg", "2026-02-01T00:00:00Z")],
    );
    expect(merged.map((x) => x.id)).toEqual(["pin", "note-new", "msg", "note-old"]);
    const alone = [e("a", "2026-01-01T00:00:00Z")];
    expect(mergeTimeline(alone, [])).toBe(alone);
  });

  it("bounds the page to one time window when either list came back full", () => {
    const e = (id: string, day: number, pinned = false) => ({ id, occurredAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`, pinned });
    const entries = [e("pin", 1, true), e("n20", 20), e("n10", 10)];
    const messages = [e("m25", 25), e("m15", 15), e("m5", 5)];
    // nothing full: everything, by time
    expect(mergeTimeline(entries, messages).map((x) => x.id)).toEqual(["pin", "m25", "n20", "m15", "n10", "m5"]);
    // the entries came back full: no message older than the oldest entry (day 10); the pinned one stays
    expect(mergeTimeline(entries, messages, { entries: true, messages: false }).map((x) => x.id)).toEqual(["pin", "m25", "n20", "m15", "n10"]);
    // the messages came back full: no entry older than the oldest message (day 5) is cut, but day 15 bounds a later list
    expect(mergeTimeline(entries, [e("m25", 25), e("m15", 15)], { entries: false, messages: true }).map((x) => x.id)).toEqual(["pin", "m25", "n20", "m15"]);
    // both full: the later of the two floors
    expect(mergeTimeline(entries, [e("m25", 25), e("m15", 15)], { entries: true, messages: true }).map((x) => x.id)).toEqual(["pin", "m25", "n20", "m15"]);
    // a page and the next one with the same window never share an item
    const first = mergeTimeline([e("n20", 20), e("n10", 10)], [e("m25", 25), e("m5", 5)], { entries: true, messages: false });
    const next = mergeTimeline([e("n8", 8)], [e("m5", 5)], { entries: false, messages: false });
    expect(first.map((x) => x.id).filter((id) => next.some((n) => n.id === id))).toEqual([]);
  });

  it("every status and channel the table allows has its words", () => {
    const dir = join(root, "supabase/migrations");
    const sql = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith("_messages.sql")) as string), "utf8");
    const statuses = [...(sql.match(/status in \(([^)]*)\)\)/)?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(statuses).toEqual(["sent", "delivered", "read", "failed"]);
    for (const status of [...statuses, "received"]) expect(messageEntryText({ channel: "sms", direction: "outbound", status }), status).not.toBe("");
    for (const channel of ["email", "sms", "whatsapp"]) {
      expect(messageEntryLabel({ channel, direction: "outbound", status: "sent" })).not.toMatch(/^הודעה /);
      expect(messageEntryLabel({ channel, direction: "inbound", status: "received" })).not.toMatch(/^הודעה /);
    }
  });
});
