import { describe, expect, it } from "vitest";

import { EXPORT_README, EXPORT_TABLES, exportNames, toCsv } from "@/features/imports/export-build";

const ORG = "00000000-0000-0000-0000-00000000000a";
const OWNER = "00000000-0000-0000-0000-0000000000a1";
const GUEST = "00000000-0000-0000-0000-0000000000a2";
const MEETING = "00000000-0000-0000-0000-0000000000b1";
const CONTACT = "00000000-0000-0000-0000-0000000000c1";

const meeting = {
  id: MEETING,
  organization_id: ORG,
  title: "פגישת היכרות, משרד",
  meeting_type: "in_person",
  starts_at: "2026-10-14T07:00:00+00:00",
  ends_at: "2026-10-14T08:00:00+00:00",
  status: "planned",
  owner_id: OWNER,
  contact_id: CONTACT,
  created_by: OWNER,
  created_at: "2026-10-13T07:00:00+00:00",
};
const participant = { id: "p1", organization_id: ORG, meeting_id: MEETING, user_id: GUEST, created_by: OWNER, created_at: "2026-10-13T07:00:00+00:00" };

function lines(csv: string): string[] {
  return csv.replace(/^﻿/, "").trimEnd().split("\r\n");
}

describe("full export: meetings and participants", () => {
  it("has one CSV for meetings and one for their participants, and every file name once", () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(EXPORT_TABLES.find((t) => t.table === "meetings")?.file).toBe("meetings.csv");
    expect(EXPORT_TABLES.find((t) => t.table === "meeting_participants")?.file).toBe("meeting_participants.csv");
    expect(new Set(files).size).toBe(files.length);
    expect(new Set(EXPORT_TABLES.map((t) => t.table)).size).toBe(EXPORT_TABLES.length);
    expect(EXPORT_README).toContain("meetings.csv");
    expect(EXPORT_README).toContain("meeting_participants.csv");
  });

  it("puts the organizer's and the contact's names next to their ids in meetings.csv", () => {
    const { names, tagNames } = exportNames(
      [
        { table: "meetings", rows: [meeting] },
        { table: "contacts", rows: [{ id: CONTACT, full_name: "דנה כהן" }] },
      ],
      [{ id: OWNER, full_name: " יוסי לוי ", email: "yossi@example.com" }],
    );
    const [header, row] = lines(toCsv([meeting], names, tagNames));
    const cols = header.split(",");
    expect(cols.slice(cols.indexOf("owner_id"), cols.indexOf("owner_id") + 2)).toEqual(["owner_id", "owner"]);
    expect(cols.slice(cols.indexOf("contact_id"), cols.indexOf("contact_id") + 2)).toEqual(["contact_id", "contact"]);
    expect(row).toContain('"פגישת היכרות, משרד"');
    expect(row).toContain(`${OWNER},יוסי לוי`);
    expect(row).toContain(`${CONTACT},דנה כהן`);
  });

  it("names the meeting and the participant in meeting_participants.csv", () => {
    const { names, tagNames } = exportNames([{ table: "meetings", rows: [meeting] }], [{ id: GUEST, full_name: null, email: "guest@example.com" }]);
    const [header, row] = lines(toCsv([participant], names, tagNames));
    expect(header).toBe("id,organization_id,meeting_id,meeting,user_id,user,created_by,created_by_name,created_at");
    expect(row).toBe(`p1,${ORG},${MEETING},"פגישת היכרות, משרד",${GUEST},guest@example.com,${OWNER},,2026-10-13T07:00:00+00:00`);
  });

  it("an empty table is a file with the BOM only, and a formula is defused", () => {
    expect(toCsv([], new Map(), new Map())).toBe("﻿");
    const [, row] = lines(toCsv([{ ...meeting, title: "=HYPERLINK(1)" }], new Map(), new Map()));
    expect(row).toContain("'=HYPERLINK(1)");
  });
});
