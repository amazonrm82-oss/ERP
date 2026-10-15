import { describe, expect, it } from "vitest";

import { CLOSED_DATE_FUTURE, CLOSED_DATE_ON_OPEN, closedAtForRow, parseDealRow, RECURRING_ON_ONE_TIME, RECURRING_WITHOUT_KIND, resolveStage, type PipelineRef, type StageRef } from "@/features/imports/deal-rows";
import { duplicateModesFor, IMPORT_TARGETS, suggestMapping } from "@/features/imports/fields";
import { companyKey, parseDateCell, parseDateTimeCell, parseMoneyCell, parseTimeCell, personKey, splitTags } from "@/features/imports/record-cells";
import { parseTaskRow } from "@/features/imports/task-rows";
import { cellText } from "@/features/imports/cell-text";
import { customCellValue } from "@/features/imports/record-cells";
import { normalizeDate } from "@/features/imports/server";
import { ownerOf, type Owners } from "@/features/imports/link-lookups";

/** What read-excel-file makes of an Excel serial: UTC, floored to the millisecond. */
const excelDate = (serial: number) => new Date(Math.floor((serial - 25569) * 86_400_000));

describe("Excel date cells (cellText)", () => {
  it("rounds the floored time to the minute", () => {
    // 46387 = 31/12/2026
    expect(cellText(new Date("2026-12-31T14:29:59.999Z"))).toBe("2026-12-31 14:30");
    expect(cellText(new Date("2026-12-31T09:04:59.999Z"))).toBe("2026-12-31 09:05");
    expect(cellText(excelDate(46387 + (14 * 60 + 30) / 1440))).toBe("2026-12-31 14:30");
    expect(cellText(excelDate(46387 + (9 * 60 + 5) / 1440))).toBe("2026-12-31 09:05");
    expect(cellText(excelDate(46387 + (23 * 60 + 59) / 1440))).toBe("2026-12-31 23:59");
    expect(cellText(excelDate(46387))).toBe("2026-12-31");
    expect(cellText(new Date("2026-12-31T00:00:00.000Z"))).toBe("2026-12-31");
    expect(cellText(12.5)).toBe("12.5");
    expect(cellText(" x ")).toBe("x");
  });

  it("date-only columns drop the time; the task due column keeps it", () => {
    const cell = cellText(excelDate(46387 + (14 * 60 + 30) / 1440));
    // leads and contacts (birth_date), every custom date field, the deal date columns
    expect(normalizeDate(cell)).toBe("2026-12-31");
    expect(normalizeDate("31/12/1980 10:00")).toBe("1980-12-31");
    expect(customCellValue("date", cell)).toBe("2026-12-31");
    expect(customCellValue("datetime", cell)).toBe("2026-12-31T14:30");
    expect(customCellValue("text", cell)).toBe(cell);
    expect(customCellValue("date", "31/12/2026")).toBe("31/12/2026");
    expect(parseDateCell(cell)).toBe("2026-12-31");
    expect(parseDealRow({ name: "א", expected_close_date: cell, closed_date: "2026-03-01 10:15" }, "2026-10-14")).toMatchObject({
      row: { values: { expected_close_date: "2026-12-31" }, closedDate: "2026-03-01" },
    });
    expect(parseTaskRow({ title: "א", due_date: cell })).toMatchObject({ dueDate: "2026-12-31", dueTime: "14:30" });
  });
});

describe("owner by email or name", () => {
  const owners: Owners = new Map([
    ["dana@x.co.il", "u1"],
    ["דנה כהן", null],
    ["יוסי", "u2"],
  ]);
  it("two members with the same name is an error, never the last one", () => {
    expect(ownerOf(owners, " Dana@X.co.il ")).toEqual({ ok: true, id: "u1" });
    expect(ownerOf(owners, "יוסי")).toEqual({ ok: true, id: "u2" });
    expect(ownerOf(owners, "דנה כהן")).toMatchObject({ ok: false, message: expect.stringMatching(/כמה משתמשים/) });
    expect(ownerOf(owners, "אף אחד")).toMatchObject({ ok: false, message: expect.stringMatching(/לא נמצא/) });
  });
});

// IMP-03: reading deals and tasks files (pure part; the database part is tests/db/109-import-deals-tasks.test.ts)

describe("cells of a deals or tasks file", () => {
  it("reads dates day first, with an optional time", () => {
    expect(parseDateTimeCell("31/12/2026")).toEqual({ date: "2026-12-31", time: null });
    expect(parseDateTimeCell("1.2.2027 9:05")).toEqual({ date: "2027-02-01", time: "09:05" });
    expect(parseDateTimeCell("2026-12-31T14:30")).toEqual({ date: "2026-12-31", time: "14:30" });
    expect(parseDateTimeCell("2026-12-31 14:30:00")).toEqual({ date: "2026-12-31", time: "14:30" });
    expect(parseDateTimeCell("31/02/2026")).toBeNull();
    expect(parseDateTimeCell("31/12/2026 25:00")).toBeNull();
    expect(parseDateTimeCell("מחר")).toBeNull();
    // a time after the day is dropped by the date-only parser
    expect(parseDateCell("31/12/2026 10:00")).toBe("2026-12-31");
    expect(parseTimeCell("7:30")).toBe("07:30");
    expect(parseTimeCell("24:00")).toBeNull();
  });

  it("reads money with shekel signs, commas and Excel's binary tail; refuses negatives", () => {
    expect(parseMoneyCell("₪12,500")).toBe(1_250_000);
    expect(parseMoneyCell("99.99000000000001")).toBe(9999);
    expect(parseMoneyCell("1250.5")).toBe(125_050);
    expect(parseMoneyCell("-5")).toBeNull();
    expect(parseMoneyCell("abc")).toBeNull();
  });

  it("splits tags and drops repeats without case", () => {
    expect(splitTags("VIP, לקוח חוזר; vip ,  צפון  ")).toEqual(["VIP", "לקוח חוזר", "צפון"]);
  });

  it("tells an email from a phone, and a company name from a domain", () => {
    expect(personKey(" Dana@Acme.co.il ")).toEqual({ kind: "email", value: "dana@acme.co.il" });
    expect(personKey("050-1234567")).toEqual({ kind: "phone", value: "050-1234567" });
    expect(personKey("דנה")).toBeNull();
    expect(companyKey("אקמי בע\"מ")).toEqual({ name: "אקמי בע\"מ", domain: null });
    expect(companyKey("https://www.Acme.co.il/about")).toEqual({ name: "https://www.Acme.co.il/about", domain: "acme.co.il" });
    expect(companyKey("info@acme.co.il").domain).toBe("acme.co.il");
    expect(companyKey("Wix.com")).toEqual({ name: "Wix.com", domain: "wix.com" });
  });
});

describe("a deals row", () => {
  const today = "2026-10-14";

  it("keeps the columns and the names the server resolves", () => {
    const parsed = parseDealRow(
      { name: "  חידוש  שנתי ", amount: "₪12,000", pipeline: "מכירות", stage: "הצעה", expected_close_date: "1/11/2026", owner: "dana@x.co.il", contact: "dana@x.co.il", company: "acme.co.il", tags: "VIP,חדש", source: "פייסבוק" },
      today,
    );
    expect(parsed).toEqual({
      row: {
        values: {
          name: "חידוש שנתי",
          amount_agorot: 1_200_000,
          expected_close_date: "2026-11-01",
          billing_kind: null,
          recurring_amount_agorot: null,
          recurring_start_date: null,
          renewal_date: null,
        },
        pipeline: "מכירות",
        stage: "הצעה",
        closedDate: null,
        owner: "dana@x.co.il",
        contact: { kind: "email", value: "dana@x.co.il" },
        company: { name: "acme.co.il", domain: "acme.co.il" },
        source: "פייסבוק",
        tags: ["VIP", "חדש"],
      },
      warning: null,
    });
  });

  it("leaves an empty value to the database (DEAL-07 first-year rule)", () => {
    const parsed = parseDealRow({ name: "ריטיינר", billing_kind: "חודשית", recurring_amount: "1,000", recurring_start_date: "01/11/2026" }, today);
    expect(typeof parsed).toBe("object");
    if (typeof parsed === "string") return;
    expect(parsed.row.values).toMatchObject({ amount_agorot: null, billing_kind: "monthly", recurring_amount_agorot: 100_000, recurring_start_date: "2026-11-01", renewal_date: null });
  });

  it("refuses what cannot be imported", () => {
    expect(parseDealRow({ amount: "100" }, today)).toBe("חסר שם לעסקה.");
    expect(parseDealRow({ name: "x".repeat(201) }, today)).toMatch(/ארוך מדי/);
    expect(parseDealRow({ name: "א", amount: "-100" }, today)).toMatch(/אינו סכום תקין/);
    expect(parseDealRow({ name: "א", expected_close_date: "31/02/2026" }, today)).toMatch(/אינו תאריך תקין/);
    expect(parseDealRow({ name: "א", closed_date: "15/10/2026" }, today)).toBe(CLOSED_DATE_FUTURE);
    expect(parseDealRow({ name: "א", recurring_amount: "100" }, today)).toBe(RECURRING_WITHOUT_KIND);
    expect(parseDealRow({ name: "א", billing_kind: "דו-שנתית" }, today)).toMatch(/לא מוכר/);
    expect(parseDealRow({ name: "א", billing_kind: "שנתית", recurring_amount: "100" }, today)).toBe("יש לבחור תאריך התחלה.");
    expect(parseDealRow({ name: "א", billing_kind: "חודשית", recurring_amount: "100", recurring_start_date: "01/11/2026", renewal_date: "01/10/2026" }, today)).toMatch(/לפני תאריך ההתחלה/);
    expect(parseDealRow({ name: "א", contact: "דנה" }, today)).toMatch(/אימייל או טלפון/);
    expect(parseDealRow({ name: "א", tags: "x".repeat(41) }, today)).toMatch(/התגית/);
  });

  it("warns when a one-time deal carries recurring cells", () => {
    const parsed = parseDealRow({ name: "א", billing_kind: "חד-פעמית", recurring_amount: "100" }, today);
    expect(parsed).toMatchObject({ warning: RECURRING_ON_ONE_TIME, row: { values: { billing_kind: null, recurring_amount_agorot: null } } });
  });
});

describe("pipeline and stage by name", () => {
  const pipelines: PipelineRef[] = [
    { id: "p2", name: "שירות", isDefault: false, position: 1 },
    { id: "p1", name: "מכירות", isDefault: true, position: 0 },
  ];
  const stages: StageRef[] = [
    { id: "s1", pipelineId: "p1", name: "ליד חדש", kind: "open", position: 0 },
    { id: "s2", pipelineId: "p1", name: "נסגר בהצלחה", kind: "won", position: 5 },
    { id: "s3", pipelineId: "p2", name: "פנייה", kind: "open", position: 0 },
  ];

  it("defaults to the default pipeline and its first open stage", () => {
    expect(resolveStage(pipelines, stages, null, null)).toEqual({ pipelineId: "p1", stageId: "s1", kind: "open" });
    expect(resolveStage(pipelines, stages, " שירות ", null)).toEqual({ pipelineId: "p2", stageId: "s3", kind: "open" });
    expect(resolveStage(pipelines, stages, null, "נסגר  בהצלחה")).toEqual({ pipelineId: "p1", stageId: "s2", kind: "won" });
  });

  it("an unknown name is an error, never a new stage; a stage counts only in its pipeline", () => {
    expect(resolveStage(pipelines, stages, "שיווק", null)).toBe('אין תהליך מכירה בשם "שיווק".');
    expect(resolveStage(pipelines, stages, null, "פנייה")).toMatch(/^אין שלב בשם "פנייה" בתהליך המכירה "מכירות"/);
    expect(resolveStage([], [], null, null)).toBe("אין תהליך מכירה בעסק.");
  });
});

describe("the close date of an imported deal (DEAL-04)", () => {
  const now = new Date("2026-10-14T09:00:00Z");
  const zone = "Asia/Jerusalem";

  it("a won or lost deal closes on the file's date, else a past expected date, else at the import", () => {
    expect(closedAtForRow("won", "2026-03-01", null, "2026-10-14", now, zone)).toEqual({ closedAt: "2026-03-01T10:00:00.000Z", warning: null });
    expect(closedAtForRow("lost", null, "2026-09-30", "2026-10-14", now, zone)).toEqual({ closedAt: "2026-09-30T09:00:00.000Z", warning: null });
    expect(closedAtForRow("won", "2026-10-14", null, "2026-10-14", now, zone)).toEqual({ closedAt: now.toISOString(), warning: null });
    expect(closedAtForRow("won", null, "2026-12-01", "2026-10-14", now, zone)).toEqual({ closedAt: null, warning: null });
  });

  it("an open deal keeps no close date and says so", () => {
    expect(closedAtForRow("open", "2026-03-01", null, "2026-10-14", now, zone)).toEqual({ closedAt: null, warning: CLOSED_DATE_ON_OPEN });
    expect(closedAtForRow("open", null, "2026-03-01", "2026-10-14", now, zone)).toEqual({ closedAt: null, warning: null });
  });
});

describe("a tasks row", () => {
  it("reads the type, priority, state, due date and time, and the link keys", () => {
    expect(
      parseTaskRow({ title: "להתקשר", task_type: "שיחה", priority: "גבוהה", status: "בוצעה", due_date: "31/12/2026 14:30", lead: "0501234567", deal: " חידוש  שנתי ", company: "acme.co.il" }),
    ).toEqual({
      values: { title: "להתקשר", description: null, task_type: "call", priority: 1, status: "done" },
      dueDate: "2026-12-31",
      dueTime: "14:30",
      owner: null,
      lead: { kind: "phone", value: "0501234567" },
      contact: null,
      company: { name: "acme.co.il", domain: "acme.co.il" },
      // only trimmed: the database compares the whole name (deal_name_matches)
      deal: "חידוש  שנתי",
    });
    expect(parseTaskRow({ title: "א", task_type: "follow-up", priority: "low", due_date: "2026-12-31", due_time: "8:00" })).toMatchObject({
      values: { task_type: "follow_up", priority: 3, status: "open" },
      dueDate: "2026-12-31",
      dueTime: "08:00",
    });
    expect(parseTaskRow({ title: "א" })).toMatchObject({ values: { task_type: "todo", priority: 2, status: "open" }, dueDate: null, dueTime: null });
  });

  it("refuses what cannot be imported", () => {
    expect(parseTaskRow({ task_type: "שיחה" })).toBe("חסרה כותרת: מה צריך לעשות.");
    expect(parseTaskRow({ title: "x".repeat(301) })).toMatch(/ארוכה מדי/);
    expect(parseTaskRow({ title: "א", task_type: "סדנה" })).toMatch(/לא מוכר/);
    expect(parseTaskRow({ title: "א", priority: "5" })).toMatch(/לא מוכרת/);
    expect(parseTaskRow({ title: "א", status: "בוטלה" })).toMatch(/לא מוכר/);
    expect(parseTaskRow({ title: "א", due_date: "אתמול" })).toMatch(/אינו תקין/);
    expect(parseTaskRow({ title: "א", due_time: "10:00" })).toBe("כדי לקבוע שעה צריך גם תאריך יעד.");
    expect(parseTaskRow({ title: "א", contact: "דנה" })).toMatch(/אימייל או טלפון/);
  });
});

describe("mapping deals and tasks columns", () => {
  it("matches the usual headers", () => {
    expect(suggestMapping(["שם העסקה", "סכום", "פייפליין", "שלב", "אחראי", "איש קשר", "חברה", "תגיות", "תאריך סגירה צפוי"], IMPORT_TARGETS.deal)).toEqual([
      "name",
      "amount",
      "pipeline",
      "stage",
      "owner",
      "contact",
      "company",
      "tags",
      "expected_close_date",
    ]);
    expect(suggestMapping(["כותרת", "סוג", "תאריך יעד", "שעה", "עדיפות", "אחראי", "ליד", "עסקה"], IMPORT_TARGETS.task)).toEqual([
      "title",
      "task_type",
      "due_date",
      "due_time",
      "priority",
      "owner",
      "lead",
      "deal",
    ]);
  });

  it("deals and tasks always create (no duplicate key)", () => {
    expect(duplicateModesFor("deal")).toEqual(["create"]);
    expect(duplicateModesFor("task")).toEqual(["create"]);
    expect(duplicateModesFor("lead")).toEqual(["skip", "update", "create"]);
  });
});
