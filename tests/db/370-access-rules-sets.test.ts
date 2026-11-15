import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, defaultLeadStatus, defaultPipeline } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * OPS-09 (migration 021280): the select policies of leads, contacts, companies, deals and tasks ask app.can_read_record()'s
 * rule as sets judged once per statement (app.my_record_orgs, app.my_read_teams), and profiles asks app.shares_org() as a
 * set (app.my_shared_users). The answer must not change. For every person below, in every visibility mode, the rows the
 * new policies return are compared with the OLD rule evaluated row by row (app.can_read_record, app.is_member,
 * app.team_task_visible, app.deputy_readable, app.shares_org) under the same claims: owner, admin, a manager of a parent
 * team, a manager of nothing, members in one, two or no teams, a viewer, a suspended member, a deputy of an absent member,
 * a person with a verified second factor signed in with and without it, a support session, a business that requires the
 * second factor, and a closed business (its owner keeps the role, a member loses it).
 */
const TABLES = [
  { t: "leads", type: "lead" },
  { t: "contacts", type: "contact" },
  { t: "companies", type: "company" },
  { t: "deals", type: "deal" },
  { t: "tasks", type: "task" },
] as const;


// The SQL bodies the helpers had before 021280 (0014, 0171, 0013, 020075, 0001), as temporary functions calling each other
const OLD_HELPERS = `
create or replace function pg_temp.old_session_aal() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') $$;
create or replace function pg_temp.old_has_verified_factor() returns boolean language sql stable as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified') $$;
create or replace function pg_temp.old_membership_role(p_org uuid) returns public.membership_role language sql stable as $$
  select m.role from public.memberships m
    join public.organizations o on o.id = m.organization_id
   where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active'
     and (pg_temp.old_session_aal() = 'aal2' or (not o.require_mfa and not pg_temp.old_has_verified_factor()))
     and (m.role = 'owner' or not app.org_status_closed(o.status)) $$;
create or replace function pg_temp.old_platform_role() returns text language sql stable as $$
  select s.role from app.platform_staff s
   where s.user_id = auth.uid() and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') = 'aal2' $$;
create or replace function pg_temp.old_support_session(p_org uuid) returns boolean language sql stable as $$
  select coalesce(pg_temp.old_platform_role() in ('owner', 'support'), false)
     and exists (select 1 from app.support_sessions s
                   join public.support_access_grants g on g.organization_id = s.organization_id and g.id = s.grant_id
                  where s.organization_id = p_org and s.staff_user_id = auth.uid()
                    and g.revoked_at is null and g.expires_at > now()) $$;
create or replace function pg_temp.old_role_in(p_org uuid) returns public.membership_role language sql stable as $$
  select coalesce(pg_temp.old_membership_role(p_org),
                  case when pg_temp.old_support_session(p_org) then 'viewer'::public.membership_role end) $$;
create or replace function pg_temp.old_in_team(p_team uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.team_members tm where tm.team_id = p_team and tm.user_id = auth.uid()) $$;
create or replace function pg_temp.old_manages_team(p_team uuid) returns boolean language sql stable as $$
  with recursive chain as (
    select t.id, t.parent_team_id, 1 as depth from public.teams t where t.id = p_team
    union all
    select t.id, t.parent_team_id, c.depth + 1 from public.teams t join chain c on t.id = c.parent_team_id where c.depth < 10
  )
  select exists (select 1 from chain c join public.team_members tm on tm.team_id = c.id where tm.user_id = auth.uid() and tm.is_manager) $$;
`;

function oldRule(t: string, type: string): string {
  const base = `app.can_read_record(organization_id, owner_id, team_id)
    or (organization_id, id) in (select r.organization_id, r.id from app.deputy_readable('${type}') r)`;
  if (t !== "tasks") return base;
  return `${base}
    or (created_by = auth.uid() and app.is_member(organization_id))
    or app.team_task_visible(organization_id, id, owner_id, team_id, status, deleted_at)`;
}

describe("access rules as sets give the same rows (OPS-09)", () => {
  let owner: U, admin: U, parentManager: U, idleManager: U, member: U, twoTeams: U, noTeam: U, viewer: U, suspended: U;
  let absent: U, deputy: U, former: U, factor: U, staff: U, mfaOwner: U, mfaMember: U, closedOwner: U, closedMember: U;
  let org: string, mfaOrg: string, closedOrg: string;
  const orgs: string[] = [];
  const people: U[] = [];

  beforeAll(async () => {
    owner = await createUser("o9-owner");
    org = await createOrg(owner.id, "עסק גישה");
    admin = await addMember(org, owner.id, "admin", "o9-admin");
    parentManager = await addMember(org, owner.id, "manager", "o9-pmgr");
    idleManager = await addMember(org, owner.id, "manager", "o9-imgr");
    member = await addMember(org, owner.id, "member", "o9-member");
    twoTeams = await addMember(org, owner.id, "member", "o9-two");
    noTeam = await addMember(org, owner.id, "member", "o9-noteam");
    viewer = await addMember(org, owner.id, "viewer", "o9-viewer");
    suspended = await addMember(org, owner.id, "member", "o9-susp");
    absent = await addMember(org, owner.id, "member", "o9-absent");
    deputy = await addMember(org, owner.id, "member", "o9-deputy");
    factor = await addMember(org, owner.id, "member", "o9-factor");
    staff = await createUser("o9-staff");
    // a former employee: owns records, shares no business with anyone (the owner sort shows no name for them)
    former = await createUser("o9-former");

    mfaOwner = await createUser("o9-mfa-owner");
    mfaOrg = await createOrg(mfaOwner.id, "עסק דו-שלבי");
    mfaMember = await addMember(mfaOrg, mfaOwner.id, "member", "o9-mfa-member");
    closedOwner = await createUser("o9-closed-owner");
    closedOrg = await createOrg(closedOwner.id, "עסק סגור");
    closedMember = await addMember(closedOrg, closedOwner.id, "member", "o9-closed-member");
    orgs.push(org, mfaOrg, closedOrg);
    people.push(former, owner, admin, parentManager, idleManager, member, twoTeams, noTeam, viewer, suspended, absent, deputy, factor,
      staff, mfaOwner, mfaMember, closedOwner, closedMember);

    await asAdmin(async (q) => {
      // teams: P (parent) > C1, C2; T3 alone
      const team = async (name: string, parent: string | null) =>
        (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, $2, $3) returning id", [org, name, parent])).rows[0].id;
      const p = await team("P", null);
      const c1 = await team("C1", p);
      const c2 = await team("C2", p);
      const t3 = await team("T3", null);
      const tm = (team: string, user: string, mgr = false) =>
        q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, $4)", [org, team, user, mgr]);
      await tm(p, parentManager.id, true);
      await tm(c2, idleManager.id);
      await tm(c1, member.id);
      await tm(c1, twoTeams.id);
      await tm(t3, twoTeams.id);
      await tm(c1, viewer.id);
      await tm(c1, suspended.id);
      await tm(c2, absent.id);
      await tm(c2, deputy.id);
      await tm(c1, factor.id);
      const mfaTeam = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'M') returning id", [mfaOrg])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [mfaOrg, mfaTeam, mfaMember.id]);

      // records of every owner and team combination, triggers set aside (server data)
      await q("set local session_replication_role = replica");
      const owners = [owner, admin, parentManager, idleManager, member, twoTeams, noTeam, viewer, suspended, absent, deputy, factor, former]
        .map((u) => u.id).concat([null as unknown as string]);
      const teams = [p, c1, c2, t3, null];
      const status = await defaultLeadStatus(org);
      const pipe = await defaultPipeline(org);
      const stage = pipe.stages.find((s) => s.kind === "open")!.id;
      let n = 0;
      for (const o of owners) {
        for (const t of teams) {
          n += 1;
          await q("insert into public.leads (organization_id, status_id, full_name, owner_id, team_id) values ($1, $2, $3, $4, $5)", [org, status, `ל${n}`, o, t]);
          await q("insert into public.contacts (organization_id, first_name, owner_id, team_id) values ($1, $2, $3, $4)", [org, `א${n}`, o, t]);
          await q("insert into public.companies (organization_id, name, owner_id, team_id) values ($1, $2, $3, $4)", [org, `ח${n}`, o, t]);
          await q("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, team_id) values ($1, $2, $3, $4, $5, $6)",
            [org, `ע${n}`, pipe.pipelineId, stage, o, t]);
          for (const st of ["open", "done"]) {
            for (const creator of [member.id, owner.id]) {
              await q("insert into public.tasks (organization_id, title, owner_id, team_id, status, created_by) values ($1, $2, $3, $4, $5, $6)",
                [org, `מ${n}`, o, t, st, creator]);
            }
          }
        }
      }
      // a team task in the bin, and one marked as an intake call-back task
      await q("insert into public.tasks (organization_id, title, team_id, status, deleted_at) values ($1, 'בסל', $2, 'open', now())", [org, c1]);
      const cb = (await q<{ id: string }>("insert into public.tasks (organization_id, title, team_id, status) values ($1, 'שיחה', $2, 'open') returning id", [org, c1])).rows[0].id;
      await q(
        "insert into app.intake_callback_tasks (organization_id, task_id, lead_id) select $1, $2, id from public.leads where organization_id = $1 limit 1",
        [org, cb],
      );
      // the absent member's open tasks on records only they read (HEB-08)
      const own = (t: string) => q<{ id: string }>(`select id from public.${t} where organization_id = $1 and owner_id = $2 and team_id is null limit 1`, [org, absent.id]);
      const lead = (await own("leads")).rows[0].id;
      const contact = (await own("contacts")).rows[0].id;
      const company = (await own("companies")).rows[0].id;
      const deal = (await own("deals")).rows[0].id;
      await q("insert into public.tasks (organization_id, title, owner_id, status, lead_id, contact_id, company_id, deal_id) values ($1, 'היעדרות', $2, 'open', $3, $4, $5, $6)",
        [org, absent.id, lead, contact, company, deal]);
      // the other two businesses
      const mstatus = await defaultLeadStatus(mfaOrg);
      await q("insert into public.leads (organization_id, status_id, full_name, owner_id, team_id) values ($1, $2, 'א', $3, $4), ($1, $2, 'ב', $5, null)",
        [mfaOrg, mstatus, mfaMember.id, mfaTeam, mfaOwner.id]);
      const cstatus = await defaultLeadStatus(closedOrg);
      await q("insert into public.leads (organization_id, status_id, full_name, owner_id) values ($1, $2, 'א', $3), ($1, $2, 'ב', $4)",
        [closedOrg, cstatus, closedMember.id, closedOwner.id]);
      await q("set local session_replication_role = origin");

      await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date - 1, current_date + 3, 'vacation', $3)",
        [org, absent.id, deputy.id]);
      await q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]);
      await q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [factor.id]);
      await q("update public.organizations set require_mfa = true where id = $1", [mfaOrg]);
      await q("update public.organizations set status = 'suspended' where id = $1", [closedOrg]);
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support')", [staff.id]);
      await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '2 hours')", [org]);
    });
    await asMfaUser(staff.id, (q) => q("select public.platform_open_support($1)", [org]));
  });

  afterAll(async () => {
    await asAdmin((q) => q("delete from app.platform_staff where user_id = $1", [staff.id]));
  });

  type Case = [string, () => U, Record<string, unknown>];
  const cases: Case[] = [
    ["owner", () => owner, {}],
    ["admin", () => admin, {}],
    ["manager of a parent team", () => parentManager, {}],
    ["manager of no team", () => idleManager, {}],
    ["member", () => member, {}],
    ["member of two teams", () => twoTeams, {}],
    ["member without a team", () => noTeam, {}],
    ["viewer", () => viewer, {}],
    ["suspended member", () => suspended, {}],
    ["absent member", () => absent, {}],
    ["deputy", () => deputy, {}],
    ["verified factor, first step only", () => factor, { aal: "aal1" }],
    ["verified factor, both steps", () => factor, { aal: "aal2" }],
    ["support session", () => staff, { aal: "aal2" }],
    ["support staff without the second step", () => staff, { aal: "aal1" }],
    ["owner of a business requiring the second step, first step only", () => mfaOwner, {}],
    ["member of a business requiring the second step, both steps", () => mfaMember, { aal: "aal2" }],
    ["owner of a closed business", () => closedOwner, {}],
    ["member of a closed business", () => closedMember, {}],
  ];

  async function compare(user: U, claims: Record<string, unknown>) {
    const out: Record<string, number> = {};
    for (const { t, type } of TABLES) {
      const viaPolicy = await asUser(user.id, async (q) =>
        (await q<{ ids: string[] | null }>(`select array_agg(id order by id) as ids from public.${t} where organization_id = any($1)`, [orgs])).rows[0].ids ?? [],
        claims);
      const viaOldRule = await asAdmin(async (q) => {
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id, role: "authenticated", ...claims })]);
        return (await q<{ ids: string[] | null }>(
          `select array_agg(id order by id) as ids from public.${t} where organization_id = any($1) and (${oldRule(t, type)})`, [orgs])).rows[0].ids ?? [];
      });
      expect(viaPolicy, `${t}`).toEqual(viaOldRule);
      // the owner sort shows the name the old body (a read of profiles under the caller's rights) showed
      const sortDiff = await asUser(user.id, async (q) =>
        (await q<{ n: string; named: string }>(
          `select count(*) filter (where public.sort_owner(x) is distinct from
                    (select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = x.owner_id)) as n,
                  count(public.sort_owner(x)) as named
             from public.${t} x where organization_id = any($1)`, [orgs])).rows[0],
        claims);
      expect(Number(sortDiff.n), `${t} sort_owner`).toBe(0);
      out[`${t}_named`] = Number(sortDiff.named);
      out[t] = viaPolicy.length;
    }
    // the helpers rewritten as plpgsql answer as their old SQL bodies, for every business and team
    const helperDiff = await asAdmin(async (q) => {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id, role: "authenticated", ...claims })]);
      await q(OLD_HELPERS);
      return (await q<{ what: string }>(
        `select 'org ' || o.id as what from public.organizations o where o.id = any($1) and (
             app.membership_role(o.id) is distinct from pg_temp.old_membership_role(o.id)
          or app.role_in(o.id) is distinct from pg_temp.old_role_in(o.id)
          or app.is_member(o.id) is distinct from (pg_temp.old_role_in(o.id) is not null)
          or app.support_session(o.id) is distinct from pg_temp.old_support_session(o.id))
         union all
         select 'team ' || t.id from public.teams t where t.organization_id = any($1) and (
             app.in_team(t.id) is distinct from pg_temp.old_in_team(t.id)
          or app.manages_team(t.id) is distinct from pg_temp.old_manages_team(t.id))
         union all
         select 'session' where app.session_aal() is distinct from pg_temp.old_session_aal()
            or app.has_verified_factor() is distinct from pg_temp.old_has_verified_factor()
            or app.platform_role() is distinct from pg_temp.old_platform_role()`, [orgs])).rows.map((r) => r.what);
    });
    expect(helperDiff).toEqual([]);
    const profilesPolicy = await asUser(user.id, async (q) =>
      (await q<{ ids: string[] | null }>("select array_agg(id order by id) as ids from public.profiles where id = any($1)", [people.map((p) => p.id)])).rows[0].ids ?? [],
      claims);
    const profilesOld = await asAdmin(async (q) => {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id, role: "authenticated", ...claims })]);
      return (await q<{ ids: string[] | null }>(
        "select array_agg(id order by id) as ids from public.profiles where id = any($1) and (id = auth.uid() or (app.shares_org(id) and app.session_verified()))",
        [people.map((p) => p.id)])).rows[0].ids ?? [];
    });
    expect(profilesPolicy, "profiles").toEqual(profilesOld);
    out.profiles = profilesPolicy.length;
    return out;
  }

  for (const visibility of ["team", "own", "org"] as const) {
    describe(`visibility ${visibility}`, () => {
      beforeAll(async () => {
        await asAdmin((q) => q("update public.organizations set record_visibility = $2 where id = any($1)", [orgs, visibility]));
      });
      it.each(cases)("%s: the same rows as app.can_read_record()", async (_label, who, claims) => {
        const counts = await compare(who(), claims);
        expect(Object.keys(counts)).toHaveLength(11);
      });
    });
  }

  it("the fixture tells the rules apart (some see everything, some part, some nothing)", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'team' where id = any($1)", [orgs]));
    const all = (await compare(owner, {})).leads;
    const part = (await compare(member, {})).leads;
    const none = (await compare(suspended, {})).leads;
    const deputyLeads = (await compare(deputy, {})).leads;
    const memberOfDeputyTeam = (await compare(absent, {})).leads;
    expect(all).toBeGreaterThan(part);
    expect(part).toBeGreaterThan(0);
    expect(none).toBe(0);
    expect(deputyLeads).toBeGreaterThan(0);
    expect(memberOfDeputyTeam).toBeGreaterThan(0);
    const support = await compare(staff, { aal: "aal2" });
    expect(support.leads).toBe(all);
    const firstStep = await compare(factor, { aal: "aal1" });
    expect(firstStep.leads).toBe(0);
    // the owner sort names most owners for the business's owner, but not the former employee
    const ownerView = await compare(owner, {});
    expect(ownerView.leads_named).toBeGreaterThan(0);
    expect(ownerView.leads_named).toBeLessThan(ownerView.leads);
  });

  it("the five policies and profiles no longer call app.can_read_record or app.shares_org per row", async () => {
    const rows = await asAdmin(async (q) =>
      (await q<{ tablename: string; qual: string }>(
        `select tablename, qual from pg_policies where schemaname = 'public' and policyname in
           ('leads_select', 'contacts_select', 'companies_select', 'deals_select', 'tasks_select', 'profiles_select')`)).rows);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.qual, r.tablename).not.toMatch(/can_read_record|shares_org/);
    }
  });
});
