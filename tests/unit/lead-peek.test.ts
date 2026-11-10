import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nextWorkingDay } from "@/features/calendar-days/business-days";
import { DEFAULT_CALENDAR_SETTINGS } from "@/features/calendar-days/holidays";
import {
  callBackPick,
  callBackProblem,
  defaultAskedFields,
  peekHref,
  peekLinks,
  peekNeighbours,
  peekRights,
  peekRowHref,
  showCreatedAgo,
  timelineItemHref,
} from "@/features/lead-peek/model";
import { addDays } from "@/lib/calendar-grid";

const ORG = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("UX-01: the lead side panel", () => {
  describe("what they asked for (owner 218 א)", () => {
    it("takes the requested product, the quantity field, the next active field and the message, at most 4", () => {
      const fields = defaultAskedFields({
        requestedProduct: "מטבח",
        custom: [
          { key: "budget", label: "תקציב", text: "50,000" },
          { key: "qty", label: "כמות", text: "3" },
          { key: "size", label: "גודל", text: "גדול" },
        ],
        message: "שלום",
      });
      expect(fields.map((f) => f.key)).toEqual(["requested_product", "cf:qty", "cf:budget", "message"]);
    });

    it("falls back to the first active field when none is called כמות, and hides empty ones", () => {
      const fields = defaultAskedFields({
        requestedProduct: null,
        custom: [
          { key: "a", label: "גודל", text: "גדול" },
          { key: "b", label: "צבע", text: null },
        ],
        message: "  ",
      });
      expect(fields.map((f) => f.label)).toEqual(["גודל"]);
    });
  });

  it("finds the previous and next lead on the page", () => {
    expect(peekNeighbours(["a", "b", "c"], "b")).toEqual({ previous: "a", next: "c" });
    expect(peekNeighbours(["a", "b"], "a")).toEqual({ previous: null, next: "b" });
    expect(peekNeighbours(["a"], "z")).toEqual({ previous: null, next: null });
  });

  it("keeps the list's parameters in the panel's address", () => {
    expect(peekHref("/o/x/leads", new URLSearchParams("q=a&peek=old"), "new")).toBe("/o/x/leads?q=a&peek=new");
    expect(peekHref("/o/x/leads", new URLSearchParams("peek=old"), null)).toBe("/o/x/leads");
  });

  it("opens the panel from a row, and the full page from the open lead's own row (a second click on the name)", () => {
    const links = peekLinks(ORG, `/o/${ORG}/leads`, { q: "כהן", peek: A });
    expect(links.peekId).toBe(A);
    expect(links.hrefFor(B)).toBe(`/o/${ORG}/leads?q=${encodeURIComponent("כהן")}&peek=${B}`);
    expect(links.hrefFor(A)).toBe(`/o/${ORG}/leads/${A}`);
    expect(peekRowHref(links.rows, B)).toBe(links.hrefFor(B));
    expect(links.closeHref).toBe(`/o/${ORG}/leads?q=${encodeURIComponent("כהן")}`);
    // anything but an id is not a lead
    expect(peekLinks(ORG, "/x", { peek: "1 or 1=1" }).peekId).toBeNull();
  });

  describe("rights (owner 187 ב, 213 ב, 216 ב)", () => {
    const base = { offeredOnly: false, canWrite: true, canEditRecord: true, ownerId: null, statusKind: "open", converted: false };
    it("a lead offered only to take: read, and take", () => {
      expect(peekRights({ ...base, offeredOnly: true, canEditRecord: false })).toEqual({ mode: "take_only", canLog: false, canEdit: false, canTake: true });
    });
    it("a readable lead nobody owns: work, and take first", () => {
      expect(peekRights(base)).toEqual({ mode: "work", canLog: true, canEdit: true, canTake: true });
    });
    it("a member on someone else's lead logs but does not change its status", () => {
      expect(peekRights({ ...base, ownerId: "u", canEditRecord: false })).toEqual({ mode: "work", canLog: true, canEdit: false, canTake: false });
    });
    it("a viewer only reads", () => {
      expect(peekRights({ ...base, canWrite: false }).mode).toBe("read");
      expect(peekRights({ ...base, canWrite: false, offeredOnly: true }).mode).toBe("read");
    });
    it("a closed lead offers no taking", () => {
      expect(peekRights({ ...base, statusKind: "disqualified" }).canTake).toBe(false);
      expect(peekRights({ ...base, converted: true }).canLog).toBe(false);
    });
  });

  describe("call back (owner (214) ב (5))", () => {
    // Sunday-Thursday work, Friday and Saturday rest (the defaults)
    const workingDay = (day: string) => nextWorkingDay(DEFAULT_CALENDAR_SETTINGS, day);
    it("tomorrow at 10:00, moved over the weekend", () => {
      // 2026-11-12 is a Thursday: tomorrow is Friday, a rest day, so Sunday the 15th
      expect(callBackPick("tomorrow", "2026-11-12", "14:07", workingDay, addDays)).toEqual({ date: "2026-11-15", time: "10:00", moved: true });
      expect(callBackPick("tomorrow", "2026-11-10", "14:07", workingDay, addDays)).toEqual({ date: "2026-11-11", time: "10:00", moved: false });
    });
    it("in a week at 10:00", () => {
      expect(callBackPick("week", "2026-11-10", "09:00", workingDay, addDays)).toEqual({ date: "2026-11-17", time: "10:00", moved: false });
    });
    it("in an hour, rounded up to 5 minutes, past midnight onto the next day", () => {
      expect(callBackPick("hour", "2026-11-10", "14:07", workingDay, addDays)).toEqual({ date: "2026-11-10", time: "15:10", moved: false });
      expect(callBackPick("hour", "2026-11-10", "23:30", workingDay, addDays)).toEqual({ date: "2026-11-11", time: "00:30", moved: false });
    });
    it("refuses a missing or past time", () => {
      const due = (date: string, time: string) => `${date}T${time}:00Z`;
      const now = new Date("2026-11-10T12:00:00Z");
      expect(callBackProblem("", "10:00", now, due)).toBe("יש לבחור תאריך.");
      expect(callBackProblem("2026-11-10", "25:00", now, due)).toBe("יש לבחור שעה.");
      expect(callBackProblem("2026-11-10", "11:00", now, due)).toMatch("כבר עבר");
      expect(callBackProblem("2026-11-10", "13:00", now, due)).toBeNull();
    });
  });

  it("does not say how long ago the lead came in while the waiting chip says it (owner (214) ב (7))", () => {
    expect(showCreatedAgo(true)).toBe(false);
    expect(showCreatedAgo(false)).toBe(true);
  });

  it("links a timeline item to its entry on the full page (owner (214) ב (8))", () => {
    expect(timelineItemHref(ORG, A, "entry-x")).toBe(`/o/${ORG}/leads/${A}#entry-x`);
    // the lead page's timeline carries the same anchor
    const timeline = readFileSync(join(process.cwd(), "src/features/activities/components/timeline.tsx"), "utf8");
    expect(timeline).toContain("id={timelineEntryId(item.id)}");
  });
});
