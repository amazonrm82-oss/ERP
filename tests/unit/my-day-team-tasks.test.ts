import { describe, expect, it } from "vitest";

import { TEAM_TASKS_SHOWN, teamTaskDue, teamTasksMoreText } from "@/features/home/my-day";
import { formatDate } from "@/lib/format";

const TZ = "Asia/Jerusalem";
const TODAY = "2026-10-20";

describe("team tasks on My day (TASK-07 follow-up)", () => {
  it("places the due date in the business's day: overdue, today with its time, later, or none", () => {
    // 23:59 on the 19th in Jerusalem: yesterday, so overdue, with its date
    expect(teamTaskDue("2026-10-19T20:59:00Z", TODAY, TZ)).toEqual({ kind: "overdue", text: formatDate("2026-10-19T20:59:00Z") });
    // 00:30 on the 20th in Jerusalem, still the 19th in UTC: today
    expect(teamTaskDue("2026-10-19T21:30:00Z", TODAY, TZ)).toEqual({ kind: "today", text: "היום, 00:30" });
    expect(teamTaskDue("2026-10-20T11:00:00Z", TODAY, TZ)).toEqual({ kind: "today", text: "היום, 14:00" });
    // 00:10 on the 21st in Jerusalem: a later day
    expect(teamTaskDue("2026-10-20T21:10:00Z", TODAY, TZ)).toEqual({ kind: "later", text: formatDate("2026-10-20T21:10:00Z") });
    expect(teamTaskDue(null, TODAY, TZ)).toEqual({ kind: "none", text: null });
    expect(teamTaskDue("not a date", TODAY, TZ)).toEqual({ kind: "none", text: null });
  });

  it("follows the business's zone, not the server's", () => {
    // 22:00 UTC on the 19th is the 20th in Jerusalem and still the 19th in New York
    expect(teamTaskDue("2026-10-19T22:00:00Z", TODAY, TZ).kind).toBe("today");
    expect(teamTaskDue("2026-10-19T22:00:00Z", TODAY, "America/New_York").kind).toBe("overdue");
  });

  it("counts what the card does not show", () => {
    expect(TEAM_TASKS_SHOWN).toBe(8);
    expect(teamTasksMoreText(0, 0)).toBeNull();
    expect(teamTasksMoreText(8, 8)).toBeNull();
    expect(teamTasksMoreText(9, 8)).toBe("ועוד משימה אחת של הצוות");
    expect(teamTasksMoreText(1250, 8)).toBe("ועוד 1,242 משימות של הצוות");
    // a count read a moment before the rows never goes below zero
    expect(teamTasksMoreText(3, 5)).toBeNull();
  });
});
