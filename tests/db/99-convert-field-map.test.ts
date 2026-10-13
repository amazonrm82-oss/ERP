import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

/**
 * LEAD-06: owners and admins say which contact and deal field each lead custom
 * field goes to on conversion. No row or "auto" = same label and type (0029),
 * never a field picked by hand; "none" = not copied; a hidden, retyped or
 * deleted target copies nothing.
 */
describe("lead conversion field mapping (LEAD-06)", () => {
  let owner: { id: string }, admin: { id: string }, manager: { id: string }, rep: { id: string };
  let org: string;
  const f: Record<string, string> = {};

  const addField = async (name: string, type: string, key: string, label: string, fieldType: string, options: string[] = [], active = true) => {
    f[name] = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, is_active) values ($1, $2, $3, $4, $5, $6, $7) returning id",
            [org, type, key, label, fieldType, JSON.stringify(options), active],
          )
        ).rows[0].id,
    );
  };

  beforeAll(async () => {
    owner = await createUser("map-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    rep = await addMember(org, owner.id, "member");
    await addField("budget", "lead", "budget", "תקציב", "number");
    await addField("source", "lead", "source_note", "מאיפה שמע", "text");
    await addField("notes", "lead", "notes", "הערה", "text");
    await addField("area", "lead", "area", "תחום", "select", ["שיווק", "מכירות"]);
    // contact: one by the same label, one picked by hand, one hidden, one of another type
    await addField("cBudget", "contact", "c_budget", "תקציב", "number");
    await addField("cBudget2", "contact", "c_money", "כסף", "number");
    await addField("cHeard", "contact", "c_heard", "שמע עלינו", "text");
    await addField("cHidden", "contact", "c_hidden", "מוסתר", "text", [], false);
    await addField("cDate", "contact", "c_date", "תאריך", "date");
    await addField("cNotes", "contact", "c_notes", "הערה", "text");
    // deal
    await addField("dNotes", "deal", "d_notes", "הערה", "text");
    await addField("dArea", "deal", "d_area", "תחום אחר", "select", ["מכירות"]);
  });

  const convert = (leadId: string) =>
    asUser(rep.id, async (q) => (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1) as r", [leadId])).rows[0].r);
  const customOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ c: Record<string, unknown> }>(`select custom_fields as c from public.${table} where id = $1`, [id])).rows[0].c);
  const insertMap = (q: Query, orgId: string, lead: string, type: string, target: string | null) =>
    q("insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, mode, target_field_id) values ($1, $2, $3, $4, $5)", [
      orgId,
      lead,
      type,
      target ? "field" : "none",
      target,
    ]);
  const map = (userId: string, lead: string, type: "contact" | "deal", target: string | null) =>
    asUser(userId, (q) => insertMap(q, org, f[lead], type, target ? f[target] : null));
  const save = (userId: string, entries: Array<[string, "contact" | "deal", string]>) =>
    asUser(userId, async (q) =>
      (
        await q<{ r: { changed: number } }>("select public.save_conversion_field_map($1, $2) as r", [
          org,
          JSON.stringify(entries.map(([lead, type, choice]) => ({ lead_field_id: f[lead], target_type: type, choice: f[choice] ?? choice }))),
        ])
      ).rows[0].r,
    );
  const stateOf = () =>
    asAdmin(async (q) =>
      Object.fromEntries(
        (
          await q<{ lead: string; target_type: string; mode: string; target: string | null }>(
            "select lead_field_id as lead, target_type, mode, target_field_id as target from public.conversion_field_maps where organization_id = $1",
            [org],
          )
        ).rows.map((r) => {
          const name = (id: string | null) => Object.keys(f).find((k) => f[k] === id) ?? id;
          return [`${name(r.lead)}:${r.target_type}`, r.mode === "field" ? name(r.target) : r.mode];
        }),
      ),
    );
  const removedOf = (lead: string, type: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ r: boolean }>(
            "select target_removed as r from public.conversion_field_maps where organization_id = $1 and lead_field_id = $2 and target_type = $3",
            [org, f[lead], type],
          )
        ).rows[0]?.r,
    );
  const values = { budget: 5000, source_note: "פייסבוק", notes: "חם", area: "מכירות" };

  it("with no mapping, values follow the same label and type, as before", async () => {
    const lead = await insertLead(rep.id, org, { custom_fields: JSON.stringify(values) });
    const { contact_id, deal_id } = await convert(lead);
    expect(await customOf("contacts", contact_id)).toEqual({ c_budget: 5000, c_notes: "חם" });
    expect(await customOf("deals", deal_id)).toEqual({ d_notes: "חם" });
  });

  it("only owners and admins of the organization set the mapping", async () => {
    for (const u of [manager, rep]) {
      expect((await pgError(map(u.id, "source", "contact", "cHeard"))).code).toBe("42501");
      expect((await pgError(save(u.id, [["source", "contact", "cHeard"]]))).code).toBe("42501");
    }
    await map(owner.id, "source", "contact", "cHeard");
    await map(admin.id, "area", "deal", "dArea");
    // everyone in the organization reads it
    expect(await asUser(rep.id, (q) => count(q, "select 1 from public.conversion_field_maps where organization_id = $1", [org]))).toBe(2);
    // a save that changes nothing changes nothing, for anyone
    expect(await save(rep.id, [["source", "contact", "cHeard"], ["budget", "deal", "auto"]])).toEqual({ changed: 0 });
  });

  it("refuses a target of another record type or another field type", async () => {
    for (const [lead, type, target] of [
      ["budget", "contact", "cDate"], // number -> date
      ["notes", "contact", "dNotes"], // a deal field as the contact target
      ["cNotes", "deal", "dNotes"], // the source is not a lead field
    ] as const) {
      const err = await pgError(map(admin.id, lead, type, target));
      expect(err.code, `${lead} -> ${target}`).toBe("23514");
      expect(err.hint).toBe("convert_map:invalid");
      const viaSave = await pgError(save(admin.id, [[lead, type, target]]));
      expect(viaSave.hint, `save ${lead} -> ${target}`).toBe("convert_map:invalid");
    }
    // a hidden field cannot be newly picked through the screen
    expect((await pgError(save(admin.id, [["notes", "contact", "cHidden"]]))).hint).toBe("convert_map:invalid");
    // one lead field per picked target
    expect((await pgError(map(admin.id, "notes", "contact", "cHeard"))).code).toBe("23505");
    // clients change only the mode and the target
    expect(
      (await pgError(asUser(admin.id, (q) => q("update public.conversion_field_maps set target_type = 'deal' where organization_id = $1", [org])))).code,
    ).toBe("42501");
  });

  it("the save checks its input shape", async () => {
    const raw = (map: unknown) =>
      pgError(asUser(admin.id, (q) => q("select public.save_conversion_field_map($1, $2)", [org, JSON.stringify(map)])));
    for (const bad of [
      {},
      [{ lead_field_id: "x", target_type: "contact", choice: "auto" }],
      [{ lead_field_id: f.notes, target_type: "company", choice: "auto" }],
      [{ lead_field_id: f.notes, target_type: "contact", choice: "maybe" }],
      [{ lead_field_id: f.notes, target_type: "contact", choice: 1 }],
      [
        { lead_field_id: f.notes, target_type: "contact", choice: "auto" },
        { lead_field_id: f.notes, target_type: "contact", choice: "none" },
      ],
      Array.from({ length: 401 }, () => ({ lead_field_id: f.notes, target_type: "contact", choice: "auto" })),
    ]) {
      const err = await raw(bad);
      expect(err.code, JSON.stringify(bad).slice(0, 80)).toBe("22023");
      expect(err.hint).toBe("convert_map:invalid");
    }
    const twice = await raw([
      { lead_field_id: f.notes, target_type: "deal", choice: f.dNotes },
      { lead_field_id: f.source, target_type: "deal", choice: f.dNotes },
    ]);
    expect([twice.code, twice.hint]).toEqual(["23505", "convert_map:duplicate"]);
  });

  it("the save applies the whole screen in one transaction", async () => {
    // the second entry fails: nothing of the first one stays
    const err = await pgError(save(admin.id, [["budget", "deal", "none"], ["notes", "contact", "cDate"]]));
    expect(err.hint).toBe("convert_map:invalid");
    expect(await stateOf()).toEqual({ "source:contact": "cHeard", "area:deal": "dArea" });
    // a swap of two picked fields, a "none" and a back-to-auto in one call
    await addField("dDesc", "deal", "d_desc", "תיאור", "text");
    await save(admin.id, [["notes", "deal", "dDesc"], ["source", "deal", "dNotes"]]);
    // four entries change; the two that swap are released first and then set (two writes each)
    expect(await save(admin.id, [["notes", "deal", "dNotes"], ["source", "deal", "dDesc"], ["source", "contact", "auto"], ["budget", "deal", "none"]])).toEqual({
      changed: 6,
    });
    expect(await stateOf()).toEqual({
      "source:contact": "auto",
      "area:deal": "dArea",
      "notes:deal": "dNotes",
      "source:deal": "dDesc",
      "budget:deal": "none",
    });
    // a field another stored pick holds
    expect((await pgError(save(admin.id, [["source", "deal", "dNotes"]]))).code).toBe("23505");
    // back to the starting point of the next tests
    await save(admin.id, [["notes", "deal", "auto"], ["source", "deal", "auto"], ["budget", "deal", "auto"], ["source", "contact", "cHeard"]]);
  });

  it("an explicit mapping, and an explicit 'do not copy', replace the label rule", async () => {
    await save(admin.id, [["budget", "contact", "cBudget2"], ["notes", "deal", "none"]]);
    const lead = await insertLead(rep.id, org, { custom_fields: JSON.stringify(values) });
    const { contact_id, deal_id } = await convert(lead);
    // source_note -> c_heard (by hand), budget -> c_money (by hand), notes -> c_notes (label rule still)
    expect(await customOf("contacts", contact_id)).toEqual({ c_heard: "פייסבוק", c_money: 5000, c_notes: "חם" });
    // notes not copied to the deal, area -> d_area by hand
    expect(await customOf("deals", deal_id)).toEqual({ d_area: "מכירות" });
  });

  it("an explicit target wins over another lead field's same-label rule, even when the picked lead field is empty", async () => {
    // source is picked by hand for c_notes, which notes would reach by its label
    await save(admin.id, [["source", "contact", "cNotes"]]);
    const both = await insertLead(rep.id, org, { custom_fields: JSON.stringify(values) });
    const r1 = await convert(both);
    expect(await customOf("contacts", r1.contact_id)).toEqual({ c_notes: "פייסבוק", c_money: 5000 });
    // the picked lead field is empty on this lead: c_notes stays empty, notes does not take it
    const onlyNotes = await insertLead(rep.id, org, { custom_fields: JSON.stringify({ notes: "חם" }) });
    const r2 = await convert(onlyNotes);
    expect(await customOf("contacts", r2.contact_id)).toEqual({});
    await save(admin.id, [["source", "contact", "cHeard"]]);
  });

  it("a value the target does not accept is not copied", async () => {
    const lead = await insertLead(rep.id, org, { custom_fields: JSON.stringify({ area: "שיווק" }) });
    const { deal_id } = await convert(lead);
    expect(await customOf("deals", deal_id)).toEqual({});
  });

  it("a hidden, retyped or deleted target is skipped, never an error", async () => {
    await asUser(admin.id, (q) =>
      q("update public.conversion_field_maps set target_field_id = $2 where organization_id = $1 and lead_field_id = $3 and target_type = 'contact'", [
        org,
        f.cHidden,
        f.source,
      ]),
    );
    // the target of budget changes type after it was picked
    await asAdmin((q) => q("update public.field_definitions set field_type = 'text' where id = $1", [f.cBudget2]));
    const lead = await insertLead(rep.id, org, { custom_fields: JSON.stringify(values) });
    const { contact_id } = await convert(lead);
    // neither falls back to the label rule: c_budget (same label as budget) stays empty
    expect(await customOf("contacts", contact_id)).toEqual({ c_notes: "חם" });

    // deleting the target: nothing is copied, and the row remembers that its field was deleted
    await asUser(admin.id, (q) => q("delete from public.field_definitions where id = $1", [f.dArea]));
    expect((await stateOf())["area:deal"]).toBe("none");
    expect(await removedOf("area", "deal")).toBe(true);
    const lead2 = await insertLead(rep.id, org, { custom_fields: JSON.stringify(values) });
    const { deal_id } = await convert(lead2);
    expect(await customOf("deals", deal_id)).toEqual({});
  });

  it("a deleted target stays marked until a person chooses again; a 'do not copy' is never marked", async () => {
    // budget -> deal is a person's "do not copy" from an earlier test
    expect((await stateOf())["budget:deal"]).toBe("auto");
    await save(admin.id, [["budget", "deal", "none"]]);
    expect(await removedOf("budget", "deal")).toBe(false);
    // a person clearing the target of a field that still exists is not a deletion
    await asUser(admin.id, (q) =>
      q("update public.conversion_field_maps set target_field_id = null where organization_id = $1 and lead_field_id = $2 and target_type = 'contact'", [
        org,
        f.source,
      ]),
    );
    expect(await removedOf("source", "contact")).toBe(false);
    expect((await stateOf())["source:contact"]).toBe("none");
    // the mark is server only
    expect(
      (await pgError(asUser(admin.id, (q) => q("update public.conversion_field_maps set target_removed = false where organization_id = $1", [org])))).code,
    ).toBe("42501");
    expect(await removedOf("budget", "contact")).toBe(false);
    // choosing "do not copy" again on the deleted one is a choice of a person: the mark goes
    expect(await removedOf("area", "deal")).toBe(true);
    expect(await save(admin.id, [["area", "deal", "none"]])).toEqual({ changed: 1 });
    expect(await removedOf("area", "deal")).toBe(false);
    expect((await stateOf())["area:deal"]).toBe("none");
  });

  it("deleting a lead field and its picked target in one statement works", async () => {
    await addField("tmpLead", "lead", "tmp_lead", "זמני", "text");
    await addField("tmpTarget", "deal", "tmp_target", "זמני יעד", "text");
    await save(admin.id, [["tmpLead", "deal", "tmpTarget"]]);
    await asUser(admin.id, (q) => q("delete from public.field_definitions where organization_id = $1 and id in ($2, $3)", [org, f.tmpLead, f.tmpTarget]));
    expect(await asAdmin((q) => count(q, "select 1 from public.conversion_field_maps where lead_field_id = $1", [f.tmpLead]))).toBe(0);
  });

  it("deleting a picked target works after the lead field moved to another record type", async () => {
    await addField("movLead", "lead", "mov_lead", "נודד", "text");
    await addField("movTarget", "deal", "mov_target", "נודד יעד", "text");
    await save(admin.id, [["movLead", "deal", "movTarget"]]);
    await asUser(admin.id, (q) => q("update public.field_definitions set object_type = 'contact' where id = $1", [f.movLead]));
    await asUser(admin.id, (q) => q("delete from public.field_definitions where id = $1", [f.movTarget]));
    expect((await stateOf())["movLead:deal"]).toBe("none");
    expect(await removedOf("movLead", "deal")).toBe(true);
  });

  it("deleting the lead field removes its mapping; changes are audited", async () => {
    await asUser(admin.id, (q) => q("delete from public.field_definitions where id = $1", [f.notes]));
    expect(await asAdmin((q) => count(q, "select 1 from public.conversion_field_maps where lead_field_id = $1", [f.notes]))).toBe(0);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'conversion_field_maps'", [org])),
    ).toBeGreaterThan(0);
  });

  it("a read-only organization keeps its mapping as it is", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(map(admin.id, "budget", "deal", null))).code).toBe("42501");
      expect((await pgError(save(admin.id, [["area", "deal", "auto"]]))).code).toBe("42501");
      await asUser(admin.id, async (q) => {
        expect((await q("update public.conversion_field_maps set mode = 'auto', target_field_id = null where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.conversion_field_maps where organization_id = $1", [org])).rowCount).toBe(0);
      });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("an outsider gets the same refusal whatever the organization holds", async () => {
    const other = await createUser("map-other");
    const otherOrg = await createOrg(other.id);
    const random = "00000000-0000-4000-8000-000000000001";
    // into this organization: always the policy's 42501
    for (const [lead, target] of [
      [f.budget, f.cBudget], // a real lead field and a fitting target
      [f.budget, f.cHeard], // a target of another type
      [f.cNotes, null], // not a lead field
      [random, null], // no such field
    ] as const) {
      const err = await pgError(asUser(other.id, (q) => insertMap(q, org, lead, "contact", target)));
      expect(err.code, `${lead} -> ${target}`).toBe("42501");
      expect(err.hint ?? null).toBeNull();
    }
    const viaSave = await pgError(
      asUser(other.id, (q) =>
        q("select public.save_conversion_field_map($1, $2)", [org, JSON.stringify([{ lead_field_id: f.budget, target_type: "contact", choice: f.cBudget }])]),
      ),
    );
    expect(viaSave.code).toBe("23514");
    expect(viaSave.hint).toBe("convert_map:invalid");
    const viaSaveRandom = await pgError(
      asUser(other.id, (q) =>
        q("select public.save_conversion_field_map($1, $2)", [org, JSON.stringify([{ lead_field_id: random, target_type: "contact", choice: f.cBudget }])]),
      ),
    );
    expect([viaSaveRandom.code, viaSaveRandom.hint]).toEqual([viaSave.code, viaSave.hint]);
    // into their own organization with this organization's fields: refused, never linked
    const err = await pgError(asUser(other.id, (q) => insertMap(q, otherOrg, f.budget, "contact", null)));
    expect(["23514", "23503"]).toContain(err.code);
  });
});
