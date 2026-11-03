import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mergeTimeline, messageEntryLabel, messageEntryText } from "@/features/messaging/timeline-entry";

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
