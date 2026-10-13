import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMPLETENESS_BUILT_IN, COMPLETENESS_DEFAULTS, COMPLETENESS_TYPES } from "@/features/data-quality/completeness";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type Scored = { id: string; score: number; missing: string[] };
type Incomplete = { total: number; rows: Array<{ id: string; name: string | null; score: number; missing: string[] }> };

/** DQL-01: the important fields per record type, the score and the "to complete" list. */
describe("record completeness", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;

  const setFields = (type: string, fields: string[]) =>
    asUser(owner.id, (q) => q("update public.completeness_settings set fields = $2 where organization_id = $1 and object_type = $3", [org, fields, type]));
  const scoreOf = (userId: string, type: string, ids: string[]) =>
    asUser(userId, async (q) => (await q<{ r: Scored[] }>("select public.record_completeness($1, $2, $3) as r", [org, type, ids])).rows[0].r);
  const incomplete = (userId: string, type: string, ownerId: string, limit = 100) =>
    asUser(userId, async (q) => (await q<{ r: Incomplete }>("select public.incomplete_records($1, $2, $3, $4) as r", [org, type, ownerId, limit])).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("dq-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "dq-member");
  });

  it("the built-in keys and the defaults are the same on both sides", async () => {
    for (const type of COMPLETENESS_TYPES) {
      const row = await asAdmin(async (q) =>
        (await q<{ b: string[]; d: string[] }>("select app.completeness_builtin_keys($1) as b, app.completeness_default_keys($1) as d", [type])).rows[0],
      );
      expect(row.b, type).toEqual(COMPLETENESS_BUILT_IN[type].map((f) => f.key));
      expect(row.d, type).toEqual(COMPLETENESS_DEFAULTS[type]);
      // every default is a built-in key
      expect(row.d.every((k) => row.b.includes(k)), type).toBe(true);
    }
  });

  it("a new organization starts with the defaults, one row per type (managed list)", async () => {
    const rows = await asUser(owner.id, async (q) =>
      (await q<{ object_type: string; fields: string[] }>("select object_type, fields from public.completeness_settings where organization_id = $1 order by object_type", [org])).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.object_type, r.fields]))).toEqual(COMPLETENESS_DEFAULTS);
    // seeding again adds nothing and changes nothing
    await setFields("deal", ["owner_id"]);
    await asAdmin((q) => q("select app.seed_completeness_settings($1)", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.completeness_settings where organization_id = $1", [org]))).toBe(4);
    expect(
      await asAdmin(async (q) => (await q<{ fields: string[] }>("select fields from public.completeness_settings where organization_id = $1 and object_type = 'deal'", [org])).rows[0].fields),
    ).toEqual(["owner_id"]);
    await setFields("deal", COMPLETENESS_DEFAULTS.deal);
  });

  it("refuses a list of the wrong shape and a second row of a type", async () => {
    for (const bad of [["Phone"], ["phone", "phone"], ["cf:"], ["x-y"], Array.from({ length: 41 }, (_, i) => `k${i}`)]) {
      expect((await pgError(setFields("lead", bad))).code, JSON.stringify(bad)).toBe("23514");
    }
    expect((await pgError(asUser(owner.id, (q) => q("update public.completeness_settings set fields = array[null]::text[] where organization_id = $1 and object_type = 'lead'", [org])))).code).toBe("23514");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.completeness_settings (organization_id, object_type) values ($1, 'lead')", [org])))).code).toBe("23505");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.completeness_settings (organization_id, object_type) values ($1, 'task')", [org])))).code).toBe("23514");
  });

  it("scores a lead by the share of its important fields that are filled", async () => {
    const source = await asUser(owner.id, async (q) => (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 limit 1", [org])).rows[0].id);
    // owner_id is set to the creator: one of three
    const lead = await insertLead(owner.id, org, { full_name: "בלי פרטים", phone: null, email: "  " });
    expect(await scoreOf(owner.id, "lead", [lead])).toEqual([{ id: lead, score: 33, missing: ["contact", "source_id"] }]);
    await asUser(owner.id, (q) => q("update public.leads set phone = '050-1234567' where id = $1", [lead]));
    expect((await scoreOf(owner.id, "lead", [lead]))[0]).toMatchObject({ score: 66, missing: ["source_id"] });
    await asUser(owner.id, (q) => q("update public.leads set source_id = $2 where id = $1", [lead, source]));
    expect((await scoreOf(owner.id, "lead", [lead]))[0]).toMatchObject({ score: 100, missing: [] });
    // the computed field the lists sort by gives the same number
    expect(await asUser(owner.id, async (q) => (await q<{ c: number }>("select public.completeness(l) as c from public.leads l where id = $1", [lead])).rows[0].c)).toBe(100);
  });

  it("counts custom fields while they are active, and skips keys it does not know", async () => {
    await asUser(owner.id, (q) =>
      q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'budget', 'תקציב', 'text')", [org]),
    );
    const lead = await insertLead(owner.id, org, { phone: "050-7000000" });
    await setFields("lead", ["cf:budget", "phone", "cf:gone", "not_a_column", "company_name"]);
    expect((await scoreOf(owner.id, "lead", [lead]))[0]).toMatchObject({ score: 33, missing: ["cf:budget", "company_name"] });
    await asUser(owner.id, (q) => q(`update public.leads set custom_fields = '{"$merge": {"budget": "גבוה"}}' where id = $1`, [lead]));
    expect((await scoreOf(owner.id, "lead", [lead]))[0]).toMatchObject({ score: 66, missing: ["company_name"] });
    // a hidden custom field no longer counts at all
    await asUser(owner.id, (q) => q("update public.field_definitions set is_active = false where organization_id = $1 and key = 'budget'", [org]));
    expect((await scoreOf(owner.id, "lead", [lead]))[0]).toMatchObject({ score: 50, missing: ["company_name"] });
    // nothing important: 100
    await setFields("lead", []);
    expect((await scoreOf(owner.id, "lead", [lead]))[0]).toMatchObject({ score: 100, missing: [] });
    await setFields("lead", COMPLETENESS_DEFAULTS.lead);
  });

  it("a deal's amount counts only above zero; contacts and companies use their own fields", async () => {
    const pipe = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id,
    );
    expect((await scoreOf(owner.id, "deal", [deal]))[0]).toMatchObject({ score: 0, missing: ["amount_agorot", "expected_close_date", "contact_id"] });
    await asUser(owner.id, (q) => q("update public.deals set amount_agorot = 100000, expected_close_date = '2026-12-01' where id = $1", [deal]));
    expect((await scoreOf(owner.id, "deal", [deal]))[0]).toMatchObject({ score: 66, missing: ["contact_id"] });

    const company = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name, industry) values ($1, 'חברה', 'retail') returning id", [org])).rows[0].id);
    expect((await scoreOf(owner.id, "company", [company]))[0]).toMatchObject({ score: 50, missing: ["contact"] });
    const contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'דנה', 'dana@example.test') returning id", [org])).rows[0].id);
    expect((await scoreOf(owner.id, "contact", [contact]))[0]).toMatchObject({ score: 50, missing: ["company_id"] });
  });

  it("a contact's further phone or email counts when the primary is empty (a merge can leave it so)", async () => {
    const contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'בלי ראשי') returning id", [org])).rows[0].id);
    await setFields("contact", ["contact", "phone", "email"]);
    expect((await scoreOf(owner.id, "contact", [contact]))[0]).toMatchObject({ score: 0, missing: ["contact", "phone", "email"] });
    await asUser(owner.id, (q) => q("insert into public.contact_channels (organization_id, contact_id, kind, label, value) values ($1, $2, 'phone', 'mobile', '052-7000002')", [org, contact]));
    expect((await scoreOf(owner.id, "contact", [contact]))[0]).toMatchObject({ score: 66, missing: ["email"] });
    // the list sort sees the same
    expect(await asUser(owner.id, async (q) => (await q<{ c: number }>("select public.completeness(c) as c from public.contacts c where id = $1", [contact])).rows[0].c)).toBe(66);
    await setFields("contact", COMPLETENESS_DEFAULTS.contact);
  });

  it("the keys of an organization are given only to its members", async () => {
    const outsider = await createUser("dq-outsider");
    await createOrg(outsider.id);
    expect(await asUser(outsider.id, async (q) => (await q<{ k: string[] | null }>("select app.completeness_keys($1, 'lead') as k", [org])).rows[0].k)).toBeNull();
    expect(await asUser(member.id, async (q) => (await q<{ k: string[] | null }>("select app.completeness_keys($1, 'lead') as k", [org])).rows[0].k)).toEqual(COMPLETENESS_DEFAULTS.lead);
    // the two-step rule of app.membership_role(): an aal1 session of a business that requires it gets nothing
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
    const keysOf = (claims: Record<string, unknown>) =>
      asUser(member.id, async (q) => (await q<{ k: string[] | null }>("select app.completeness_keys($1, 'lead') as k", [org])).rows[0].k, claims);
    expect(await keysOf({ aal: "aal1" })).toBeNull();
    expect(await keysOf({ aal: "aal2" })).toEqual(COMPLETENESS_DEFAULTS.lead);
    await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
    // a person who turned two-step on for their own account: the same rule, in any business
    const guarded = await addMember(org, owner.id, "member", "dq-mfa-member");
    await asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [guarded.id]));
    const guardedKeys = (claims: Record<string, unknown>) =>
      asUser(guarded.id, async (q) => (await q<{ k: string[] | null }>("select app.completeness_keys($1, 'lead') as k", [org])).rows[0].k, claims);
    expect(await guardedKeys({ aal: "aal1" })).toBeNull();
    expect(await guardedKeys({ aal: "aal2" })).toEqual(COMPLETENESS_DEFAULTS.lead);
    // a made-up row of another organization scores as if nothing were important
    const forged = await asUser(outsider.id, async (q) =>
      (await q<{ c: number }>("select public.completeness(jsonb_populate_record(null::public.leads, jsonb_build_object('organization_id', $1::uuid))) as c", [org])).rows,
    );
    expect(forged).toEqual([{ c: 100 }]);
  });

  it("lists a person's live records under 100%, worst first", async () => {
    const empty = await insertLead(member.id, org, { full_name: "ריק", phone: null, email: null });
    const half = await insertLead(member.id, org, { full_name: "חצי", phone: "050-1111111" });
    const converted = await insertLead(member.id, org, { full_name: "הומר", phone: null });
    const trashed = await insertLead(member.id, org, { full_name: "בסל", phone: null });
    await asAdmin(async (q) => {
      await q("update public.leads set converted_at = now() where id = $1", [converted]);
      await q("update public.leads set deleted_at = now() where id = $1", [trashed]);
    });
    const list = await incomplete(member.id, "lead", member.id);
    expect(list.rows.map((r) => r.id)).toEqual([empty, half]);
    expect(list.total).toBe(2);
    expect(list.rows[0]).toMatchObject({ name: "ריק", score: 33, missing: ["contact", "source_id"] });
    // the limit cuts the rows, not the total
    const one = await incomplete(member.id, "lead", member.id, 1);
    expect(one.total).toBe(2);
    expect(one.rows).toHaveLength(1);
    // only open deals
    expect((await incomplete(owner.id, "deal", owner.id)).total).toBe(1);
  });

  it("RLS decides: another organization and a member who may not read the record get nothing", async () => {
    const lead = await insertLead(owner.id, org, { phone: null });
    const stranger = await createUser("dq-stranger");
    await createOrg(stranger.id);
    expect(await asUser(stranger.id, async (q) => (await q<{ r: Scored[] }>("select public.record_completeness($1, 'lead', $2) as r", [org, [lead]])).rows[0].r)).toEqual([]);
    expect((await asUser(stranger.id, async (q) => (await q<{ r: Incomplete }>("select public.incomplete_records($1, 'lead', $2) as r", [org, owner.id])).rows[0].r)).total).toBe(0);
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.completeness_settings where organization_id = $1", [org]))).toBe(0);

    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    expect(await scoreOf(member.id, "lead", [lead])).toEqual([]);
    expect((await incomplete(member.id, "lead", owner.id)).total).toBe(0);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    expect(await scoreOf(member.id, "lead", [lead])).toHaveLength(1);
  });

  it("checks its arguments", async () => {
    for (const sql of [
      "select public.record_completeness($1, 'task', '{}')",
      "select public.incomplete_records($1, 'task', $2)",
      "select public.incomplete_records($1, 'lead', $2, 0)",
      "select public.incomplete_records($1, 'lead', $2, 201)",
      "select public.incomplete_records($1, 'lead', null)",
    ]) {
      const params = sql.includes("$2") ? [org, owner.id] : [org];
      expect((await pgError(asUser(owner.id, (q) => q(sql, params)))).code, sql).toBe("22023");
    }
  });

  it("a change is audited; a read-only business changes nothing", async () => {
    await setFields("company", ["phone"]);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'completeness_settings' and action = 'update'", [org])),
    ).toBeGreaterThan(0);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    expect((await setFields("company", ["city"])).rowCount).toBe(0);
    // reading goes on
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.completeness_settings where organization_id = $1", [org]))).toBe(4);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
  });

  it("a missing type row may be added only by an owner or admin of a writable organization", async () => {
    const fresh = await createOrg(owner.id);
    const freshMember = await addMember(fresh, owner.id, "manager", "dq-fresh-manager");
    const stranger = await createUser("dq-fresh-stranger");
    await createOrg(stranger.id);
    await asAdmin((q) => q("delete from public.completeness_settings where organization_id = $1 and object_type = 'deal'", [fresh]));
    const insert = "insert into public.completeness_settings (organization_id, object_type, fields) values ($1, 'deal', '{owner_id}')";
    for (const u of [freshMember, stranger]) {
      expect((await pgError(asUser(u.id, (q) => q(insert, [fresh])))).code, u.email).toBe("42501");
    }
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [fresh]));
    expect((await pgError(asUser(owner.id, (q) => q(insert, [fresh])))).code).toBe("42501");
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [fresh]));
    await asUser(owner.id, (q) => q(insert, [fresh]));
    expect(await asAdmin((q) => count(q, "select 1 from public.completeness_settings where organization_id = $1", [fresh]))).toBe(4);
  });

  it("clients have no delete grant and no way to write another organization's list", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.completeness_settings where organization_id = $1", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.completeness_settings set organization_id = organization_id where organization_id = $1", [org])))).code).toBe("42501");
  });
});
