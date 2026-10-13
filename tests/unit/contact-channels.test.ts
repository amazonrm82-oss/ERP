import { describe, expect, it } from "vitest";

import { draftsFrom, matchKey, parseChannels, planChannels, type StoredChannel } from "@/features/contacts/channels";
import { buildVCard } from "@/lib/vcard";

const json = (rows: unknown) => JSON.stringify(rows);
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const stored = (id: string, kind: "phone" | "email", value: string, label: string, position: number): StoredChannel => ({
  id,
  kind,
  label,
  value,
  value_e164: null,
  position,
});

// CON-01: the form sends each kind as JSON; the primary row goes to the contact's columns, the rest are further rows
describe("contact phones and emails (CON-01)", () => {
  it("takes the row marked primary, else the first, and drops empty rows", () => {
    const marked = parseChannels(
      "phone",
      json([
        { id: null, type: "work", value: "03-5551234", primary: false },
        { id: null, type: "mobile", value: " 050-1234567 ", primary: true },
        { id: null, type: "home", value: "  ", primary: false },
      ]),
    );
    expect(marked).toEqual({
      ok: true,
      value: { primary: { value: "050-1234567", type: "mobile" }, extras: [{ id: null, type: "work", value: "03-5551234" }] },
    });
    const first = parseChannels("email", json([{ id: null, type: "work", value: "A@B.example", primary: false }]));
    expect(first).toEqual({ ok: true, value: { primary: { value: "a@b.example", type: "work" }, extras: [] } });
    // an explicit empty list clears; a form without the field changes nothing (it is refused)
    expect(parseChannels("phone", "[]")).toEqual({ ok: true, value: { primary: null, extras: [] } });
    expect(parseChannels("phone", null).ok).toBe(false);
  });

  it("refuses a bad value, a bad type, a repeat in another spelling, too many rows and broken input", () => {
    const one = (kind: "phone" | "email", rows: unknown) => parseChannels(kind, json(rows));
    expect(one("phone", [{ id: null, type: "mobile", value: "abc", primary: true }])).toEqual({ ok: false, message: "מספר הטלפון אינו תקין." });
    expect(one("email", [{ id: null, type: "mobile", value: "a@b.example", primary: true }])).toEqual({ ok: false, message: "יש לבחור סוג מהרשימה." });
    const repeat = one("phone", [
      { id: null, type: "mobile", value: "050-1234567", primary: true },
      { id: null, type: "work", value: "+972 50 123 4567", primary: false },
    ]);
    expect(repeat).toEqual({ ok: false, message: "טלפון 2: המספר כבר מופיע ברשימה." });
    // a primary and 11 further ones: refused while one of them is new, kept when all are stored (after a merge)
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i === 0 ? null : id(i), type: "other", value: `052-10000${String(i).padStart(2, "0")}`, primary: i === 0 }));
    expect(one("phone", many).ok).toBe(true);
    expect(one("phone", many.map((r, i) => (i === 11 ? { ...r, id: null } : r)))).toEqual({ ok: false, message: "אפשר לשמור עד 10 טלפונים נוספים מלבד הראשי." });
    expect(one("phone", many.slice(0, 11).map((r) => ({ ...r, id: null }))).ok).toBe(true);
    expect(parseChannels("phone", "not json").ok).toBe(false);
    expect(one("phone", [{ id: "not-a-uuid", type: "mobile", value: "050-1234567", primary: true }]).ok).toBe(false);
  });

  it("builds the form's rows: primary first, then the further ones in order, a copy of the primary dropped", () => {
    const rows = draftsFrom("phone", "050-1234567", null, [
      stored(ID2, "phone", "03-5551234", "work", 1),
      stored(ID1, "phone", "+972501234567", "home", 0),
      stored("33333333-3333-4333-8333-333333333333", "email", "x@y.example", "work", 0),
    ]);
    expect(rows).toEqual([
      { id: null, type: "mobile", value: "050-1234567", primary: true },
      { id: ID2, type: "work", value: "03-5551234", primary: false },
    ]);
    expect(draftsFrom("email", null, null, [])).toEqual([]);
  });

  it("plans the smallest change: keep, relabel or move; a changed value is removed and added", () => {
    const old = [stored(ID1, "phone", "052-1", "work", 0), stored(ID2, "phone", "052-2", "home", 1)];
    const plan = planChannels("phone", old, [
      { id: ID2, type: "mobile", value: "052-2" },
      { id: ID1, type: "work", value: "052-9" },
      { id: null, type: "other", value: "052-3" },
    ]);
    expect(plan).toEqual({
      remove: [ID1],
      update: [{ id: ID2, label: "mobile", position: 0 }],
      insert: [
        { kind: "phone", label: "work", value: "052-9", position: 1 },
        { kind: "phone", label: "other", value: "052-3", position: 2 },
      ],
    });
    expect(planChannels("phone", old, [])).toEqual({ remove: [ID1, ID2], update: [], insert: [] });
    expect(matchKey("email", " A@B.example ")).toBe("a@b.example");
  });

  it("puts the further phones and emails on the vCard with their type", () => {
    const card = buildVCard({
      name: "דנה",
      phone: "050-1234567",
      email: "d@a.example",
      extraPhones: [{ value: "03-5551234", type: "work" }],
      extraEmails: [{ value: "d@home.example", type: "home" }],
    });
    expect(card).toContain("TEL;TYPE=CELL:050-1234567\r\nTEL;TYPE=WORK:03-5551234\r\n");
    expect(card).toContain("EMAIL:d@a.example\r\nEMAIL;TYPE=HOME:d@home.example\r\n");
    // the primary's own type
    const typed = buildVCard({ name: "דנה", phone: "03-5551234", phoneType: "work", email: "d@a.example", emailType: "home" });
    expect(typed).toContain("TEL;TYPE=WORK:03-5551234\r\n");
    expect(typed).toContain("EMAIL;TYPE=HOME:d@a.example\r\n");
  });
});
