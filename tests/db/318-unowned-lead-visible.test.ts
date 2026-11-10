import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

type U = { id: string; email: string };

const staffIds: string[] = [];
afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

/**
 * SPD-01 completion (owner, 9 and 10 November 2026, answers (186)-(190) and (212) ב; migration 021206): an open,
 * unconverted, unbinned lead nobody owns is offered to every active writer of the business (a team's lead to its team
 * and the managers above), but ONLY through public.unowned_lead / unowned_lead_timeline / unowned_leads_waiting /
 * unowned_leads_waiting_count and public.take_lead. The leads_select policy is unchanged, so under 'own' or 'team'
 * visibility the lead stays out of the leads table, global search, reports and import duplicate checks, and nothing is
 * written on it until it is taken.
 */
describe("unowned leads offered to take (SPD-01)", () => {
  let owner: U, manager: U, parentManager: U, m1: U, m2: U, viewer: U, suspended: U, outsider: U, support: U;
  let org: string, otherOrg: string;
  let team: string;
  let free: string, teamed: string, converted: string, closed: string, owned: string, foreign: string;

  const unown = (ids: string[]) => asAdmin((q) => q("update public.leads set owner_id = null, team_id = null where id = any($1)", [ids]));
  const offered = (u: U, o: string, id: string) =>
    asUser(u.id, async (q) => (await q<{ r: { id: string } | null }>("select public.unowned_lead($1, $2) as r", [o, id])).rows[0].r?.id ?? null);
  const waitingIds = (u: U, o: string) =>
    asUser(u.id, async (q) => (await q<{ id: string }>("select id from public.unowned_leads_waiting($1)", [o])).rows.map((r) => r.id));
  const waitingCount = (u: U, o: string) =>
    asUser(u.id, async (q) => (await q<{ n: number }>("select public.unowned_leads_waiting_count($1) as n", [o])).rows[0].n);
  const sees = (u: U, id: string) => asUser(u.id, async (q) => (await count(q, "select 1 from public.leads where id = $1", [id])) === 1);

  beforeAll(async () => {
    owner = await createUser("ulv-owner");
    org = await createOrg(owner.id);
    manager = await addMember(org, owner.id, "manager", "ulv-manager");
    parentManager = await addMember(org, owner.id, "manager", "ulv-parent-manager");
    m1 = await addMember(org, owner.id, "member", "ulv-m1");
    m2 = await addMember(org, owner.id, "member", "ulv-m2");
    viewer = await addMember(org, owner.id, "viewer", "ulv-viewer");
    suspended = await addMember(org, owner.id, "member", "ulv-suspended");
    outsider = await createUser("ulv-outsider");
    otherOrg = await createOrg(outsider.id);
    support = await createUser("ulv-support");
    staffIds.push(support.id);
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]));

    team = await asUser(owner.id, async (q) => {
      const p = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'אזור') returning id", [org])).rows[0].id;
      const t = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צוות דרום', $2) returning id", [org, p])).rows[0].id;
      await q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $5, $6, true)",
        [org, t, manager.id, m1.id, p, parentManager.id],
      );
      return t;
    });

    free = await insertLead(owner.id, org, { full_name: "ליד בלי אחראי", phone: "052-7771234", email: "free-ulv@example.test" });
    teamed = await insertLead(owner.id, org, { full_name: "ליד צוות בלי אחראי" });
    converted = await insertLead(owner.id, org, { full_name: "ליד שהומר" });
    closed = await insertLead(owner.id, org, { full_name: "ליד סגור" });
    owned = await insertLead(m2.id, org, { full_name: "ליד של m2" });
    foreign = await insertLead(outsider.id, otherOrg, { full_name: "ליד של עסק אחר" });
    await unown([free, teamed, converted, closed, foreign]);
    await asAdmin(async (q) => {
      await q("update public.leads set team_id = $1 where id = $2", [team, teamed]);
      await q("update public.leads set converted_at = now() where id = $1", [converted]);
      await q(
        "update public.leads set status_id = (select s.id from public.lead_statuses s where s.organization_id = $1 and s.kind <> 'open' order by s.position limit 1) where id = $2",
        [org, closed],
      );
      await q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]);
      await q("update public.organizations set record_visibility = 'own' where id = any($1)", [[org, otherOrg]]);
    });
  });

  it("the functions are for signed-in members only, definer with a pinned search path", async () => {
    const rows = await asAdmin((q) =>
      q<{ f: string; anon: boolean; auth: boolean; secdef: boolean; config: string[] | null }>(
        `select p.oid::regprocedure::text as f, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth, p.prosecdef as secdef, p.proconfig as config
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('unowned_lead', 'unowned_lead_timeline', 'unowned_leads_waiting', 'unowned_leads_waiting_count')
          order by 1`,
      ),
    );
    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) expect(row, row.f).toMatchObject({ anon: false, auth: true, secdef: true, config: ['search_path=""'] });
    expect((await pgError(asAnon((q) => q("select public.unowned_lead($1, $2)", [org, free])))).code).toBe("42501");
    // the helpers in schema app have no grants at all (only the definers above and take_lead call them)
    const helpers = await asAdmin((q) =>
      q<{ a: boolean; b: boolean; c: boolean }>(
        `select has_function_privilege('authenticated', 'app.unowned_waiting_leads(uuid, integer, boolean)', 'execute') as a,
                has_function_privilege('authenticated', 'app.unowned_lead_visible(uuid, uuid)', 'execute') as b,
                has_function_privilege('authenticated', 'app.unowned_timeline_metadata(jsonb)', 'execute') as c`,
      ),
    );
    expect(helpers.rows[0]).toEqual({ a: false, b: false, c: false });
  });

  it("offered to every writer; a team's lead only to its team and the managers above; never a viewer, a suspended member, an outsider or another business", async () => {
    for (const u of [owner, manager, parentManager, m1, m2]) expect(await offered(u, org, free), u.email).toBe(free);
    // owners and admins are offered every unowned lead
    for (const u of [m1, manager, parentManager, owner]) expect(await offered(u, org, teamed), u.email).toBe(teamed);
    expect(await offered(m2, org, teamed)).toBeNull();
    for (const u of [viewer, suspended, outsider]) {
      expect(await offered(u, org, free), u.email).toBeNull();
      expect(await waitingCount(u, org), u.email).toBe(0);
      expect(await waitingIds(u, org), u.email).toEqual([]);
    }
    // another business's lead, under its own id or claimed under ours
    expect(await offered(m1, org, foreign)).toBeNull();
    expect(await offered(m1, otherOrg, foreign)).toBeNull();
    // converted, closed and owned leads are not offered
    for (const id of [converted, closed, owned]) expect(await offered(m1, org, id), id).toBeNull();
    // the waiting list: unanswered leads, by the same rule
    const m1Waiting = await waitingIds(m1, org);
    expect(m1Waiting).toEqual(expect.arrayContaining([free, teamed]));
    for (const id of [converted, closed, owned, foreign]) expect(m1Waiting).not.toContain(id);
    expect(await waitingIds(m2, org)).not.toContain(teamed);
    expect(await waitingCount(m1, org)).toBe(m1Waiting.length);
  });

  it("a support session is offered nothing", async () => {
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
    await asMfaUser(support.id, async (q) => {
      expect((await q<{ r: unknown }>("select public.unowned_lead($1, $2) as r", [org, free])).rows[0].r).toBeNull();
      expect((await q<{ r: unknown }>("select public.unowned_lead_timeline($1, $2) as r", [org, free])).rows[0].r).toBeNull();
      expect((await q<{ n: number }>("select public.unowned_leads_waiting_count($1) as n", [org])).rows[0].n).toBe(0);
    });
    await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
  });

  it("(212) ב: the old rule holds everywhere else: leads table, global search, reports, import duplicate checks", async () => {
    // m2 reads only their own lead under 'own'
    expect(await sees(m2, free)).toBe(false);
    expect(await sees(m2, owned)).toBe(true);
    await asUser(m2.id, async (q) => {
      const search = (await q<{ r: unknown }>("select public.search_records($1, $2) as r", [org, "ליד בלי אחראי"])).rows[0].r;
      expect(JSON.stringify(search)).not.toContain(free);
      const bySource = (await q<{ r: Array<{ leads: number }> }>("select public.report_leads_by_source($1, now() - interval '1 day', now() + interval '1 day') as r", [org])).rows[0].r;
      expect(bySource.reduce((sum, row) => sum + Number(row.leads), 0)).toBe(1);
      const funnel = (await q<{ r: { leads: { created: number } } }>("select public.report_funnel($1, now() - interval '1 day', now() + interval '1 day') as r", [org])).rows[0].r;
      expect(Number(funnel.leads.created)).toBe(1);
      const dup = await q<{ id: string }>("select id from public.import_find_duplicates($1, 'lead', $2, $3, '{}', '{}')", [org, ["+972527771234"], ["free-ulv@example.test"]]);
      expect(dup.rows.map((r) => r.id)).not.toContain(free);
      // the lead's timeline and files through the tables stay closed too
      expect(await count(q, "select 1 from public.activities where lead_id = $1", [free])).toBe(0);
    });
    // the owner reads it all by the old rule (the same calls are not empty)
    await asUser(owner.id, async (q) => {
      const dup = await q<{ id: string }>("select id from public.import_find_duplicates($1, 'lead', $2, $3, '{}', '{}')", [org, ["+972527771234"], ["free-ulv@example.test"]]);
      expect(dup.rows.map((r) => r.id)).toContain(free);
    });
  });

  it("the timeline: no private note of anyone, files by name only (not on a private note), nothing for a viewer", async () => {
    // a system entry and a private note do not answer the lead
    const shown = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'system', 'נכנס מהטופס', $2) returning id", [org, free])).rows[0].id,
    );
    const privateNote = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'הערה פרטית', $2, true) returning id", [org, free])).rows[0].id,
    );
    await asAdmin(async (q) => {
      await q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'גלוי.pdf', 'application/pdf', 10)", [org, free]);
      await q("insert into public.files (organization_id, lead_id, activity_id, name, mime_type, size_bytes) values ($1, $2, $3, 'פרטי.pdf', 'application/pdf', 10)", [org, free, privateNote]);
      await q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'ulv_doc', 'מסמך', 'file')`,
        [org],
      );
      await q("insert into public.files (organization_id, lead_id, custom_field_key, name, mime_type, size_bytes) values ($1, $2, 'ulv_doc', 'שדה.pdf', 'application/pdf', 10)", [org, free]);
      await q("update public.files set unconfirmed_since = null where lead_id = $1", [free]);
    });
    const timeline = await asUser(m2.id, async (q) =>
      (await q<{ r: { activities: Array<{ id: string; body: string }>; files: Array<Record<string, unknown>> } }>("select public.unowned_lead_timeline($1, $2) as r", [org, free])).rows[0].r,
    );
    expect(timeline.activities.map((a) => a.id)).toContain(shown);
    expect(timeline.activities.map((a) => a.id)).not.toContain(privateNote);
    expect(timeline.files.map((f) => f.name)).toEqual(["גלוי.pdf"]);
    expect(Object.keys(timeline.files[0]).sort()).toEqual(["activity_id", "created_at", "id", "mime_type", "name", "size_bytes"]);
    expect((await asUser(viewer.id, async (q) => (await q<{ r: unknown }>("select public.unowned_lead_timeline($1, $2) as r", [org, free])).rows[0].r))).toBeNull();
    // a person's answer takes the lead off the waiting list and the counter
    const before = await waitingCount(m2, org);
    expect(await waitingIds(m2, org)).toContain(free);
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, free]));
    expect(await waitingIds(m2, org)).not.toContain(free);
    expect(await waitingCount(m2, org)).toBe(before - 1);
    // the page answer carries only the screen's fields
    const lead = await asUser(m2.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.unowned_lead($1, $2) as r", [org, free])).rows[0].r);
    expect(Object.keys(lead).sort()).toEqual(
      ["company_name", "created_at", "email", "full_name", "gender", "id", "last_contacted_at", "message", "original_created_on", "phone", "phone_e164", "source_id", "status_id"].sort(),
    );
  });

  it("(187) ב: nothing is written on an offered lead until it is taken; (186) א take_lead takes it", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד לקחת" });
    await unown([lead]);
    const myContact = await asUser(m2.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'איש קשר של m2') returning id", [org])).rows[0].id,
    );
    const myTask = await asUser(m2.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, contact_id) values ($1, 'משימה של m2', $2) returning id", [org, myContact])).rows[0].id,
    );
    for (const [what, sql] of [
      ["note", "insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)"],
      ["file", "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)"],
      ["follow", "insert into public.record_followers (organization_id, lead_id) values ($1, $2)"],
      ["task", "insert into public.tasks (organization_id, title, lead_id) values ($1, 't', $2)"],
    ] as const) {
      expect((await pgError(asUser(m2.id, (q) => q(sql, [org, lead])))).code, what).toBe("42501");
    }
    expect((await pgError(asUser(m2.id, (q) => q("update public.tasks set lead_id = $2 where id = $1", [myTask, lead])))).code).toBeTruthy();
    expect(await asUser(m2.id, async (q) => (await q("update public.leads set campaign = 'x' where id = $1", [lead])).rowCount)).toBe(0);
    // a viewer and an outsider never take it; a writer does, and then the lead is theirs to work
    expect((await pgError(asUser(viewer.id, (q) => q("select public.take_lead($1, $2)", [org, lead])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.take_lead($1, $2)", [org, lead])))).code).toBe("42501");
    const taken = await asUser(m2.id, async (q) => (await q<{ r: { ok: boolean; result: string } }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r);
    expect(taken).toEqual({ ok: true, result: "taken" });
    expect(await sees(m2, lead)).toBe(true);
    expect(await offered(m2, org, lead)).toBeNull();
    await asUser(m2.id, async (q) => {
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'דיברנו', $2)", [org, lead]);
      await q("update public.tasks set lead_id = $2 where id = $1", [myTask, lead]);
    });
    // a team's lead: a member outside the team cannot take it
    expect((await pgError(asUser(m2.id, (q) => q("select public.take_lead($1, $2)", [org, teamed])))).code).toBe("42501");
  });

  it("the timeline's metadata is an allow-list: a merge's copy of the duplicate and an inquiry's details never leave", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד עם היסטוריה" });
    await unown([lead]);
    const [merged, inquiry, status] = await asAdmin(async (q) => {
      const statusId = (await q<{ id: string }>("select status_id as id from public.leads where id = $1", [lead])).rows[0].id;
      return [
        (await q<{ id: string }>(
          `insert into public.activities (organization_id, type, body, lead_id, metadata) values ($1, 'system', 'מוזג', $2, $3) returning id`,
          [org, lead, JSON.stringify({ kind: "merged", merged: { email: "dup@example.test", phone: "050-9999999", custom_fields: { a: 1 }, utm: { utm_source: "x" }, gclid: "g1", owner_id: owner.id, budget_agorot: 5 } })],
        )).rows[0].id,
        (await q<{ id: string }>(
          `insert into public.activities (organization_id, type, body, lead_id, metadata) values ($1, 'inquiry', null, $2, $3) returning id`,
          [org, lead, JSON.stringify({ form_name: "טופס האתר", full_name: "שם אחר", phone: "050-8888888", email: "other@example.test", attribution: { utm_source: "fb" }, custom_fields: { b: 2 } })],
        )).rows[0].id,
        (await q<{ id: string }>(
          `insert into public.activities (organization_id, type, body, lead_id, metadata) values ($1, 'status_change', null, $2, $3) returning id`,
          [org, lead, JSON.stringify({ from_status_id: statusId, to_status_id: statusId, extra: { nested: true } })],
        )).rows[0].id,
      ];
    });
    const timeline = await asUser(m2.id, async (q) =>
      (await q<{ r: { activities: Array<{ id: string; metadata: Record<string, unknown> }> } }>("select public.unowned_lead_timeline($1, $2) as r", [org, lead])).rows[0].r,
    );
    const meta = (id: string) => timeline.activities.find((a) => a.id === id)!.metadata;
    expect(meta(merged)).toEqual({ kind: "merged" });
    expect(meta(inquiry)).toEqual({ form_name: "טופס האתר" });
    expect(Object.keys(meta(status)).sort()).toEqual(["from_status_id", "to_status_id"]);
    expect(JSON.stringify(timeline)).not.toMatch(/dup@example|050-9999999|050-8888888|other@example|utm_source|gclid|custom_fields/);
  });
});
