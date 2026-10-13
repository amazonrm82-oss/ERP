import { describe, expect, it } from "vitest";

import { EXPORT_README, EXPORT_TABLES, exportKey, exportNames, toCsv } from "@/features/imports/export-build";

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

describe("full export: the rest days (CAL-03)", () => {
  const settings = {
    id: "s1",
    organization_id: ORG,
    rest_weekdays: [5, 6],
    holidays_rest: true,
    holiday_eves_rest: false,
    rest_occasions: ["mimouna", "purim", "gone_key"],
    updated_by: OWNER,
    created_at: "2026-10-13T07:00:00+00:00",
    updated_at: "2026-10-13T07:00:00+00:00",
  };

  it("is configuration in calendar_settings.csv, next to the pipelines, and the README explains it", () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(EXPORT_TABLES.find((t) => t.table === "org_calendar_settings")?.file).toBe("calendar_settings.csv");
    expect(files).toContain("pipelines.csv");
    expect(EXPORT_README).toContain("calendar_settings.csv");
    expect(EXPORT_README).toContain("ברירת המחדל");
  });

  it("names the weekdays and the occasions next to their codes", () => {
    const [header, row] = lines(toCsv([settings], new Map(), new Map()));
    const cols = header.split(",");
    expect(cols.slice(cols.indexOf("rest_weekdays"), cols.indexOf("rest_weekdays") + 2)).toEqual(["rest_weekdays", "rest_days"]);
    expect(cols.slice(cols.indexOf("rest_occasions"), cols.indexOf("rest_occasions") + 2)).toEqual(["rest_occasions", "rest_occasion_names"]);
    expect(row).toContain('"[5,6]",שישי; שבת,true,false');
    expect(row).toContain("מימונה; פורים; gone_key");
  });

  it("an empty week and no occasions give empty names", () => {
    const [, row] = lines(toCsv([{ ...settings, rest_weekdays: [], rest_occasions: [] }], new Map(), new Map()));
    expect(row).toContain("[],,true,false,[],,");
  });
});

describe("full export: contact channels, deal contacts, team members, WhatsApp templates", () => {
  const DEAL = "00000000-0000-0000-0000-0000000000d1";
  const TEAM = "00000000-0000-0000-0000-0000000000e1";

  it("each has its own CSV, keyed by id or by its primary key, and the README names them", () => {
    const entry = (table: string) => EXPORT_TABLES.find((t) => t.table === table);
    expect(entry("contact_channels")?.file).toBe("contact_channels.csv");
    expect(entry("whatsapp_templates")?.file).toBe("whatsapp_templates.csv");
    expect(exportKey(entry("contact_channels")!)).toEqual(["id"]);
    expect(exportKey(entry("deal_contacts")!)).toEqual(["deal_id", "contact_id"]);
    expect(exportKey(entry("team_members")!)).toEqual(["team_id", "user_id"]);
    for (const file of ["contact_channels.csv", "deal_contacts.csv", "team_members.csv", "whatsapp_templates.csv"]) expect(EXPORT_README).toContain(file);
  });

  it("names the deal and the contact and reads the role in deal_contacts.csv", () => {
    const { names, tagNames } = exportNames(
      [
        { table: "deals", rows: [{ id: DEAL, name: "עסקת ענן" }] },
        { table: "contacts", rows: [{ id: CONTACT, full_name: "דנה כהן" }] },
      ],
      [],
    );
    const link = { organization_id: ORG, deal_id: DEAL, contact_id: CONTACT, role: "decision_maker", created_at: "2026-10-13T07:00:00+00:00" };
    const csv = toCsv([link, { ...link, role: null }, { ...link, role: "gone" }], names, tagNames, "deal_contacts");
    const [header, ...rows] = lines(csv);
    expect(header).toBe("organization_id,deal_id,deal,contact_id,contact,role,role_name,created_at");
    expect(rows[0]).toBe(`${ORG},${DEAL},עסקת ענן,${CONTACT},דנה כהן,decision_maker,מקבל החלטה,2026-10-13T07:00:00+00:00`);
    expect(rows[1]).toContain(",דנה כהן,,,");
    expect(rows[2]).toContain(",gone,,");
  });

  it("a role column of another table gets no Hebrew name", () => {
    const [header] = lines(toCsv([{ id: "x", role: "user" }], new Map(), new Map(), "contacts"));
    expect(header).toBe("id,role");
  });

  it("names the contact and the type of a further phone or email in contact_channels.csv", () => {
    const { names, tagNames } = exportNames([{ table: "contacts", rows: [{ id: CONTACT, full_name: "דנה כהן" }] }], []);
    const phone = { id: "c1", organization_id: ORG, contact_id: CONTACT, kind: "phone", label: "mobile", value: "050-1234567", value_e164: "+972501234567" };
    const [header, first, second] = lines(toCsv([phone, { ...phone, kind: "email", label: "home", value: "dana@example.com", value_e164: null }], names, tagNames, "contact_channels"));
    expect(header).toBe("id,organization_id,contact_id,contact,kind,label,label_name,value,value_e164");
    expect(first).toBe(`c1,${ORG},${CONTACT},דנה כהן,phone,mobile,נייד,050-1234567,+972501234567`);
    expect(second).toContain("email,home,אישי,dana@example.com,");
  });

  it("names the team and the member in team_members.csv", () => {
    const { names, tagNames } = exportNames([{ table: "teams", rows: [{ id: TEAM, name: "צוות צפון" }] }], [{ id: GUEST, full_name: "רון", email: null }]);
    const [header, row] = lines(
      toCsv([{ organization_id: ORG, team_id: TEAM, user_id: GUEST, is_manager: true, is_primary: false, created_at: "t" }], names, tagNames, "team_members"),
    );
    expect(header).toBe("organization_id,team_id,team,user_id,user,is_manager,is_primary,created_at");
    expect(row).toBe(`${ORG},${TEAM},צוות צפון,${GUEST},רון,true,false,t`);
  });
});
