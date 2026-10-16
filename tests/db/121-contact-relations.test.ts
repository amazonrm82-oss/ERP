import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";
import { migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

type U = { id: string; email: string };

// CON-06: relations between contacts (spouse, parent, referrer), the business's managed list of types, and the
// referrals report.
describe("relations between contacts (CON-06)", () => {
  let owner: U, rep: U;
  let org: string;
  const types: Record<string, string> = {};

  const contact = (name: string, user?: U, o = org) =>
    asUser((user ?? owner).id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [o, name])).rows[0].id);
  const relate = (a: string, b: string, type: string, user?: U) =>
    asUser((user ?? owner).id, async (q) =>
      (await q<{ id: string }>("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4) returning id", [org, a, b, type])).rows[0].id,
    );
  const relationsOf = (id: string) =>
    asAdmin(async (q) =>
      (await q<{ a: string; b: string; t: string }>(
        "select contact_id as a, related_contact_id as b, type_id as t from public.contact_relations where $1 in (contact_id, related_contact_id) order by type_id, contact_id",
        [id],
      )).rows,
    );

  beforeAll(async () => {
    owner = await createUser("rel-owner");
    org = await createOrg(owner.id, "עסק קשרים");
    rep = await addMember(org, owner.id, "member", "rel-rep");
    const rows = await asAdmin(async (q) => (await q<{ id: string; key: string }>("select id, key from public.contact_relation_types where organization_id = $1", [org])).rows);
    for (const row of rows) types[row.key] = row.id;
  });

  it("a new business starts with the four default types, in order, and existing businesses with an empty list get them once", async () => {
    const rows = await asAdmin(async (q) =>
      (await q<{ name: string; reverse_name: string | null; key: string }>("select name, reverse_name, key from public.contact_relation_types where organization_id = $1 order by position", [org])).rows,
    );
    expect(rows).toEqual([
      { name: "בן/בת זוג של", reverse_name: null, key: "spouse" },
      { name: "בן/בת משפחה של", reverse_name: null, key: "family" },
      { name: "הורה של", reverse_name: "ילד/ה של", key: "parent" },
      { name: "הפנה/תה את", reverse_name: "הופנה/תה על ידי", key: "referral" },
    ]);
    // a business whose list is empty (as before the migration) is seeded by it, once; a list with types is left alone
    const boss = await createUser("rel-empty");
    const empty = await createOrg(boss.id, "עסק בלי סוגים");
    await asAdmin((q) => q("delete from public.contact_relation_types where organization_id = $1", [empty]));
    await asUser(owner.id, (q) => q("insert into public.contact_relation_types (organization_id, name) values ($1, 'שותף/ה של')", [org]));
    const rerun = rerunClosure([migrationFile("_contact_relations.sql")]);
    await asAdmin(async (q) => {
      for (const sql of rerun.sql) await q(sql);
      for (const sql of rerun.sql) await q(sql);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relation_types where organization_id = $1", [empty]))).toBe(4);
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relation_types where organization_id = $1", [org]))).toBe(5);
  });

  it("a list that lacks the family type gets it, last; a renamed list keeps its names, and a type already named so is not doubled", async () => {
    const boss = await createUser("rel-family");
    const [lacking, renamed, named] = [await createOrg(boss.id, "בלי משפחה"), await createOrg(boss.id, "שמות משלו"), await createOrg(boss.id, "שם קיים")];
    // the list as it was before the family type: three defaults, one of them renamed
    await asAdmin(async (q) => {
      await q("delete from public.contact_relation_types where organization_id = $1 and key = 'family'", [lacking]);
      await q("update public.contact_relation_types set name = 'קרוב/ת של' where organization_id = $1 and key = 'family'", [renamed]);
      await q("delete from public.contact_relation_types where organization_id = $1 and key = 'family'", [named]);
      await q("insert into public.contact_relation_types (organization_id, name, position) values ($1, 'בן/בת משפחה של', 9)", [named]);
    });
    const list = (o: string) =>
      asAdmin(async (q) => (await q<{ name: string; key: string | null }>("select name, key from public.contact_relation_types where organization_id = $1 order by position, created_at", [o])).rows);
    const before = { renamed: await list(renamed), named: await list(named) };
    const rerun = rerunClosure([migrationFile("_contact_relations.sql")]);
    await asAdmin(async (q) => {
      for (const sql of rerun.sql) await q(sql);
    });
    expect((await list(lacking)).map((t) => t.key)).toEqual(["spouse", "parent", "referral", "family"]);
    expect((await list(lacking)).at(-1)?.name).toBe("בן/בת משפחה של");
    expect(await list(renamed)).toEqual(before.renamed);
    expect(await list(named)).toEqual(before.named);
  });

  it("the same type between two people once, in either direction; two different types are fine; never a person with themself", async () => {
    const [mom, son] = [await contact("אמא"), await contact("בן")];
    await relate(mom, son, types.parent);
    expect((await pgError(relate(mom, son, types.parent))).code).toMatch(/^(23505|P0001)$/);
    expect((await pgError(relate(son, mom, types.parent))).hint).toBe("contact_relation:exists");
    expect(await relate(son, mom, types.referral)).toBeTruthy();
    expect((await pgError(relate(mom, mom, types.spouse))).code).toBe("23514");
  });

  it("a person picks only an active type; a hidden type stays on its relations; a type in use is not deleted, an unused one is", async () => {
    const [a, b, c] = [await contact("א"), await contact("ב"), await contact("ג")];
    const custom = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contact_relation_types (organization_id, name, reverse_name) values ($1, 'סבא/סבתא של', 'נכד/ה של') returning id", [org])).rows[0].id,
    );
    await relate(a, b, custom);
    await asUser(owner.id, (q) => q("update public.contact_relation_types set is_active = false where id = $1", [custom]));
    expect((await pgError(relate(a, c, custom))).hint).toBe("contact_relation:type");
    expect(await relationsOf(b)).toHaveLength(1);
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.contact_relation_types where id = $1", [custom])))).code).toBe("23503");
    const unused = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contact_relation_types (organization_id, name) values ($1, 'שכן/ה של') returning id", [org])).rows[0].id);
    // a member does not manage the list: no new type, no rename, no removal of an unused one
    expect((await pgError(asUser(rep.id, (q) => q("insert into public.contact_relation_types (organization_id, name) values ($1, 'x')", [org])))).code).toBe("42501");
    expect((await asUser(rep.id, (q) => q("update public.contact_relation_types set name = 'x' where id = $1", [unused]))).rowCount).toBe(0);
    expect((await asUser(rep.id, (q) => q("delete from public.contact_relation_types where id = $1", [unused]))).rowCount).toBe(0);
    // a read-only business keeps its list as it is, even for the owner
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await asUser(owner.id, (q) => q("update public.contact_relation_types set name = 'x' where id = $1", [unused]))).rowCount).toBe(0);
      expect((await asUser(owner.id, (q) => q("delete from public.contact_relation_types where id = $1", [unused]))).rowCount).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    expect((await asUser(owner.id, (q) => q("delete from public.contact_relation_types where id = $1", [unused]))).rowCount).toBe(1);
  });

  it("never from or to a contact in the recycle bin; a contact in the bin no longer gives the right to remove one; a read-only business adds no type", async () => {
    const [a, b, c] = [await contact("בסל א"), await contact("חי ב"), await contact("חי ג")];
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [a]));
    // from a contact in the bin (the owner edits the live one too), and to one
    expect((await pgError(relate(a, b, types.spouse))).code).toBe("42501");
    expect((await pgError(relate(b, a, types.spouse))).code).toBe("42501");

    // rep edits only their own contact; once it is in the bin it no longer lets them remove the relation
    const [mine, theirs] = [await contact("של הנציג", rep), c];
    const relation = await relate(mine, theirs, types.spouse);
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [mine]));
    expect(await asUser(rep.id, async (q) => (await q("delete from public.contact_relations where id = $1", [relation])).rowCount)).toBe(0);
    await asUser(rep.id, (q) => q("delete from public.contact_relations"));
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where id = $1", [relation]))).toBe(1);

    // a read-only business: the owner adds no type
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(asUser(owner.id, (q) => q("insert into public.contact_relation_types (organization_id, name) values ($1, 'בזמן קריאה בלבד')", [org])))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
  });

  it("at most 20 types per business, and at most 50 relations per contact from the browser", async () => {
    const boss = await createUser("rel-caps");
    const capOrg = await createOrg(boss.id, "עסק מכסות");
    await asUser(boss.id, async (q) => {
      // four seeded, sixteen more
      for (let i = 0; i < 16; i++) await q("insert into public.contact_relation_types (organization_id, name) values ($1, $2)", [capOrg, `סוג ${i}`]);
    });
    expect((await pgError(asUser(boss.id, (q) => q("insert into public.contact_relation_types (organization_id, name) values ($1, 'עוד אחד')", [capOrg])))).hint).toBe(
      "contact_relation_types:max",
    );
    const spouse = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'spouse'", [capOrg])).rows[0].id);
    const people = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) select $1, 'אדם ' || n from generate_series(1, 52) n returning id", [capOrg])).rows.map((r) => r.id),
    );
    await asUser(boss.id, async (q) => {
      for (const other of people.slice(1, 51)) {
        await q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [capOrg, people[0], other, spouse]);
      }
    });
    const over = await pgError(
      asUser(boss.id, (q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [capOrg, people[51], people[0], spouse])),
    );
    expect(over.hint).toBe("contact_relation:max");
  });

  it("a DELETE with no WHERE never reaches a relation with a person the deleter cannot read; the cap counts those too", async () => {
    const boss = await createUser("rel-hidden-owner");
    const hiddenOrg = await createOrg(boss.id, "עסק קשר מוסתר");
    const seller = await addMember(hiddenOrg, boss.id, "member", "rel-hidden-rep");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [hiddenOrg]));
    const spouse = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'spouse'", [hiddenOrg])).rows[0].id);
    const [mine, mine2, theirs] = [await contact("של הנציג", seller, hiddenOrg), await contact("עוד של הנציג", seller, hiddenOrg), await contact("של הבעלים", boss, hiddenOrg)];
    const add = (user: U, a: string, b: string) =>
      asUser(user.id, (q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [hiddenOrg, a, b, spouse]));
    await add(boss, mine, theirs);
    await add(seller, mine, mine2);
    expect((await asUser(seller.id, (q) => q("delete from public.contact_relations"))).rowCount).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where organization_id = $1 and related_contact_id = $2", [hiddenOrg, theirs]))).toBe(1);
    // 49 more relations of the seller's contact with people the seller cannot read: the next one is refused
    await asAdmin((q) =>
      q(
        `with made as (insert into public.contacts (organization_id, first_name, owner_id) select $1, 'מוסתר ' || n, $3 from generate_series(1, 49) n returning id)
         insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) select $1, $2, id, $4 from made`,
        [hiddenOrg, mine, boss.id, spouse],
      ),
    );
    expect(await asUser(seller.id, (q) => count(q, "select 1 from public.contact_relations where $1 in (contact_id, related_contact_id)", [mine]))).toBe(0);
    expect((await pgError(add(seller, mine, mine2))).hint).toBe("contact_relation:max");
  });

  it("never with another business's contact or type", async () => {
    const boss = await createUser("rel-other");
    const other = await createOrg(boss.id, "עסק זר");
    const stranger = await contact("זר", boss, other);
    const theirType = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'spouse'", [other])).rows[0].id);
    const mine = await contact("שלי");
    expect((await pgError(relate(mine, stranger, types.spouse))).code).toMatch(/^(42501|23503)$/);
    // another business's type is not on this business's list
    expect((await pgError(relate(mine, await contact("שלי ב"), theirType))).hint).toBe("contact_relation:type");
    const forced = await pgError(
      asAdmin((q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, mine, stranger, types.spouse])),
    );
    expect(forced.code).toBe("23503");
  });

  it("each side's history gets its phrase without the other person's name; erasing one leaves nothing of them in the other's history", async () => {
    const [dana, yoav] = [await contact("דנה ממחקת"), await contact("יואב נשאר")];
    await relate(dana, yoav, types.parent);
    const entries = (id: string) =>
      asAdmin(async (q) =>
        (await q<{ c: { relation?: { old: string | null; new: string | null }; related_contact_id?: string } }>(
          "select changes as c from public.audit_log where entity_type = 'contacts' and entity_id = $1 and changes ? 'relation' order by created_at, id",
          [id],
        )).rows.map((r) => r.c),
      );
    expect(await entries(dana)).toEqual([{ relation: { old: null, new: "הורה של" }, related_contact_id: yoav }]);
    expect(await entries(yoav)).toEqual([{ relation: { old: null, new: "ילד/ה של" }, related_contact_id: dana }]);

    // Dana is purged (her relation goes with her by cascade) and erased at her request
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [dana]);
      await q("delete from public.contacts where id = $1", [dana]);
      await q("select public.audit_erase_record($1, 'contacts', $2)", [org, dana]);
    });
    expect(await relationsOf(yoav)).toEqual([]);
    const yoavText = await asAdmin(async (q) => (await q<{ t: string }>("select string_agg(changes::text, ' ') as t from public.audit_log where entity_id = $1", [yoav])).rows[0].t);
    expect(yoavText).not.toContain("דנה");
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes::text like '%הורה של%'", [dana]))).toBe(0);
  });

  it("a merge keeps the duplicate's relations on the kept contact, never one with itself and never twice", async () => {
    const [keep, dup, kid, partner] = [await contact("רון"), await contact("רון כפול"), await contact("ילדה"), await contact("בת זוג")];
    await relate(dup, kid, types.parent);
    await relate(keep, partner, types.spouse);
    await relate(partner, dup, types.spouse);
    await relate(dup, keep, types.referral);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    const after = await relationsOf(keep);
    expect(after).toHaveLength(2);
    expect(after).toEqual(
      expect.arrayContaining([
        { a: keep, b: kid, t: types.parent },
        { a: keep, b: partner, t: types.spouse },
      ]),
    );
  });

  it("a relation keeps a sample contact; removing sample data leaves real people and the relation", async () => {
    const boss = await createUser("rel-sample");
    const sampleOrg = await createOrg(boss.id, "עסק דוגמה");
    await asUser(boss.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    type R = { record_type: string; record_id: string; removable: boolean };
    const records = () => asUser(boss.id, async (q) => (await q<R>("select * from public.sample_data_records($1)", [sampleOrg])).rows);
    const sample = (await records()).find((r) => r.record_type === "contact")!.record_id;
    const real = await contact("אמיתית", boss, sampleOrg);
    const spouse = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'spouse'", [sampleOrg])).rows[0].id);
    await asUser(boss.id, (q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [sampleOrg, real, sample, spouse]));
    expect((await records()).find((r) => r.record_id === sample)?.removable).toBe(false);
    await asUser(boss.id, (q) => q("select public.sample_data_remove($1)", [sampleOrg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where organization_id = $1", [sampleOrg]))).toBe(1);
  });

  it("undo of one's own import keeps a contact someone related to another one after the import (PRM-01)", async () => {
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, rep.id, ["import"]]));
    const job = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'c.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [related, quiet] = await asUser(rep.id, async (q) => {
      const ins = async (name: string) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, import_job_id) values ($1, $2, $3) returning id", [org, name, job])).rows[0].id;
      const ids = [await ins("קושר אחרי"), await ins("שקט")];
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return ids;
    });
    const friend = await contact("ממליץ");
    await relate(friend, related, types.referral);
    const result = await asUser(rep.id, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [org, job])).rows[0].r);
    expect(result).toEqual({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [quiet]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is null", [related]))).toBe(1);
  });

  it("the referrals report counts the referral type under its current name, by referrer, with the referred contacts who won a deal", async () => {
    const boss = await createUser("rel-report");
    const reportOrg = await createOrg(boss.id, "עסק הפניות");
    const member = await addMember(reportOrg, boss.id, "member", "rel-report-member");
    const t = await asAdmin(async (q) =>
      Object.fromEntries((await q<{ id: string; key: string }>("select id, key from public.contact_relation_types where organization_id = $1", [reportOrg])).rows.map((r) => [r.key, r.id])),
    );
    const mk = (name: string, by: U = boss) => contact(name, by, reportOrg);
    const link = (a: string, b: string, type: string) =>
      asUser(boss.id, (q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [reportOrg, a, b, type]));
    const [sara, x, y, z] = [await mk("שרה מפנה"), await mk("איקס"), await mk("וואי"), await mk("זד")];
    await link(sara, x, t.referral);
    await link(sara, y, t.referral);
    await link(sara, z, t.spouse); // not a referral
    const { pipelineId, stages } = await defaultPipeline(reportOrg);
    const won = stages.find((s) => s.kind === "won")!.id;
    await asUser(boss.id, (q) =>
      q("insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, contact_id) values ($1, 'מכירה', 70000, $2, $3, $4)", [reportOrg, pipelineId, won, x]),
    );
    // renamed: still counted
    await asUser(boss.id, (q) => q("update public.contact_relation_types set name = 'המליץ/ה על' where id = $1", [t.referral]));
    const run = (u: U, from = "2000-01-01T00:00:00Z", to = "2100-01-01T00:00:00Z") =>
      asUser(u.id, async (q) =>
        (await q<{ r: { totals: Record<string, number>; by_referrer: Array<Record<string, unknown>> } }>("select public.report_referrals($1, $2, $3) as r", [reportOrg, from, to])).rows[0].r,
      );
    const all = await run(boss);
    expect(all.totals).toEqual({ referrals: 2, referrers: 1, customers: 1, won_amount: 70000 });
    expect(all.by_referrer).toEqual([{ referrer_id: sara, referrer_kind: "contact", name: "שרה מפנה", referred: 2, customers: 1, won_amount: 70000 }]);
    // another period: nothing
    expect((await run(boss, "2000-01-01T00:00:00Z", "2001-01-01T00:00:00Z")).totals.referrals).toBe(0);
    // RLS decides: with visibility "own" a member who reads none of them sees nothing
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [reportOrg]));
    expect((await run(member)).totals).toEqual({ referrals: 0, referrers: 0, customers: 0, won_amount: 0 });
    // the export of the report is logged under its key
    await asUser(boss.id, (q) => q("select public.log_export($1, 'report', 'referrals', 1, 'csv')", [reportOrg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'export' and changes ->> 'report' = 'referrals'", [reportOrg]))).toBe(1);
  });

  it("a lead refers a contact: only as the referrer of the referral type, once, never in another business", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד ממליץ", phone: "052-7770001" });
    const referred = await contact("הופנה על ידי ליד");
    const refer = (leadId: string, contactId: string, type: string, user: U = owner) =>
      asUser(user.id, (q) =>
        q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, leadId, contactId, type]),
      );
    expect((await pgError(refer(lead, referred, types.spouse))).hint).toBe("contact_relation:lead_type");
    expect((await refer(lead, referred, types.referral)).rowCount).toBe(1);
    expect((await pgError(refer(lead, referred, types.referral))).code).toMatch(/^(23505|P0001)$/);
    // a row needs exactly one first side
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.contact_relations (organization_id, contact_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4, $5)", [org, referred, lead, referred, types.referral])))).code,
    ).toMatch(/^(23514|P0001)$/);
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.contact_relations (organization_id, related_contact_id, type_id) values ($1, $2, $3)", [org, referred, types.referral])))).code,
    ).toMatch(/^(23514|42501)$/);
    expect(
      (await pgError(asAdmin((q) => q("insert into public.contact_relations (organization_id, related_contact_id, type_id) values ($1, $2, $3)", [org, referred, types.referral])))).code,
    ).toBe("23514");
    // another business's lead
    const boss = await createUser("rel-lead-other");
    const other = await createOrg(boss.id, "עסק ליד זר");
    const theirLead = await insertLead(boss.id, other, { phone: "052-7770002" });
    expect((await pgError(refer(theirLead, referred, types.referral))).code).toMatch(/^(42501|23503)$/);
    // each side's history: the lead's phrase on the lead, the contact's on the contact, ids only
    const entries = (entity: string, id: string) =>
      asAdmin(async (q) =>
        (await q<{ c: Record<string, unknown> }>("select changes as c from public.audit_log where entity_type = $1 and entity_id = $2 and changes ? 'relation'", [entity, id])).rows.map((r) => r.c),
      );
    expect(await entries("leads", lead)).toEqual([{ relation: { old: null, new: "הפנה/תה את" }, related_contact_id: referred }]);
    expect(await entries("contacts", referred)).toEqual([{ relation: { old: null, new: "הופנה/תה על ידי" }, related_lead_id: lead }]);
  });

  it("on conversion the lead's referrals move to its new contact, never one with itself and never twice", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד שהומר", phone: "052-7770011" });
    const [x, y] = [await contact("הופנה 1"), await contact("הופנה 2")];
    const refer = (contactId: string) =>
      asUser(owner.id, (q) =>
        q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, lead, contactId, types.referral]),
      );
    await refer(x);
    await refer(y);
    const result = await asUser(owner.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r);
    const newContact = await asAdmin(async (q) => (await q<{ id: string }>("select converted_contact_id as id from public.leads where id = $1", [lead])).rows[0].id);
    expect(result).toBeTruthy();
    expect(await relationsOf(newContact)).toEqual(
      expect.arrayContaining([
        { a: newContact, b: x, t: types.referral },
        { a: newContact, b: y, t: types.referral },
      ]),
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where lead_id = $1", [lead]))).toBe(0);

    // a relation the new contact would have with itself, or already has, stays behind on the lead
    const lead2 = await insertLead(owner.id, org, { full_name: "ליד שני", phone: "052-7770012" });
    const target = await contact("כבר מקושר");
    const already = await contact("הופנה כבר");
    await asUser(owner.id, async (q) => {
      await q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, lead2, target, types.referral]);
      await q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, lead2, already, types.referral]);
      await q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, target, already, types.referral]);
    });
    // a merge into the existing contact: the lead's converted contact is "target" itself
    await asAdmin((q) => q("update public.leads set converted_contact_id = $2, converted_at = now() where id = $1", [lead2, target]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where lead_id = $1", [lead2]))).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where contact_id = $1", [target]))).toBe(1);
  });

  it("a merge of two leads keeps the duplicate's referrals on the kept lead, once", async () => {
    const [keep, dup] = [
      await insertLead(owner.id, org, { full_name: "ליד נשאר", phone: "052-7770021" }),
      await insertLead(owner.id, org, { full_name: "ליד כפול", phone: "052-7770022" }),
    ];
    const [a, b] = [await contact("הופנתה א"), await contact("הופנתה ב")];
    await asUser(owner.id, async (q) => {
      for (const [l, c] of [[keep, a], [dup, a], [dup, b]]) {
        await q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, l, c, types.referral]);
      }
      await q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]);
    });
    const rows = await asAdmin(async (q) => (await q<{ b: string }>("select related_contact_id as b from public.contact_relations where lead_id = $1 order by related_contact_id", [keep])).rows.map((r) => r.b));
    expect(rows.sort()).toEqual([a, b].sort());
    expect(await asAdmin((q) => count(q, "select 1 from public.contact_relations where lead_id = $1", [dup]))).toBe(0);
  });

  it("a referral keeps a sample lead; undo of one's own import keeps a lead that referred someone after it", async () => {
    const boss = await createUser("rel-lead-sample");
    const sampleOrg = await createOrg(boss.id, "עסק דוגמה לידים");
    await asUser(boss.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    type R = { record_type: string; record_id: string; removable: boolean };
    const records = () => asUser(boss.id, async (q) => (await q<R>("select * from public.sample_data_records($1)", [sampleOrg])).rows);
    const [sampleLead, otherLead] = (await records()).filter((r) => r.record_type === "lead").map((r) => r.record_id);
    const real = await contact("הופנתה באמת", boss, sampleOrg);
    const referral = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'referral'", [sampleOrg])).rows[0].id);
    await asUser(boss.id, (q) => q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [sampleOrg, sampleLead, real, referral]));
    const after = await records();
    expect(after.find((r) => r.record_id === sampleLead)?.removable).toBe(false);
    expect(after.find((r) => r.record_id === otherLead)?.removable).toBe(true);

    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, rep.id, ["import"]]));
    const job = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'l.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const statusId = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and is_default", [org])).rows[0].id);
    const [referrer, quiet] = await asUser(rep.id, async (q) => {
      const ins = async (name: string) =>
        (await q<{ id: string }>("insert into public.leads (organization_id, full_name, status_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, name, statusId, job])).rows[0].id;
      const ids = [await ins("ליד שהפנה"), await ins("ליד שקט")];
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return ids;
    });
    const friend = await contact("הופנה מהייבוא");
    await asUser(owner.id, (q) => q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, referrer, friend, types.referral]));
    const result = await asUser(rep.id, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [org, job])).rows[0].r);
    expect(result).toEqual({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is null", [referrer]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is not null", [quiet]))).toBe(1);
  });

  it("erasing a purged lead leaves nothing of it in the referred contact's history", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד נמחק", phone: "052-7770031" });
    const referred = await contact("נשארת");
    await asUser(owner.id, async (q) => {
      await q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, lead, referred, types.referral]);
      await q("update public.leads set deleted_at = now() where id = $1", [lead]);
      await q("delete from public.leads where id = $1", [lead]);
      await q("select public.audit_erase_record($1, 'leads', $2)", [org, lead]);
    });
    expect(await relationsOf(referred)).toEqual([]);
    const text = await asAdmin(async (q) => (await q<{ t: string }>("select string_agg(changes::text, ' ') as t from public.audit_log where entity_id = $1", [referred])).rows[0].t);
    expect(text).not.toContain("ליד נמחק");
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes::text like '%הפנה/תה את%'", [lead]))).toBe(0);
  });

  it("the referrals report counts a lead as a referrer, and a customer only by a deal won after the referral", async () => {
    const boss = await createUser("rel-report-lead");
    const reportOrg = await createOrg(boss.id, "עסק הפניות לידים");
    const referral = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'referral'", [reportOrg])).rows[0].id);
    const lead = await insertLead(boss.id, reportOrg, { full_name: "ליד מפנה", phone: "052-7770041" });
    const [early, late] = [await contact("קנה לפני", boss, reportOrg), await contact("קנה אחרי", boss, reportOrg)];
    const { pipelineId, stages } = await defaultPipeline(reportOrg);
    const won = stages.find((s) => s.kind === "won")!.id;
    const deal = (contactId: string, amount: number) =>
      asUser(boss.id, (q) =>
        q("insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, contact_id) values ($1, 'מכירה', $2, $3, $4, $5)", [reportOrg, amount, pipelineId, won, contactId]),
      );
    // "early" bought before the referral was recorded: not counted as a customer of it
    await deal(early, 11000);
    await asUser(boss.id, async (q) => {
      for (const c of [early, late]) {
        await q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [reportOrg, lead, c, referral]);
      }
    });
    await deal(late, 22000);
    const r = await asUser(boss.id, async (q) =>
      (await q<{ r: { totals: Record<string, number>; by_referrer: Array<Record<string, unknown>> } }>("select public.report_referrals($1, '2000-01-01', '2100-01-01') as r", [reportOrg])).rows[0].r,
    );
    expect(r.totals).toEqual({ referrals: 2, referrers: 1, customers: 1, won_amount: 22000 });
    expect(r.by_referrer).toEqual([{ referrer_id: lead, referrer_kind: "lead", name: "ליד מפנה", referred: 2, customers: 1, won_amount: 22000 }]);
  });

  it("no client writes the server-only key, and nobody outside the business reads either table", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("update public.contact_relation_types set key = 'referral' where id = $1", [types.spouse])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.contact_relation_types (organization_id, name, key) values ($1, 'x', 'parent')", [org])))).code).toBe("42501");
    const outsider = await createUser("rel-outsider");
    await createOrg(outsider.id, "עסק של זר");
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.contact_relation_types where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.contact_relations where organization_id = $1", [org]))).toBe(0);
  });
});
