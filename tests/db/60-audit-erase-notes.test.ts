import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-4: a privacy erasure reaches the logged edits of a note that was linked to the erased
// record at any time, not only when the entry names it; a list export keeps no typed text.
describe("privacy erasure of notes moved by a conversion (RVW-4)", () => {
  let owner: U, rep: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("rvw4-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "rvw4-rep");
  });

  /** A lead with a note the rep edits (logged with old and new text), then converted to a contact and a deal. */
  async function convertedWithEditedNote(name: string): Promise<{ lead: string; note: string; contact: string; deal: string }> {
    const lead = await insertLead(rep.id, org, { full_name: name });
    const note = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'טלפון פרטי 050', $2) returning id", [org, lead])).rows[0].id,
    );
    await asUser(rep.id, (q) => q("update public.activities set body = 'טלפון פרטי 052' where id = $1", [note]));
    const r = await asUser(rep.id, async (q) =>
      (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1, true, null, 1000) as r", [lead])).rows[0].r,
    );
    return { lead, note, contact: r.contact_id, deal: r.deal_id };
  }

  const purge = (table: "leads" | "contacts" | "deals", id: string) =>
    asUser(owner.id, async (q) => {
      await q(`update public.${table} set deleted_at = now() where id = $1`, [id]);
      await q(`delete from public.${table} where id = $1`, [id]);
    });
  const erase = (type: string, id: string) => asUser(owner.id, (q) => q("select public.audit_erase_record($1, $2, $3)", [org, type, id]));
  const noteLog = (note: string) =>
    asAdmin(async (q) => (await q<{ t: string | null }>("select string_agg(changes::text, ' ') as t from public.audit_log where entity_type = 'activities' and entity_id = $1", [note])).rows[0].t ?? "");
  const exists = (note: string) => asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [note]));

  it("the edit entry names only the lead; the conversion links the note to the contact and the deal", async () => {
    const { lead, note, contact, deal } = await convertedWithEditedNote("רות כהן");
    const entry = await asAdmin(async (q) => (await q<{ changes: Record<string, unknown> }>("select changes from public.audit_log where entity_type = 'activities' and entity_id = $1", [note])).rows[0].changes);
    expect(entry.lead_id).toBe(lead);
    expect(entry.contact_id).toBeUndefined();
    const linked = await asAdmin(async (q) => (await q<{ record_id: string }>("select record_id from app.activity_audit_links where activity_id = $1 order by record_id", [note])).rows.map((r) => r.record_id));
    expect(linked.sort()).toEqual([lead, contact, deal].sort());
  });

  it("lead erased while the note lives on, then contact and deal purged and erased: the old text is gone", async () => {
    const { lead, note, contact, deal } = await convertedWithEditedNote("מיכל לוי");
    await purge("leads", lead);
    await erase("leads", lead);
    // the note still lives on the contact and the deal, so its history stays
    expect(await exists(note)).toBe(1);
    expect(await noteLog(note)).toContain("פרטי 050");

    await purge("contacts", contact);
    await purge("deals", deal);
    expect(await exists(note)).toBe(0);
    await erase("contacts", contact);
    const left = await noteLog(note);
    expect(left).not.toContain("פרטי");
    expect(left).toContain('"erased": true');
  });

  it("only the deal erased, after all three were purged: the old text is gone", async () => {
    const { lead, note, contact, deal } = await convertedWithEditedNote("יעל אברהם");
    await purge("leads", lead);
    await purge("contacts", contact);
    await purge("deals", deal);
    expect(await exists(note)).toBe(0);
    await erase("deals", deal);
    expect(await noteLog(note)).not.toContain("פרטי");
  });

  it("a note deleted by a user after the lead was erased is erased with the contact", async () => {
    const { lead, note, contact } = await convertedWithEditedNote("נעמה דוד");
    await purge("leads", lead);
    await erase("leads", lead);
    await asUser(owner.id, (q) => q("delete from public.activities where id = $1", [note]));
    await purge("contacts", contact);
    await erase("contacts", contact);
    expect(await noteLog(note)).not.toContain("פרטי");
  });

  it("clients cannot read or write the link list", async () => {
    for (const sql of ["select * from app.activity_audit_links", "insert into app.activity_audit_links values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"]) {
      await expect(asUser(owner.id, (q) => q(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("a list export keeps only the shape of its filters (RVW-4)", () => {
  let owner: U;
  let org: string;
  const uuid = "8c0b6c2e-6f43-4d3e-9a41-111111111111";

  beforeAll(async () => {
    owner = await createUser("rvw4-export-owner");
    org = await createOrg(owner.id);
  });

  /** Logs an export with these filters and returns the filters as stored. */
  const stored = async (filters: unknown): Promise<unknown> => {
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'lead', 'csv', 4, 'filtered', $2)", [org, JSON.stringify(filters)]));
    return asAdmin(async (q) =>
      (await q<{ f: unknown }>("select changes -> 'filters' as f from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1", [org])).rows[0].f,
    );
  };
  const tree = (conditions: unknown[], match: unknown = "all") => ({ match, groups: [{ match: "any", conditions }] });

  it("the search becomes 'a search was used'; typed values become true, shaped values stay", async () => {
    const f = tree([
      { field: "full_name", op: "contains", value: "משה כהן" },
      { field: "phone", op: "equals", value: "0501234567" },
      { field: "status", op: "is", value: uuid },
      { field: "created_at", op: "last_days", value: "7" },
      { field: "cf:due", op: "before", value: "2026-10-01" },
      { field: "owner_id", op: "is", value: "me" },
      { field: "email", op: "not_empty" },
    ]);
    const out = await stored({ q: "משה 050", f: JSON.stringify(f), sort: "name" });
    expect(out).toEqual({
      q: true,
      sort: "name",
      f: tree([
        { field: "full_name", op: "contains", value: true },
        { field: "phone", op: "equals", value: true },
        { field: "status", op: "is", value: uuid },
        { field: "created_at", op: "last_days", value: "7" },
        { field: "cf:due", op: "before", value: "2026-10-01" },
        { field: "owner_id", op: "is", value: "me" },
        { field: "email", op: "not_empty" },
      ]),
    });
    expect(JSON.stringify(out)).not.toContain("משה");
    expect(JSON.stringify(out)).not.toContain("0501234567");
  });

  it("free text under any operator, arrays, objects, odd fields and a long match are not kept", async () => {
    const out = await stored({
      f: tree(
        [
          { field: "full_name", op: "is", value: "משה כהן 0501234567" },
          { field: "tags", op: "has", value: [uuid, "רחוב הרצל 5"] },
          { field: "tags", op: "has", value: [uuid] },
          { field: "x", op: "is", value: { name: "סוד" } },
          { field: "שם פרטי", op: "is ever so long and odd", value: "1" },
        ],
        "all and also my secret note",
      ),
    });
    expect(out).toEqual({
      f: {
        groups: [
          {
            match: "any",
            conditions: [
              { field: "full_name", op: "is", value: true },
              { field: "tags", op: "has", value: true },
              { field: "tags", op: "has", value: [uuid] },
              { field: "x", op: "is", value: true },
              // an unknown operator keeps no value (0088)
              { field: true, op: true, value: true },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toMatch(/משה|הרצל|סוד|secret|פרטי/);
  });

  it("only known keys of a known shape are kept", async () => {
    const out = await stored({
      q2: "secret",
      tag: uuid,
      status: "not an id",
      who: "everyone",
      picked: 3,
      ids: "3 people",
      sort: "name desc; drop",
      view: "הלקוחות של משה",
      pipeline: uuid,
    });
    expect(out).toEqual({ tag: uuid, picked: 3, view: true, pipeline: uuid });
    expect(await stored({ sort: "-created_at", who: "mine", view: uuid, ids: 2 })).toEqual({ sort: "-created_at", who: "mine", view: uuid, ids: 2 });
  });

  it("never raises, whatever the filters hold", async () => {
    const odd: unknown[] = [
      { f: "{not json" },
      { f: "5" },
      { f: 7 },
      { f: { groups: "x" } },
      { f: { match: "all", groups: [1, "a", null, { conditions: [null, 3, { field: 5, op: [], value: null }] }] } },
      { f: tree([{ field: "a", op: "is", value: [] }, { field: "a", op: "is", value: Array(30).fill(uuid) }]) },
      { q: null, tag: null, sort: 5, picked: "x" },
    ];
    const out = [];
    for (const filters of odd) out.push(await stored(filters));
    expect(out[0]).toEqual({ f: true });
    expect(out[1]).toEqual({ f: true });
    expect(out[2]).toEqual({ f: true });
    expect(out[3]).toEqual({ f: true });
    expect(out[4]).toEqual({ f: { match: "all", groups: [{ conditions: [] }, { conditions: [] }, { conditions: [] }, { conditions: [{ field: true, op: true }] }] } });
    expect(out[5]).toEqual({ f: tree([{ field: "a", op: "is", value: true }, { field: "a", op: "is", value: true }]) });
    expect(out[6]).toEqual({});
  });
});
