import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

// USR-11 second part / WAB-03 / MNY-03 (owner (267) א, (375)-(378)): the person's own daily summary switch, the job kind
// digest.send with ids only, the cron that queues one job per person and business day (nothing while no worker asked for the
// kind), the counts under each recipient's own read rules compared with that person's own screens, the composer's re-checks on
// the live lease, the plan key (every plan but the free plan) and the one-click stop link.

// Monday 16 November 2026; Jerusalem is UTC+2 in November
const MONDAY_0730 = "2026-11-16T05:30:00Z";
const MONDAY_0729 = "2026-11-16T05:29:00Z";
const MONDAY_1031 = "2026-11-16T08:31:00Z";

type Job = { kind: string; payload: Record<string, string>; next_run_at: string };

const queue = (at: string) =>
  asAdmin(async (q) => (await q<{ n: number }>("select app.queue_daily_digests(2000, $1::timestamptz) as n", [at])).rows[0].n);

const jobsOf = (org: string) =>
  asAdmin(async (q) =>
    (
      await q<Job>(
        "select kind, payload, to_char(next_run_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') as next_run_at from app.jobs where organization_id = $1 and kind = 'digest.send' order by payload ->> 'user_id'",
        [org],
      )
    ).rows,
  );

const workerSeen = (seen: boolean) =>
  asAdmin((q) =>
    q("update app.job_kind_seen set last_claimed_at = case when $1 then now() else null end where kind = 'digest.send'", [seen]),
  );

describe("the person's daily summary setting", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("digest-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "digest-member");
  });

  it("is off by default at 07:30, and each person reads and writes only their own row", async () => {
    await asUser(member.id, (q) => q("insert into public.digest_settings (organization_id) values ($1)", [org]));
    const own = await asUser(member.id, async (q) =>
      (await q<{ enabled: boolean; send_at: string; user_id: string }>("select enabled, send_at::text, user_id from public.digest_settings where organization_id = $1", [org])).rows,
    );
    expect(own).toEqual([{ enabled: false, send_at: "07:30:00", user_id: member.id }]);
    // the owner of the business does not see a member's row, and cannot change it
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.digest_settings where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(owner.id, async (q) => (await q("update public.digest_settings set enabled = true where organization_id = $1", [org])).rowCount)).toBe(0);
    // user_id comes from the session only
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.digest_settings (organization_id, user_id) values ($1, $2)", [org, member.id])))).code).toBe("42501");
    expect((await pgError(asUser(member.id, (q) => q("update public.digest_settings set user_id = $2 where organization_id = $1", [org, owner.id])))).code).toBe("42501");
    // no client removes a row: switching off is the way
    expect((await pgError(asUser(member.id, (q) => q("delete from public.digest_settings where organization_id = $1", [org])))).code).toBe("42501");
    // one row per person and business
    expect((await pgError(asUser(member.id, (q) => q("insert into public.digest_settings (organization_id) values ($1)", [org])))).code).toBe("23505");
  });

  it("takes a quarter hour between 05:00 and 12:00 only", async () => {
    for (const bad of ["04:45", "12:15", "07:10", "07:30:30"]) {
      expect((await pgError(asUser(member.id, (q) => q("update public.digest_settings set send_at = $2 where organization_id = $1", [org, bad])))).code, bad).toBe("23514");
    }
    for (const ok of ["05:00", "12:00", "08:45"]) {
      expect(await asUser(member.id, async (q) => (await q("update public.digest_settings set send_at = $2 where organization_id = $1", [org, ok])).rowCount), ok).toBe(1);
    }
  });

  it("an outsider cannot write one into another business", async () => {
    const outsider = await createUser("digest-outsider");
    expect((await pgError(asUser(outsider.id, (q) => q("insert into public.digest_settings (organization_id) values ($1)", [org])))).code).toBe("42501");
  });
});

describe("the job kind and its payload", () => {
  const u = "11111111-2222-4333-8444-555555555555";
  const o = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const ok = (payload: unknown) =>
    asAdmin(async (q) => (await q<{ ok: boolean }>("select app.job_payload_ok('digest.send', $1) as ok", [JSON.stringify(payload)])).rows[0].ok);

  it("digest.send is a known kind", async () => {
    const kinds = await asAdmin(async (q) => (await q<{ k: string[] }>("select app.job_kinds() as k")).rows[0].k);
    expect(kinds).toContain("digest.send");
  });

  it("holds exactly the person, the business, the kind of summary and the day", async () => {
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "manager", day: "2026-11-16" })).toBe(true);
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "personal", day: "2026-11-16" })).toBe(true);
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "other", day: "2026-11-16" })).toBe(false);
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "manager" })).toBe(false);
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "manager", day: "2026-11-16", text: "x" })).toBe(false);
    expect(await ok({ user_id: "Ab", organization_id: o, digest_kind: "manager", day: "2026-11-16" })).toBe(false);
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "manager", day: "16/11/2026" })).toBe(false);
    expect(await ok({ user_id: u, organization_id: o, digest_kind: "manager", day: 20261116 })).toBe(false);
    // the other kinds keep their own rules
    const msg = await asAdmin(async (q) =>
      (await q<{ ok: boolean }>("select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify({ user_id: u, organization_id: o, digest_kind: "manager", day: "2026-11-16" })])).rows[0].ok,
    );
    expect(msg).toBe(false);
  });
});

describe("the cron queues one job per person and business day", () => {
  let owner: { id: string };
  let manager: { id: string };
  let member: { id: string };
  let viewer: { id: string };
  let off: { id: string };
  let org: string;

  const enable = (userId: string, sendAt = "07:30") =>
    asUser(userId, (q) => q("insert into public.digest_settings (organization_id, enabled, send_at) values ($1, true, $2)", [org, sendAt]));

  beforeAll(async () => {
    owner = await createUser("digest-cron-owner");
    org = await createOrg(owner.id);
    // a working week without rest days, so only the holiday calendar could make Monday a rest day
    await asAdmin((q) => q("insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{6}') on conflict (organization_id) do update set rest_weekdays = '{6}'", [org]));
    manager = await addMember(org, owner.id, "manager", "digest-cron-manager");
    member = await addMember(org, owner.id, "member", "digest-cron-member");
    viewer = await addMember(org, owner.id, "viewer", "digest-cron-viewer");
    off = await addMember(org, owner.id, "member", "digest-cron-off");
    for (const u of [owner, manager, member, viewer]) await enable(u.id);
    await asUser(off.id, (q) => q("insert into public.digest_settings (organization_id) values ($1)", [org]));
  });

  afterAll(async () => {
    await asAdmin((q) => q("update app.jobs set status = 'refused', last_error = 'test' where organization_id = $1 and kind = 'digest.send' and status = 'queued'", [org]));
    await workerSeen(false);
  });

  it("queues nothing while no worker asked for digest.send", async () => {
    await workerSeen(false);
    expect(await queue(MONDAY_0730)).toBe(0);
    expect(await jobsOf(org)).toEqual([]);
  });

  it("queues nothing before the chosen time, or more than three hours after it", async () => {
    await workerSeen(true);
    expect(await queue(MONDAY_0729)).toBe(0);
    expect(await queue(MONDAY_1031)).toBe(0);
    expect(await jobsOf(org)).toEqual([]);
  });

  it("from the chosen time: one job per enabled active person, ids only, the business lines for owners and managers", async () => {
    await workerSeen(true);
    await queue(MONDAY_0730);
    const jobs = await jobsOf(org);
    const byUser = Object.fromEntries(jobs.map((j) => [j.payload.user_id, j]));
    expect(Object.keys(byUser).sort()).toEqual([owner.id, manager.id, member.id, viewer.id].sort());
    expect(byUser[owner.id].payload).toEqual({ user_id: owner.id, organization_id: org, digest_kind: "manager", day: "2026-11-16" });
    expect(byUser[manager.id].payload.digest_kind).toBe("manager");
    expect(byUser[member.id].payload.digest_kind).toBe("personal");
    expect(byUser[viewer.id].payload.digest_kind).toBe("personal");
    // once per person, business and day
    expect(await queue(MONDAY_0730)).toBe(0);
    expect(await queue("2026-11-16T06:00:00Z")).toBe(0);
    expect((await jobsOf(org)).length).toBe(4);
  });

  it("waits for the end of the person's own quiet hours", async () => {
    await asUser(member.id, (q) => q("select public.set_notification_settings('{}', '{}', true, '22:00', '08:00')"));
    await asUser(owner.id, (q) => q("update public.digest_settings set send_at = '08:00' where organization_id = $1", [org]));
    await workerSeen(true);
    // Tuesday: 07:30 local for the member, inside 22:00-08:00, so the job runs at 08:00 local (06:00 UTC)
    await queue("2026-11-17T05:30:00Z");
    const tuesday = (await jobsOf(org)).filter((j) => j.payload.day === "2026-11-17");
    const mine = tuesday.find((j) => j.payload.user_id === member.id);
    expect(mine?.next_run_at).toBe("2026-11-17T06:00");
    const manager0730 = tuesday.find((j) => j.payload.user_id === manager.id);
    expect(manager0730?.next_run_at).toBe("2026-11-17T05:30");
    // the owner chose 08:00: not yet
    expect(tuesday.find((j) => j.payload.user_id === owner.id)).toBeUndefined();
    await queue("2026-11-17T06:00:00Z");
    expect((await jobsOf(org)).filter((j) => j.payload.day === "2026-11-17" && j.payload.user_id === owner.id).length).toBe(1);
  });

  it("skips a rest day, a suspended person and a closed business", async () => {
    await workerSeen(true);
    // Saturday is the business's rest day
    expect(await queue("2026-11-21T05:30:00Z")).toBe(0);
    // a suspended member gets nothing
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, viewer.id]));
    await queue("2026-11-18T05:30:00Z");
    const wednesday = (await jobsOf(org)).filter((j) => j.payload.day === "2026-11-18").map((j) => j.payload.user_id);
    expect(wednesday).not.toContain(viewer.id);
    expect(wednesday).toContain(member.id);
    // a closed business gets nothing
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    try {
      expect(await queue("2026-11-19T05:30:00Z")).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
  });

  it("the queue and its bookkeeping are out of every client's reach", async () => {
    for (const sql of ["select app.queue_daily_digests()", "select * from app.digest_sends"]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql)))).code, sql).toBe("42501");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Owner (375) ב: the numbers under the RECIPIENT's own read rules, compared with what that person's own screens count (RLS)
// ---------------------------------------------------------------------------------------------------------------------------
type Counts = {
  reads_anything: boolean;
  new_leads: number | null;
  waiting_leads: number | null;
  overdue_tasks: number;
  tasks_today: number;
  money: { vat_mode: string; groups: Record<"debts" | "quotes" | "stuck" | "overdue" | "renewals", number | null> } | null;
};
type MoneyReport = {
  stuck: { amount: number };
  overdue: { amount: number };
  quotes: { amount: number } | null;
  debts: { amount: number } | null;
  renewals: { amount: number };
};

describe("the summary's numbers follow each recipient's own rights", () => {
  type U = { id: string; email: string };
  let owner: U, admin: U, manager: U, m1: U, m2: U, viewer: U, outsider: U;
  let org: string, otherOrg: string, team: string, subTeam: string;
  let pipeline: string, firstOpen: string, wonStage: string;
  let today: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const counts = (u: U, kind: "manager" | "personal", orgId = org) =>
    asAdmin(async (q) => (await one<{ c: Counts | null }>(q, "select app.digest_counts($1, $2, $3) as c", [orgId, u.id, kind])).c);
  const setVisibility = (v: "org" | "team" | "own") => asAdmin((q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, v]));
  const day = (offset: number) =>
    asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char($1::date + $2::int, 'YYYY-MM-DD') as d", [today, offset])).d);
  const deal = (name: string, ownerId: string, teamId: string | null, extra: Record<string, unknown> = {}, stage?: string) =>
    asUser(owner.id, async (q) => {
      const cols = ["organization_id", "name", "owner_id", "team_id", "pipeline_id", "stage_id", ...Object.keys(extra)];
      const vals = [org, name, ownerId, teamId, pipeline, stage ?? firstOpen, ...Object.values(extra)];
      return (
        await one<{ id: string }>(q, `insert into public.deals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals)
      ).id;
    });
  const task = (fields: Record<string, unknown>) =>
    asAdmin(async (q) => {
      const row = { organization_id: org, title: `משימה ${++n}`, ...fields };
      const cols = Object.keys(row);
      return (await one<{ id: string }>(q, `insert into public.tasks (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).id;
    });

  /** What the person's own session counts: the waiting screen's rule, the leads list, the tasks list and the money report. */
  const screens = async (u: U, kind: "manager" | "personal", role: string, managed: string[], mfa = false) =>
    (mfa ? asMfaUser : asUser)(u.id, async (q) => {
      const personal = kind === "personal";
      const taken = `(l.taken_at is null or l.owner_id = $2 or $3 in ('owner', 'admin') or ($3 = 'manager' and l.team_id = any ($4::uuid[])))`;
      const waiting = Number(
        (
          await one<{ n: string }>(
            q,
            `select count(*) as n from public.leads l join public.lead_statuses st on st.id = l.status_id and st.kind = 'open'
              where l.organization_id = $1 and l.deleted_at is null and l.converted_at is null and l.import_job_id is null
                ${personal ? "and l.owner_id = $2" : ""} and ${taken}
                and not exists (select 1 from public.activities a where a.organization_id = l.organization_id and a.lead_id = l.id
                                 and a.created_by is not null and a.type in ('note','call','meeting','email','whatsapp','sms') and not a.is_private)`,
            [org, u.id, role, managed],
          )
        ).n,
      );
      const newLeads = Number(
        (
          await one<{ n: string }>(
            q,
            `select count(*) as n from public.leads l, public.organizations o
              where o.id = $1 and l.organization_id = $1 and l.deleted_at is null and l.import_job_id is null
                and l.created_at >= ((((now() at time zone o.timezone)::date) - 1)::timestamp at time zone o.timezone)`,
            [org],
          )
        ).n,
      );
      const overdue = Number(
        (
          await one<{ n: string }>(
            q,
            `select count(*) as n from public.tasks t where t.organization_id = $1 and t.status = 'open' and t.deleted_at is null
                and t.due_at < now() ${personal ? "and t.owner_id = $2" : "and $2::uuid is not null"}`,
            [org, u.id],
          )
        ).n,
      );
      const todayTasks = Number(
        (
          await one<{ n: string }>(
            q,
            `select count(*) as n from public.tasks t, public.organizations o where o.id = $1 and t.organization_id = $1 and t.status = 'open'
                and t.deleted_at is null and t.owner_id = $2 and t.due_at >= now()
                and t.due_at < ((((now() at time zone o.timezone)::date) + 1)::timestamp at time zone o.timezone)`,
            [org, u.id],
          )
        ).n,
      );
      const money = (await one<{ r: MoneyReport }>(q, "select public.report_money_waiting($1) as r", [org])).r;
      return { waiting, newLeads, overdue, todayTasks, money };
    });

  beforeAll(async () => {
    owner = await createUser("dg-owner");
    outsider = await createUser("dg-outsider");
    org = await createOrg(owner.id, "עסק הסיכום");
    otherOrg = await createOrg(outsider.id, "עסק אחר לגמרי");
    admin = await addMember(org, owner.id, "admin", "dg-admin");
    manager = await addMember(org, owner.id, "manager", "dg-manager");
    m1 = await addMember(org, owner.id, "member", "dg-m1");
    m2 = await addMember(org, owner.id, "member", "dg-m2");
    viewer = await addMember(org, owner.id, "viewer", "dg-viewer");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [
        org,
        JSON.stringify({ quotes: true, documents: true, payments: true, money_waiting: true, daily_digest: true }),
      ]),
    );
    await asUser(owner.id, (q) =>
      q(
        "insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'",
        [org],
      ),
    );
    team = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'צוות מרכז') returning id", [org])).id);
    await asUser(owner.id, (q) =>
      q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false)",
        [org, team, manager.id, m1.id, viewer.id],
      ),
    );
    await asAdmin(async (q) => {
      pipeline = (await one<{ id: string }>(q, "select id from public.pipelines where organization_id = $1 and is_default", [org])).id;
      firstOpen = (await one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [pipeline])).id;
      wonStage = (await one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [pipeline])).id;
      await q("update public.stages set rot_days = null where id = $1", [firstOpen]);
      today = (await one<{ d: string }>(q, "select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from public.organizations where id = $1", [org])).d;
    });

    // leads: team, own, taken, answered, unowned team lead, an old one
    await insertLead(owner.id, org, { full_name: "ליד צוות", owner_id: m1.id, team_id: team });
    await insertLead(owner.id, org, { full_name: "ליד בלי צוות", owner_id: m2.id });
    const taken = await insertLead(owner.id, org, { full_name: "ליד שנלקח", owner_id: m1.id, team_id: team });
    await asAdmin((q) => q("update public.leads set taken_at = now() where id = $1", [taken]));
    const answered = await insertLead(owner.id, org, { full_name: "ליד שנענה", owner_id: m2.id });
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'call', 'שיחה', $2, $3)", [org, answered, m2.id]));
    await insertLead(owner.id, org, { full_name: "ליד צוות פנוי", team_id: team, owner_id: null });
    const old = await insertLead(owner.id, org, { full_name: "ליד ישן", owner_id: manager.id, team_id: team });
    await asAdmin((q) => q("update public.leads set created_at = now() - interval '5 days' where id = $1", [old]));

    // tasks: overdue of each kind, and today's still ahead
    await task({ owner_id: m1.id, team_id: team, due_at: new Date(Date.now() - 3_600_000).toISOString() });
    await task({ owner_id: m2.id, due_at: new Date(Date.now() - 86_400_000).toISOString() });
    await task({ owner_id: null, team_id: team, due_at: new Date(Date.now() - 7_200_000).toISOString() });
    await task({ owner_id: viewer.id, created_by: m2.id, due_at: new Date(Date.now() - 7_200_000).toISOString() });
    await task({ owner_id: manager.id, due_at: new Date(Date.now() - 600_000).toISOString() });
    await asAdmin((q) =>
      q(
        `insert into public.tasks (organization_id, title, owner_id, due_at)
         select $1, 'היום', u, least(now() + interval '1 minute', ((((now() at time zone o.timezone)::date) + 1)::timestamp at time zone o.timezone) - interval '1 second')
           from public.organizations o, unnest($2::uuid[]) u where o.id = $1`,
        [org, [m1.id, manager.id, owner.id]],
      ),
    );

    // deals: stuck (team), overdue (own), a sent quote (team), a renewal (own), and a debt
    const stuck = await deal("תקועה", m1.id, team, { amount_agorot: 50000 });
    await asAdmin((q) => q("update public.deals set stage_entered_at = now() - interval '30 days' where id = $1", [stuck]));
    await deal("באיחור", m2.id, null, { amount_agorot: 3000, expected_close_date: await day(-3) });
    const quoted = await deal("עם הצעה", m1.id, team, { amount_agorot: 9000 });
    await asUser(owner.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, quoted])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 12000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
    });
    await deal(
      "מנוי",
      m2.id,
      null,
      { billing_kind: "monthly", recurring_amount_agorot: 5000, recurring_start_date: await day(-200), renewal_date: await day(10) },
      wonStage,
    );
    const contact = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, m1.id])).id,
    );
    await asUser(owner.id, (q) =>
      q(
        "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, 'tax_invoice', $3, $4::date - 30, 20000, $4::date - 2)",
        [org, contact, `DG-${++n}`, today],
      ),
    );

    // review: a sub-team under the manager's team, with its own records
    subTeam = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צוות משנה', $2) returning id", [org, team])).id,
    );
    await asUser(owner.id, (q) => q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, subTeam, m2.id]));
    await insertLead(owner.id, org, { full_name: "ליד בצוות המשנה", owner_id: m2.id, team_id: subTeam });
    const subStuck = await deal("תקועה בצוות המשנה", m2.id, subTeam, { amount_agorot: 30000 });
    await asAdmin((q) => q("update public.deals set stage_entered_at = now() - interval '30 days' where id = $1", [subStuck]));
    await task({ owner_id: m2.id, team_id: subTeam, due_at: new Date(Date.now() - 5_400_000).toISOString() });
    // review: a private note on a waiting lead is not contact
    const privateNoted = await insertLead(owner.id, org, { full_name: "ליד עם הערה פרטית", owner_id: m1.id, team_id: team });
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, lead_id, created_by, is_private) values ($1, 'note', 'פרטי', $2, $3, true)", [org, privateNoted, m1.id]),
    );
    // review: a quote on a contact without a deal
    await asUser(owner.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה לאיש קשר', $2) returning id", [org, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שירות', 7000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
    });
    // review: HEB-08, m2 is away today and m1 is the deputy; m2's open task links m2's lead and overdue deal
    const m2Lead = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.leads where organization_id = $1 and full_name = 'ליד בלי צוות'", [org])).id);
    const m2Deal = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.deals where organization_id = $1 and name = 'באיחור'", [org])).id);
    await task({ owner_id: m2.id, lead_id: m2Lead, deal_id: m2Deal, due_at: new Date(Date.now() + 86_400_000 * 3).toISOString() });
    await asAdmin((q) =>
      q(
        `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
         select $1, $2, (now() at time zone o.timezone)::date - 1, (now() at time zone o.timezone)::date + 1, 'vacation', $3
           from public.organizations o where o.id = $1`,
        [org, m2.id, m1.id],
      ),
    );

    // another business with data of its own: nothing of it may reach a summary of this one
    await insertLead(outsider.id, otherOrg, { full_name: "ליד זר" });
    await asAdmin((q) => q("insert into public.tasks (organization_id, title, owner_id, due_at) values ($1, 'זרה', $2, now() - interval '1 hour')", [otherOrg, outsider.id]));
  });

  /**
   * Both kinds of summary for every person, against what that person's own session counts. `managed` = the teams the
   * person manages and every team under them (the parent team's manager reads the sub-team).
   */
  const compareAll = async (label: string, mfa = false) => {
    const people: [U, string, string[]][] = [
      [owner, "owner", []],
      [admin, "admin", []],
      [manager, "manager", [team, subTeam]],
      [m1, "member", []],
      [m2, "member", []],
      [viewer, "viewer", []],
    ];
    for (const [u, role, managed] of people) {
      for (const kind of ["manager", "personal"] as const) {
        const got = await counts(u, kind);
        const seen = await screens(u, kind, role, managed, mfa);
        const at = `${label}/${role}/${kind}/${u.email}`;
        expect(got?.reads_anything, at).toBe(true);
        expect(got?.waiting_leads, at).toBe(seen.waiting);
        expect(got?.overdue_tasks, at).toBe(seen.overdue);
        expect(got?.tasks_today, at).toBe(seen.todayTasks);
        if (kind === "manager") {
          expect(got?.new_leads, at).toBe(seen.newLeads);
          const g = got?.money?.groups;
          expect(g?.stuck, at).toBe(seen.money.stuck.amount);
          expect(g?.overdue, at).toBe(seen.money.overdue.amount);
          expect(g?.quotes, at).toBe(seen.money.quotes?.amount ?? null);
          expect(g?.renewals, at).toBe(seen.money.renewals.amount);
          // debts: owners and admins only (a manager's summary leaves them out; the lead's decision)
          expect(g?.debts, at).toBe(role === "owner" || role === "admin" ? (seen.money.debts?.amount ?? null) : null);
        } else {
          expect(got?.new_leads, at).toBeNull();
          expect(got?.money, at).toBeNull();
        }
      }
    }
  };

  for (const visibility of ["org", "team", "own"] as const) {
    it(`visibility '${visibility}': every role's numbers equal what that person's own screens count`, async () => {
      await setVisibility(visibility);
      await compareAll(visibility);
    });
  }

  it("a business that requires two-step verification: counted as after the second step (the lead's accepted rule)", async () => {
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
    try {
      for (const visibility of ["team", "own"] as const) {
        await setVisibility(visibility);
        await compareAll(`mfa/${visibility}`, true);
      }
      // without the second step the person's own session reads nothing; the summary counts as after it
      expect(await asUser(m1.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(0);
      expect((await counts(m1, "personal"))?.waiting_leads).toBeGreaterThan(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
      await setVisibility("org");
    }
  });

  it("the cases the review named really occur in the data (own visibility)", async () => {
    await setVisibility("own");
    try {
      // HEB-08: m1 is m2's deputy today and reads m2's records that m2's open task links (the overdue deal)
      expect((await counts(m1, "manager"))?.money?.groups.overdue).toBeGreaterThan(0);
      // the parent team's manager reads the sub-team's stuck deal
      const mgr = await counts(manager, "manager");
      expect(mgr?.money?.groups.stuck).toBeGreaterThanOrEqual(80000);
      // the quote on a contact without a deal counts for whoever reads the contact (m1 owns it)
      expect((await counts(m1, "manager"))?.money?.groups.quotes).toBeGreaterThan(0);
      // TASK-07: the unowned team task counts for a team member, never for the viewer who is in the team
      const viewerTasks = (await counts(viewer, "manager"))?.overdue_tasks ?? 0;
      const memberTasks = (await counts(m1, "manager"))?.overdue_tasks ?? 0;
      expect(await asUser(viewer.id, (q) => count(q, "select 1 from public.tasks where organization_id = $1 and owner_id is null and team_id = $2", [org, team]))).toBe(0);
      expect(await asUser(m1.id, (q) => count(q, "select 1 from public.tasks where organization_id = $1 and owner_id is null and team_id = $2", [org, team]))).toBe(1);
      expect(memberTasks).toBeGreaterThan(0);
      expect(viewerTasks).toBeGreaterThanOrEqual(0);
      // a private note is not contact: the lead with only a private note still waits
      expect(await asAdmin((q) => count(q, "select 1 from public.activities where organization_id = $1 and is_private and lead_id is not null", [org]))).toBe(1);
    } finally {
      await setVisibility("org");
    }
  });

  it("the test data really tells the roles apart (own visibility)", async () => {
    await setVisibility("own");
    const ownerCounts = await counts(owner, "manager");
    const m2Counts = await counts(m2, "personal");
    expect(ownerCounts?.waiting_leads).toBeGreaterThan(m2Counts?.waiting_leads ?? 0);
    expect((await counts(manager, "manager"))?.money?.groups.stuck).toBeGreaterThan(0);
    expect((await counts(viewer, "manager"))?.money?.groups.stuck).toBe(0);
    expect(ownerCounts?.money?.groups.debts).toBeGreaterThan(0);
    await setVisibility("org");
  });

  it("nothing of another business: an outsider gets nothing, and the other business's records count for no one here", async () => {
    expect(await counts(outsider, "manager")).toBeNull();
    const before = await counts(owner, "manager");
    await insertLead(outsider.id, otherOrg, { full_name: "עוד ליד זר" });
    expect(await counts(owner, "manager")).toEqual(before);
    // the outsider's own summary of their own business does not see this one's
    const theirs = await counts(outsider, "manager", otherOrg);
    expect(theirs?.waiting_leads).toBe(2);
    expect(theirs?.overdue_tasks).toBe(1);
  });

  it("a person who reads nothing gets no numbers", async () => {
    const lonely = await addMember(org, owner.id, "viewer", "dg-lonely");
    await setVisibility("own");
    try {
      expect(await counts(lonely, "personal")).toEqual({ reads_anything: false });
    } finally {
      await setVisibility("org");
    }
  });

  it("counts only: no name, title, phone or address in the answer", async () => {
    const text = JSON.stringify(await counts(owner, "manager"));
    for (const word of ["ליד", "דנה", "תקועה", "הצעה", "@"]) expect(text).not.toContain(word);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The worker's composer and the stop link (owner (375) ב, (377) ב)
// ---------------------------------------------------------------------------------------------------------------------------
describe("the composer re-checks everything on the job's live lease, and the stop link stops it once", () => {
  type U = { id: string; email: string };
  let owner: U, member: U, other: U;
  let org: string;
  let today: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setOverrides = (value: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(value)]));
  /** A digest job for the person, claimed: its id and lease. */
  const claimed = async (u: U, day = today): Promise<{ id: string; lease: string }> => {
    await asAdmin((q) =>
      q("select app.enqueue_job($1, 'digest.send', $2, now() - interval '1 second')", [
        org,
        JSON.stringify({ user_id: u.id, organization_id: org, digest_kind: "personal", day }),
      ]),
    );
    const rows = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string; payload: { user_id: string } }> }>(q, "select public.claim_jobs(array['digest.send'], 100) as r")).r);
    const mine = rows.find((r) => r.payload.user_id === u.id);
    expect(mine).toBeDefined();
    return { id: mine!.id, lease: mine!.lease };
  };
  const compose = (job: { id: string; lease: string }) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.digest_job_compose($1, $2) as r", [job.id, job.lease])).r);
  const stop = (token: string, stopIt: boolean, ip: string | null = null) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.digest_stop($1, $2, $3) as r", [token, ip, stopIt])).r);
  const settings = (u: U) =>
    asAdmin(async (q) =>
      (await one<{ enabled: boolean; stopped: boolean }>(q, "select enabled, stopped_by_link_at is not null as stopped from public.digest_settings where organization_id = $1 and user_id = $2", [org, u.id])),
    );

  beforeAll(async () => {
    owner = await createUser("dgc-owner");
    org = await createOrg(owner.id, "עסק המיילים");
    member = await addMember(org, owner.id, "member", "dgc-member");
    other = await addMember(org, owner.id, "member", "dgc-other");
    await setOverrides({ daily_digest: true });
    for (const u of [member, other]) {
      await asUser(u.id, (q) => q("insert into public.digest_settings (organization_id, enabled) values ($1, true)", [org]));
    }
    today = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from public.organizations where id = $1", [org])).d);
  });

  afterAll(async () => {
    await asAdmin((q) =>
      q(
        "update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where organization_id = $1 and kind = 'digest.send' and status in ('queued', 'running')",
        [org],
      ),
    );
    await workerSeen(false);
  });

  it("answers the person's address, the business's name, the counts and a one-time stop token", async () => {
    const job = await claimed(member);
    const r = await compose(job);
    expect(r.to).toBe(member.email);
    expect(r.business_name).toBe("עסק המיילים");
    expect(r.day).toBe(today);
    expect(r.kind).toBe("personal");
    expect(r.counts).toMatchObject({ reads_anything: true, waiting_leads: 0, overdue_tasks: 0, tasks_today: 0 });
    expect(String(r.stop_token)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    // only the token's SHA-256 is kept
    const kept = await asAdmin(async (q) =>
      (await one<{ n: string }>(q, "select count(*) as n from app.digest_stop_tokens where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') and user_id = $2", [r.stop_token, member.id])).n,
    );
    expect(Number(kept)).toBe(1);
    expect(await asAdmin(async (q) => count(q, "select 1 from app.digest_stop_tokens where token_hash = $1", [r.stop_token]))).toBe(0);
  });

  it("refuses on a lease that is not the job's live one, and when anything changed since the job was queued", async () => {
    const job = await claimed(member);
    expect(await compose({ id: job.id, lease: "00000000-0000-4000-8000-000000000000" })).toEqual({ refused: "stale" });
    // the summary switched off
    await asUser(member.id, (q) => q("update public.digest_settings set enabled = false where organization_id = $1", [org]));
    expect(await compose(job)).toEqual({ refused: "switched_off" });
    await asUser(member.id, (q) => q("update public.digest_settings set enabled = true where organization_id = $1", [org]));
    // the plan lost the key (owner (376) ב: the free plan)
    await setOverrides({ daily_digest: false });
    expect(await compose(job)).toEqual({ refused: "feature_off" });
    await setOverrides({ daily_digest: true });
    // yesterday's job
    const old = await claimed(other, "2020-01-01");
    expect(await compose(old)).toEqual({ refused: "expired" });
    // no longer a member
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    try {
      expect(await compose(job)).toEqual({ refused: "not_member" });
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    }
    // a closed business
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    try {
      expect(await compose(job)).toEqual({ refused: "business_closed" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("the free plan does not hold the key; every sold plan does", async () => {
    const rows = await asAdmin(async (q) =>
      (await q<{ key: string; f: boolean | null }>("select key, (features ->> 'daily_digest')::boolean as f from public.plans order by key")).rows,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.f]));
    for (const plan of ["personal", "basic", "pro", "business"]) expect(byKey[plan], plan).toBe(true);
    expect(byKey.free ?? null).not.toBe(true);
    expect(await asAdmin(async (q) => (await one<{ f: boolean }>(q, "select (app.plan_key_defaults() -> 'features' ->> 'daily_digest')::boolean as f")).f)).toBe(false);
  });

  it("the stop page reads only; the stop switches the summary off once and is shown in the person's settings", async () => {
    const r = await compose(await claimed(other));
    const token = String(r.stop_token);
    expect(await stop(token, false)).toEqual({ status: "active", business: "עסק המיילים" });
    expect(await settings(other)).toEqual({ enabled: true, stopped: false });
    expect(await stop(token, true)).toEqual({ status: "stopped", business: "עסק המיילים" });
    expect(await settings(other)).toEqual({ enabled: false, stopped: true });
    // review 5: the real state. Once switched on again, the used link says so and changes nothing
    expect(await stop(token, false)).toEqual({ status: "stopped", business: "עסק המיילים" });
    await asUser(other.id, (q) => q("update public.digest_settings set enabled = true where organization_id = $1", [org]));
    expect(await settings(other)).toEqual({ enabled: true, stopped: false });
    expect(await stop(token, false)).toEqual({ status: "used", business: "עסק המיילים" });
    expect(await stop(token, true)).toEqual({ status: "used", business: "עסק המיילים" });
    expect(await settings(other)).toEqual({ enabled: true, stopped: false });
    // an unused link while the person switched it off in the settings: "stopped", nothing changes
    const fresh = String((await compose(await claimed(other))).stop_token);
    await asUser(other.id, (q) => q("update public.digest_settings set enabled = false where organization_id = $1", [org]));
    expect(await stop(fresh, false)).toEqual({ status: "stopped", business: "עסק המיילים" });
    expect(await settings(other)).toEqual({ enabled: false, stopped: false });
    await asUser(other.id, (q) => q("update public.digest_settings set enabled = true where organization_id = $1", [org]));
    // a client cannot set the mark itself
    expect((await pgError(asUser(other.id, (q) => q("update public.digest_settings set stopped_by_link_at = now() where organization_id = $1", [org])))).code).toBe("42501");
    // another person's link touches only that person
    expect((await settings(member)).enabled).toBe(true);
  });

  it("review 4: one stop token per job, the same on every try; its plain form is cleared once the job has ended", async () => {
    const job = await claimed(member);
    const first = await compose(job);
    const again = await compose(job);
    expect(again.stop_token).toBe(first.stop_token);
    expect(await asAdmin((q) => count(q, "select 1 from app.digest_stop_tokens where job_id = $1", [job.id]))).toBe(1);
    // still waiting to be tried: kept
    await asAdmin((q) => q("select app.digest_clear_plain_tokens()"));
    expect(await asAdmin((q) => count(q, "select 1 from app.digest_stop_tokens where job_id = $1 and plain_token is not null", [job.id]))).toBe(1);
    // the job ends: only the hash stays, and the link still works
    await asService((q) => q("select public.finish_job($1, $2, true, null, false, true)", [job.id, job.lease]));
    await asAdmin((q) => q("select app.digest_clear_plain_tokens()"));
    expect(await asAdmin((q) => count(q, "select 1 from app.digest_stop_tokens where job_id = $1 and plain_token is null", [job.id]))).toBe(1);
    expect((await stop(String(first.stop_token), false)).status).toBe("active");
  });

  it("delta review: a plain token is also cleared when it expired or its job's day has passed, though the job still waits", async () => {
    const job = await claimed(other);
    await compose(job);
    const plain = () => asAdmin((q) => count(q, "select 1 from app.digest_stop_tokens where job_id = $1 and plain_token is not null", [job.id]));
    await asAdmin((q) => q("select app.digest_clear_plain_tokens()"));
    expect(await plain()).toBe(1);
    // the job is still running, but its day is yesterday: cleared
    await asAdmin((q) => q("update app.jobs set payload = jsonb_set(payload, '{day}', '\"2020-01-01\"') where id = $1", [job.id]));
    await asAdmin((q) => q("select app.digest_clear_plain_tokens()"));
    expect(await plain()).toBe(0);
    // an expired token of a job of today: cleared too
    const job2 = await claimed(other);
    await compose(job2);
    await asAdmin((q) => q("update app.digest_stop_tokens set expires_at = now() - interval '1 second' where job_id = $1", [job2.id]));
    await asAdmin((q) => q("select app.digest_clear_plain_tokens()"));
    expect(await asAdmin((q) => count(q, "select 1 from app.digest_stop_tokens where job_id = $1 and plain_token is not null", [job2.id]))).toBe(0);
  });

  it("delta review: a stop link used while a job waits for its retry makes that job send nothing (token_gone)", async () => {
    const job = await claimed(other);
    const first = await compose(job);
    // the person stops from an older email, then switches the summary on again before the retry
    const older = String((await compose(await claimed(other))).stop_token);
    expect((await stop(older, true)).status).toBe("stopped");
    await asUser(other.id, (q) => q("update public.digest_settings set enabled = true where organization_id = $1", [org]));
    // the retry would carry the dead link of its first try: refused, nothing sent
    expect(await compose(job)).toEqual({ refused: "token_gone" });
    expect((await stop(String(first.stop_token), false)).status).toBe("used");
  });

  it("review 3: quiet hours that cover the rest of the day never hold the summary past its own day", async () => {
    const runAt = (at: string) =>
      asAdmin(async (q) =>
        (await one<{ r: string }>(q, "select to_char(app.digest_run_at($1, 'Asia/Jerusalem', $2::timestamptz) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') as r", [other.id, at])).r,
      );
    await asUser(other.id, (q) => q("select public.set_notification_settings('{}', '{}', true, '11:00', '09:00')"));
    try {
      // 12:00 local inside 11:00-09:00: the end is tomorrow, so the summary goes at 12:00 today
      expect(await runAt("2026-11-16T10:00:00Z")).toBe("2026-11-16T10:00");
      // 08:00 local inside it: the end (09:00) is today, so it waits for it
      expect(await runAt("2026-11-16T06:00:00Z")).toBe("2026-11-16T07:00");
    } finally {
      await asUser(other.id, (q) => q("select public.set_notification_settings('{}', '{}', true, null, null)"));
    }
  });

  it("unknown, malformed and expired tokens are not found", async () => {
    expect(await stop("x".repeat(64), false)).toEqual({ status: "not_found" });
    expect(await stop("short", true)).toEqual({ status: "not_found" });
    const r = await compose(await claimed(member));
    await asAdmin((q) => q("update app.digest_stop_tokens set expires_at = now() - interval '1 second' where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [r.stop_token]));
    expect(await stop(String(r.stop_token), true)).toEqual({ status: "not_found" });
    expect((await settings(member)).enabled).toBe(true);
  });

  it("limits: 30 calls per link and 60 per sender in 10 minutes", async () => {
    const r = await compose(await claimed(member));
    const token = String(r.stop_token);
    for (let i = 0; i < 30; i++) expect((await stop(token, false)).status).toBe("active");
    expect(await stop(token, false)).toEqual({ rate_limited: true });
    const ip = "a".repeat(64);
    await asAdmin((q) => q("update app.digest_stop_counts set hits = 0, window_start = now()"));
    for (let i = 0; i < 60; i++) await stop("y".repeat(64), false, ip);
    expect(await stop("y".repeat(64), false, ip)).toEqual({ rate_limited: true });
  });

  it("only the server reaches the composer, the stop function and their tables", async () => {
    for (const sql of [
      "select public.digest_job_compose('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')",
      "select public.digest_stop('x', null, true)",
      "select app.digest_counts($1, $2, 'manager')",
      "select * from app.digest_stop_tokens",
    ]) {
      const params = sql.includes("$1") ? [org, owner.id] : [];
      expect((await pgError(asUser(owner.id, (q) => q(sql, params)))).code, sql).toBe("42501");
    }
    expect((await pgError(asAnon((q) => q("select public.digest_stop('x', null, true)")))).code).toBe("42501");
  });
});
