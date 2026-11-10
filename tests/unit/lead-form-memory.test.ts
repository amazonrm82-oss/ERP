import { describe, expect, it } from "vitest";

import {
  cleanPastedPhone,
  duplicateLookupInput,
  leadFormMemoryKey,
  readLeadFormMemory,
  serializeLeadFormMemory,
} from "@/features/leads/form-memory";
import type { LeadSourceOption, LeadStatusOption } from "@/features/leads/queries";

// UX-03: the new-lead form remembers the last source and status per user and business, cleans a pasted
// phone and checks for duplicates while typing.

const sources: LeadSourceOption[] = [
  { id: "s-web", name: "אתר", isActive: true },
  { id: "s-old", name: "ישן", isActive: false },
];
const statuses: LeadStatusOption[] = [
  { id: "st-new", name: "חדש", kind: "open", isDefault: true },
  { id: "st-work", name: "בטיפול", kind: "open", isDefault: false },
  { id: "st-no", name: "לא רלוונטי", kind: "disqualified", isDefault: false },
  { id: "st-conv", name: "הומר", kind: "converted", isDefault: false },
];

describe("remembered source and status (UX-03)", () => {
  it("keys by business and user", () => {
    expect(leadFormMemoryKey("u1", "o1")).not.toBe(leadFormMemoryKey("u2", "o1"));
    expect(leadFormMemoryKey("u1", "o1")).not.toBe(leadFormMemoryKey("u1", "o2"));
  });

  it("round-trips a choice", () => {
    const raw = serializeLeadFormMemory({ sourceId: "s-web", statusId: "st-work" });
    expect(readLeadFormMemory(raw, sources, statuses)).toEqual({ sourceId: "s-web", statusId: "st-work" });
  });

  it("remembers 'no source' as nothing", () => {
    const raw = serializeLeadFormMemory({ sourceId: "", statusId: "st-work" });
    expect(readLeadFormMemory(raw, sources, statuses)).toEqual({ sourceId: null, statusId: "st-work" });
  });

  it("drops a source that is no longer active or no longer exists", () => {
    expect(readLeadFormMemory(serializeLeadFormMemory({ sourceId: "s-old", statusId: null }), sources, statuses).sourceId).toBeNull();
    expect(readLeadFormMemory(serializeLeadFormMemory({ sourceId: "gone", statusId: null }), sources, statuses).sourceId).toBeNull();
  });

  it("never starts a lead as converted or not relevant", () => {
    expect(readLeadFormMemory(serializeLeadFormMemory({ sourceId: null, statusId: "st-no" }), sources, statuses).statusId).toBeNull();
    expect(readLeadFormMemory(serializeLeadFormMemory({ sourceId: null, statusId: "st-conv" }), sources, statuses).statusId).toBeNull();
    expect(readLeadFormMemory(serializeLeadFormMemory({ sourceId: null, statusId: "gone" }), sources, statuses).statusId).toBeNull();
  });

  it("ignores missing, broken or foreign stored values", () => {
    const none = { sourceId: null, statusId: null };
    expect(readLeadFormMemory(null, sources, statuses)).toEqual(none);
    expect(readLeadFormMemory("", sources, statuses)).toEqual(none);
    expect(readLeadFormMemory("{not json", sources, statuses)).toEqual(none);
    expect(readLeadFormMemory("42", sources, statuses)).toEqual(none);
    expect(readLeadFormMemory("null", sources, statuses)).toEqual(none);
    expect(readLeadFormMemory(JSON.stringify({ v: 2, source: "s-web", status: "st-work" }), sources, statuses)).toEqual(none);
    expect(readLeadFormMemory(JSON.stringify({ v: 1, source: 5, status: ["st-work"] }), sources, statuses)).toEqual(none);
  });
});

describe("pasted phone (UX-03)", () => {
  it("removes spaces, dashes, brackets and dots", () => {
    expect(cleanPastedPhone("050-123 4567")).toBe("0501234567");
    expect(cleanPastedPhone("(03) 123.4567")).toBe("031234567");
    expect(cleanPastedPhone(" 050–1234567 ")).toBe("0501234567");
  });

  it("writes an Israeli international number with a leading 0", () => {
    expect(cleanPastedPhone("+972 50-123-4567")).toBe("0501234567");
    expect(cleanPastedPhone("+972 (0)50 1234567")).toBe("0501234567");
    expect(cleanPastedPhone("00972-3-1234567")).toBe("031234567");
    expect(cleanPastedPhone("972501234567")).toBe("0501234567");
  });

  it("removes the direction marks copying from a Hebrew page adds", () => {
    expect(cleanPastedPhone("‎+972-50-1234567‏")).toBe("0501234567");
  });

  it("keeps a foreign number in international form", () => {
    expect(cleanPastedPhone("+1 (212) 555-0100")).toBe("+12125550100");
    expect(cleanPastedPhone("0044 20 7946 0958")).toBe("+442079460958");
  });

  it("leaves text that is not just a phone number alone", () => {
    expect(cleanPastedPhone("טל: 050-1234567")).toBeNull();
    expect(cleanPastedPhone("050-1234567 / 052-7654321")).toBeNull();
    expect(cleanPastedPhone("ext 12")).toBeNull();
    expect(cleanPastedPhone("")).toBeNull();
    expect(cleanPastedPhone("12")).toBeNull();
  });
});

describe("duplicate check while typing (UX-03)", () => {
  it("waits for a whole phone or email", () => {
    expect(duplicateLookupInput("050", "")).toBeNull();
    expect(duplicateLookupInput("", "dana@")).toBeNull();
    expect(duplicateLookupInput("", "dana@example")).toBeNull();
    expect(duplicateLookupInput("", "")).toBeNull();
  });

  it("asks about what is ready", () => {
    expect(duplicateLookupInput("050-1234567", "")).toEqual({ phone: "050-1234567", email: null });
    expect(duplicateLookupInput("05", " dana@example.co.il ")).toEqual({ phone: null, email: "dana@example.co.il" });
    expect(duplicateLookupInput("031234567", "a@b.com")).toEqual({ phone: "031234567", email: "a@b.com" });
  });
});
