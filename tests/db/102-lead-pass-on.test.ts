import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// SPD-03: a lead nobody answered in time goes to the next rep in line (CAP-09's
// rotation: in hours, not on leave), the previous owner and the manager are told,
// at most max_passes times, and never a lead someone took or contacted.
describe("passing a lead on to the next rep (SPD-03)", () => {
  let owner: U, manager: U, rep1: U, rep2: U, rep3: U, outsider: U;
  let org: string;
  let team: string;
  let token: string;

  const setFeature = (on: boolean) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object('auto_reassign', $2::boolean) where organization_id = $1", [org, on]),
    );
  const setSettings = (action: string, maxPasses = 2) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.lead_response_settings (organization_id, breach_action, max_passes) values ($1, $2, $3)
         on conflict (organization_id) do update set breach_action = excluded.breach_action, max_passes = excluded.max_passes`,
        [org, action, maxPasses],
      ),
    );
  const submit = (phone: string) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [token, JSON.stringify({ full_name: "פונה ממתין", phone })])).rows[0].r.lead_id);
  const age = (lead: string, minutes = 61) =>
    asAdmin((q) => q("update app.lead_response_checks set window_start = now() - make_interval(mins => $2), next_check_at = now() where lead_id = $1", [lead, minutes]));
  const run = () =>
    asAdmin(async (q) => {
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> $1", [org]);
      return (await q<{ n: number }>("select app.check_lead_responses() as n")).rows[0].n;
    });
  const ownerOf = (lead: string) => asAdmin(async (q) => (await q<{ o: string | null }>("select owner_id as o from public.leads where id = $1", [lead])).rows[0].o);
  const check = (lead: string) =>
    asAdmin(async (q) => (await q<{ outcome: string | null; resolved: boolean; passes: number; passed_from: string[] }>("select outcome, resolved_at is not null as resolved, passes, passed_from from app.lead_response_checks where lead_id = $1", [lead])).rows[0]);
  const notices = (lead: string) =>
    asAdmin(async (q) => (await q<{ user_id: string; type: string; title: string }>("select user_id, type, title from public.notifications where entity_id = $1 and type in ('response_overdue', 'assigned') order by created_at, user_id", [lead])).rows);
  const pointer = (user: U) =>
    asAdmin(async (q) => (await q<{ t: Date | null }>("select last_lead_assigned_at as t from public.memberships where organization_id = $1 and user_id = $2", [org, user.id])).rows[0].t?.toISOString() ?? null);
  const setAvailable = (user: U, on: boolean) =>
    asAdmin((q) => q("update public.memberships set is_available = $3 where organization_id = $1 and user_id = $2", [org, user.id, on]));
  // the rotation order: rep1 first, then rep2, then rep3
  const order = (users: U[]) =>
    asAdmin(async (q) => {
      for (const [i, user] of users.entries()) {
        await q("update public.memberships set last_lead_assigned_at = now() - make_interval(hours => $3) where organization_id = $1 and user_id = $2", [org, user.id, 10 - i]);
      }
    });

  beforeAll(async () => {
    owner = await createUser("po-owner");
    org = await createOrg(owner.id, "עסק ההעברות");
    manager = await addMember(org, owner.id, "manager", "po-manager");
    rep1 = await addMember(org, owner.id, "member", "po-rep1");
    rep2 = await addMember(org, owner.id, "member", "po-rep2");
    rep3 = await addMember(org, owner.id, "member", "po-rep3");
    outsider = await createUser("po-outsider");
    await createOrg(outsider.id, "עסק אחר");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'team' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      await q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest) values ($1, '{}', false)", [org]);
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      await q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false), ($1, $2, $6, false)",
        [org, team, manager.id, rep1.id, rep2.id, rep3.id],
      );
      // a fixed owner: the passes go round the team's rotation
      token = (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, team_id) values ($1, 'webhook', 'אתר', $2, $3) returning token", [org, rep1.id, team])).rows[0].token;
    });
    // the manager takes no leads
    await setAvailable(manager, false);
  });

  beforeEach(async () => {
    await setFeature(true);
    await setSettings("pass_on", 2);
    await order([rep1, rep2, rep3]);
  });

  it("the setting: pass_on needs the plan flag; 1 to 5 passes", async () => {
    await setFeature(false);
    await setSettings("notify");
    const refused = await pgError(setSettings("pass_on"));
    expect(refused.hint).toBe("feature:auto_reassign");
    // a business whose plan lost the flag can still change other columns
    await setFeature(true);
    await setSettings("pass_on");
    await setFeature(false);
    await asUser(owner.id, (q) => q("update public.lead_response_settings set target_minutes = 45 where organization_id = $1", [org]));
    await setFeature(true);
    await asUser(owner.id, (q) => q("update public.lead_response_settings set target_minutes = 60 where organization_id = $1", [org]));
    for (const passes of [0, 6]) {
      expect((await pgError(setSettings("pass_on", passes))).code).toBe("23514");
    }
    // members cannot change it
    expect(await asUser(rep1.id, async (q) => (await q("update public.lead_response_settings set max_passes = 5 where organization_id = $1", [org])).rowCount)).toBe(0);
  });

  it("not answered in time: the lead goes to the next rep; the new owner, the previous owner and the manager are told", async () => {
    const lead = await submit("055-7200001");
    expect(await ownerOf(lead)).toBe(rep1.id);
    const rep3Turn = await pointer(rep3);
    const rep1Turn = await pointer(rep1);
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep2.id);
    const told = await notices(lead);
    expect(told).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: rep2.id, type: "assigned" }),
        expect.objectContaining({ user_id: rep1.id, type: "response_overdue", title: "ליד הועבר לנציג אחר" }),
        expect.objectContaining({ user_id: manager.id, type: "response_overdue", title: "ליד לא נענה בתוך 60 דקות והועבר" }),
      ]),
    );
    expect(told.length).toBe(3);
    // one system entry in the timeline, which is not contact
    const entries = await asAdmin(
      async (q) => (await q<{ type: string; body: string; created_by: string | null; metadata: Record<string, unknown> }>("select type, body, created_by, metadata from public.activities where lead_id = $1", [lead])).rows,
    );
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ type: "system", created_by: null, metadata: { kind: "response_pass", from_user_id: rep1.id, to_user_id: rep2.id, pass: 1 } });
    expect(entries[0].body).toContain("לא נוצר קשר בתוך 60 דקות");
    // the previous owner's turn in the rotation was not used; rep3 untouched
    expect(await pointer(rep1)).toBe(rep1Turn);
    expect(await pointer(rep3)).toBe(rep3Turn);
    expect(await check(lead)).toMatchObject({ resolved: false, passes: 1, passed_from: [rep1.id] });
    // rep2's clock just started: nothing more now
    expect(await run()).toBe(0);
  });

  it("the lead's open call-back task follows it to the new owner, silently; other tasks stay", async () => {
    const lead = await submit("055-7200009");
    // SPD-05's call task as intake_submit makes it: owned by the lead's owner, marked in app.intake_callback_tasks
    const [callTask, doneCall, ownTask] = await asAdmin(async (q) => {
      const make = async (title: string, status: string, marked: boolean) => {
        const id = (await q<{ id: string }>("insert into public.tasks (organization_id, title, lead_id, owner_id, status) values ($1, $2, $3, $4, $5) returning id", [org, title, lead, rep1.id, status])).rows[0].id;
        if (marked) await q("insert into app.intake_callback_tasks (task_id, organization_id, lead_id) values ($1, $2, $3)", [id, org, lead]);
        return id;
      };
      return [await make("להתקשר", "open", true), await make("שיחה שהתקיימה", "done", true), await make("משימה של רון", "open", false)];
    });
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep2.id);
    const owners = await asAdmin(
      async (q) => Object.fromEntries((await q<{ id: string; owner_id: string }>("select id, owner_id from public.tasks where lead_id = $1", [lead])).rows.map((r) => [r.id, r.owner_id])),
    );
    expect(owners[callTask]).toBe(rep2.id);
    expect(owners[doneCall]).toBe(rep1.id);
    expect(owners[ownTask]).toBe(rep1.id);
    // no notification about the task: rep2 hears of the lead only ('assigned' on the lead)
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and user_id = $2", [callTask, rep2.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and organization_id = $2 and entity_type = 'task'", [rep2.id, org]))).toBe(0);
    expect((await notices(lead)).filter((n) => n.user_id === rep2.id).map((n) => n.type)).toEqual(["assigned"]);
  });

  it("never back to someone it was taken from; after the last pass only the manager is told", async () => {
    const lead = await submit("055-7200002");
    await age(lead);
    await run();
    expect(await ownerOf(lead)).toBe(rep2.id);
    // rep1 is next in the rotation now, but already had this lead
    await order([rep1, rep2, rep3]);
    const rep1Turn = await pointer(rep1);
    await age(lead);
    await run();
    expect(await ownerOf(lead)).toBe(rep3.id);
    expect(await pointer(rep1)).toBe(rep1Turn);
    expect(await check(lead)).toMatchObject({ passes: 2, passed_from: [rep1.id, rep2.id] });
    // two passes used: the third time only the manager hears of it
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep3.id);
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "notified", passes: 2 });
    const last = (await notices(lead)).filter((n) => n.title.startsWith("ליד מחכה למענה"));
    expect(last.map((n) => n.user_id)).toEqual([manager.id]);
  });

  it("a lead someone took is never moved; the manager is told instead", async () => {
    const lead = await submit("055-7200003");
    const taken = await asUser(rep1.id, async (q) => (await q<{ r: { ok: boolean } }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r);
    expect(taken.ok).toBe(true);
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep1.id);
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "notified", passes: 0 });
    expect((await notices(lead)).map((n) => n.user_id)).toEqual([manager.id]);
  });

  it("a contacted lead is never moved", async () => {
    const lead = await submit("055-7200004");
    await asUser(rep1.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'whatsapp', 'שלחתי', $2)", [org, lead]));
    await age(lead);
    expect(await run()).toBe(0);
    expect(await ownerOf(lead)).toBe(rep1.id);
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "contacted" });
  });

  it("nobody else available or in hours: the manager is told, the lead stays", async () => {
    const lead = await submit("055-7200005");
    await setAvailable(rep2, false);
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date - 1, current_date + 1)", [org, rep3.id]));
    try {
      await age(lead);
      expect(await run()).toBe(1);
      expect(await ownerOf(lead)).toBe(rep1.id);
      expect(await check(lead)).toMatchObject({ resolved: true, outcome: "notified", passes: 0 });
    } finally {
      await setAvailable(rep2, true);
      await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01' where organization_id = $1", [org]));
    }
  });

  it("the plan lost the flag: the job only notifies", async () => {
    const lead = await submit("055-7200006");
    await setFeature(false);
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep1.id);
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "notified" });
  });

  it("a lead locked by a handover at that moment is looked at a minute later", async () => {
    const lead = await submit("055-7200007");
    await age(lead);
    // another session holds the lead row while the job runs
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.leads where id = $1 for update", [lead]);
      expect(await run()).toBe(0);
      expect(await ownerOf(lead)).toBe(rep1.id);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    const next = await asAdmin(async (q) => (await q<{ later: boolean }>("select next_check_at > now() as later from app.lead_response_checks where lead_id = $1", [lead])).rows[0].later);
    expect(next).toBe(true);
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep2.id);
  });

  it("a read-only organization is left alone", async () => {
    const lead = await submit("055-7200008");
    await age(lead);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await run()).toBe(0);
      expect(await ownerOf(lead)).toBe(rep1.id);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and type = 'response_overdue'", [lead]))).toBe(0);
  });
  it("tied turns in one run: a rep who was already tried is not picked again (review L2)", async () => {
    const lead = await submit("055-7200010");
    await age(lead);
    // rep2 already had it; everyone's turn is this transaction's now(), rep1 joined first
    const owner = await asAdmin(async (q) => {
      await q("update app.lead_response_checks set passed_from = array[$2::uuid], passes = 1 where lead_id = $1", [lead, rep2.id]);
      await q("update public.memberships set last_lead_assigned_at = now() where organization_id = $1 and user_id = any ($2::uuid[])", [org, [rep1.id, rep2.id, rep3.id]]);
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> $1", [org]);
      await q("select app.check_lead_responses()");
      const now = (await q<{ t: Date }>("select now() as t")).rows[0].t.toISOString();
      const turns = (await q<{ user_id: string; t: Date }>("select user_id, last_lead_assigned_at as t from public.memberships where organization_id = $1 and user_id = any ($2::uuid[])", [org, [rep1.id, rep2.id]])).rows;
      // the two who were skipped got their turn back
      expect(turns.map((r) => r.t.toISOString())).toEqual([now, now]);
      return (await q<{ o: string }>("select owner_id as o from public.leads where id = $1", [lead])).rows[0].o;
    });
    expect(owner).toBe(rep3.id);
  });

  it("re-running the CAP-10 migration and then this one keeps passing on (review L5)", async () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith("_response_target.sql") || f.endsWith("_lead_pass_on.sql")).sort();
    expect(files.length).toBe(2);
    await asAdmin(async (q) => {
      // the CAP-10 file alone keeps the widened check
      await q(readFileSync(join(dir, files[0]), "utf8"));
      const check = (await q<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'lead_response_settings_action_check'")).rows[0].d;
      expect(check).toContain("pass_on");
      await q(readFileSync(join(dir, files[1]), "utf8"));
      // the later migrations that redefine the job run again too (HEB-08), so no later test sees an old body
      const later = readdirSync(dir)
        .filter((f) => f.endsWith(".sql") && f > files[1])
        .sort()
        .map((f) => readFileSync(join(dir, f), "utf8"))
        .filter((sql) => /function\s+app\.check_lead_responses\s*\(/.test(sql));
      for (const sql of later) await q(sql);
    });
    await setSettings("pass_on", 2);
    const lead = await submit("055-7200011");
    await age(lead);
    expect(await run()).toBe(1);
    expect(await ownerOf(lead)).toBe(rep2.id);
  });
});

// Review H1 and L7, in a business of its own: the plan check tells outsiders and
// members nothing; a new owner who is also the only fallback manager gets 'assigned' only.
describe("passing on: plan check and the fallback manager (SPD-03)", () => {
  let boss: U, rep: U, stranger: U;
  let org: string;
  let token: string;

  beforeAll(async () => {
    boss = await createUser("po2-owner");
    org = await createOrg(boss.id, "עסק קטן");
    rep = await addMember(org, boss.id, "member", "po2-rep");
    stranger = await createUser("po2-stranger");
    await createOrg(stranger.id, "עסק זר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"auto_reassign\": false}' where organization_id = $1", [org]));
    token = await asUser(boss.id, async (q) => {
      await q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest) values ($1, '{}', false)", [org]);
      return (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id) values ($1, 'webhook', 'אתר', $2) returning token", [org, rep.id])).rows[0].token;
    });
  });

  it("an outsider or a member choosing pass_on gets the plain 42501, never the plan hint", async () => {
    const insert = "insert into public.lead_response_settings (organization_id, breach_action) values ($1, 'pass_on')";
    for (const user of [stranger, rep]) {
      const error = await pgError(asUser(user.id, (q) => q(insert, [org])));
      expect(error.code, user.email).toBe("42501");
      expect(error.hint ?? null, user.email).toBeNull();
    }
    // the owner is told about the plan
    expect((await pgError(asUser(boss.id, (q) => q(insert, [org])))).hint).toBe("feature:auto_reassign");
    await asUser(boss.id, (q) => q("insert into public.lead_response_settings (organization_id, breach_action) values ($1, 'notify')", [org]));
    // updates by others reach no row, so no trigger and no hint
    for (const user of [stranger, rep]) {
      expect(await asUser(user.id, async (q) => (await q("update public.lead_response_settings set breach_action = 'pass_on' where organization_id = $1", [org])).rowCount), user.email).toBe(0);
    }
  });

  it("the new owner is the only fallback manager: 'assigned' only, no overdue notice", async () => {
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"auto_reassign\": true}' where organization_id = $1", [org]));
    await asUser(boss.id, (q) => q("update public.lead_response_settings set breach_action = 'pass_on' where organization_id = $1", [org]));
    const lead = await asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [token, JSON.stringify({ full_name: "פונה", phone: "055-7300001" })])).rows[0].r.lead_id);
    await asAdmin((q) => q("update app.lead_response_checks set window_start = now() - interval '61 minutes', next_check_at = now() where lead_id = $1", [lead]));
    const n = await asAdmin(async (q) => {
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> $1", [org]);
      return (await q<{ n: number }>("select app.check_lead_responses() as n")).rows[0].n;
    });
    expect(n).toBe(1);
    const told = await asAdmin(
      async (q) => (await q<{ user_id: string; type: string }>("select user_id, type from public.notifications where entity_id = $1 and type in ('assigned', 'response_overdue') order by user_id", [lead])).rows,
    );
    expect(await asAdmin(async (q) => (await q<{ o: string }>("select owner_id as o from public.leads where id = $1", [lead])).rows[0].o)).toBe(boss.id);
    expect(told.filter((t) => t.user_id === boss.id).map((t) => t.type)).toEqual(["assigned"]);
    expect(told.filter((t) => t.user_id === rep.id).map((t) => t.type)).toEqual(["response_overdue"]);
  });
});
