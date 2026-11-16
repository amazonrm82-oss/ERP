import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

// USR-09 (owner (387) א, 16 November 2026): the existing invitation sent by email through the queue (invite.send). Only who
// may invite today sends; the queue holds the invitation's id and who asked, never a token; 3 emails per invitation and 100
// per business a day; the composer re-checks everything on the live lease and mints a new token whose SHA-256 replaces the
// invitation's, so the email's link is the one that works.

const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
const sha = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

const workerSeen = (seen: boolean) =>
  asAdmin((q) => q("update app.job_kind_seen set last_claimed_at = case when $1 then now() else null end where kind = 'invite.send'", [seen]));

type U = { id: string; email: string };

describe("the job kind and its payload", () => {
  const i = "11111111-2222-4333-8444-555555555555";
  const u = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const ok = (payload: unknown) =>
    asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('invite.send', $1) as ok", [JSON.stringify(payload)])).ok);

  it("invite.send holds exactly the invitation and who asked; never a token or an address", async () => {
    const kinds = await asAdmin(async (q) => (await one<{ k: string[] }>(q, "select app.job_kinds() as k")).k);
    expect(kinds).toContain("invite.send");
    expect(await ok({ invitation_id: i, requested_by: u })).toBe(true);
    expect(await ok({ invitation_id: i })).toBe(false);
    expect(await ok({ invitation_id: i, requested_by: u, token: "a".repeat(64) })).toBe(false);
    expect(await ok({ invitation_id: i, requested_by: u, email: "a@x.co" })).toBe(false);
    expect(await ok({ invitation_id: "x", requested_by: u })).toBe(false);
  });
});

describe("sending an invitation by email", () => {
  let owner: U, admin: U, manager: U, outsider: U;
  let org: string;
  const invite = async (by: string, email: string, role = "member") => {
    const token = await asUser(by, async (q) => (await one<{ t: string }>(q, "select public.create_invitation($1, $2, $3) as t", [org, email, role])).t);
    const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.invitations where token_hash = $1", [sha(token)])).id);
    return { token, id };
  };
  const queue = (by: string, id: string) =>
    asUser(by, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invitation_email_queue($1, $2) as r", [org, id])).r);
  const jobsFor = (id: string) =>
    asAdmin(async (q) => (await q<{ payload: Record<string, string> }>("select payload from app.jobs where kind = 'invite.send' and payload ->> 'invitation_id' = $1", [id])).rows);

  beforeAll(async () => {
    owner = await createUser("inv-owner");
    org = await createOrg(owner.id, "עסק ההזמנות");
    admin = await addMember(org, owner.id, "admin", "inv-admin");
    manager = await addMember(org, owner.id, "manager", "inv-manager");
    outsider = await createUser("inv-outsider");
  });

  afterAll(async () => {
    await asAdmin((q) =>
      q("update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where kind = 'invite.send' and status in ('queued', 'running')"),
    );
    await workerSeen(false);
  });

  it("queues nothing while no worker sends the kind, and says so", async () => {
    await workerSeen(false);
    const { id } = await invite(owner.id, "nobody-sends@example.test");
    expect(await queue(owner.id, id)).toEqual({ ok: false, reason: "unavailable" });
    expect(await jobsFor(id)).toEqual([]);
  });

  it("only who may invite today sends: owners and admins; an admin invitation only by the owner", async () => {
    await workerSeen(true);
    const { id } = await invite(admin.id, "by-admin@example.test");
    expect(await queue(admin.id, id)).toEqual({ ok: true });
    const jobs = await jobsFor(id);
    expect(jobs).toEqual([{ payload: { invitation_id: id, requested_by: admin.id } }]);
    for (const u of [manager, outsider]) expect((await pgError(queue(u.id, id))).code, u.email).toBe("42501");
    const adminInvite = await invite(owner.id, "new-admin@example.test", "admin");
    expect((await pgError(queue(admin.id, adminInvite.id))).code).toBe("42501");
    expect(await queue(owner.id, adminInvite.id)).toEqual({ ok: true });
  });

  it("refuses an invitation that is not pending, and caps 3 a day per address", async () => {
    const { id } = await invite(owner.id, "three@example.test");
    expect(await queue(owner.id, id)).toEqual({ ok: true });
    expect(await queue(owner.id, id)).toEqual({ ok: true });
    expect(await queue(owner.id, id)).toEqual({ ok: true });
    expect(await queue(owner.id, id)).toEqual({ ok: false, reason: "rate" });
    expect((await jobsFor(id)).length).toBe(3);
    const revoked = await invite(owner.id, "revoked@example.test");
    await asUser(owner.id, (q) => q("update public.invitations set revoked_at = now() where id = $1", [revoked.id]));
    expect((await pgError(queue(owner.id, revoked.id))).hint).toBe("invitation_email:not_pending");
    const status = await asUser(owner.id, async (q) => (await one<{ r: Array<Record<string, unknown>> }>(q, "select public.invitation_email_status($1) as r", [org])).r);
    expect(status.find((s) => s.invitation_id === id)).toMatchObject({ sends_today: 3, state: "waiting", composed: false });
    expect(await asUser(manager.id, async (q) => (await one<{ r: unknown }>(q, "select public.invitation_email_status($1) as r", [org])).r)).toEqual([]);
  });

  it("review fix 3: the status tells a send that failed after its link was minted", async () => {
    const { id } = await invite(owner.id, "minted@example.test");
    expect(await queue(owner.id, id)).toEqual({ ok: true });
    const rows = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string; payload: Record<string, string> }> }>(q, "select public.claim_jobs(array['invite.send'], 100) as r")).r);
    const job = rows.find((r) => r.payload.invitation_id === id)!;
    const composed = await asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invitation_job_compose($1, $2) as r", [job.id, job.lease])).r);
    expect(String(composed.token)).toMatch(/^[0-9a-f]{64}$/);
    const statusOf = async () =>
      (await asUser(owner.id, async (q) => (await one<{ r: Array<Record<string, unknown>> }>(q, "select public.invitation_email_status($1) as r", [org])).r)).find(
        (r) => r.invitation_id === id,
      );
    expect(await statusOf()).toMatchObject({ state: "waiting", composed: true });
    await asAdmin((q) => q("update app.jobs set status = 'dead', lease_id = null, locked_until = null, finished_at = now() where id = $1", [job.id]));
    expect(await statusOf()).toMatchObject({ state: "failed", composed: true });
  });

  it("review fix 1: revoking, deleting or replacing an invitation never gives sends back", async () => {
    const email = "loop@example.test";
    const first = await invite(owner.id, email);
    for (let i = 0; i < 3; i += 1) expect(await queue(owner.id, first.id)).toEqual({ ok: true });
    // delete it, and invite the same address again: the address's day is still full
    await asUser(owner.id, (q) => q("delete from public.invitations where id = $1", [first.id]));
    const second = await invite(owner.id, email);
    expect(await queue(owner.id, second.id)).toEqual({ ok: false, reason: "rate" });
    // a new invitation replaces a pending one (create_invitation revokes it): still full
    const third = await invite(owner.id, email);
    expect(await queue(owner.id, third.id)).toEqual({ ok: false, reason: "rate" });
    expect(await asAdmin((q) => count(q, "select 1 from app.invitation_email_sends where organization_id = $1 and email = $2", [org, email]))).toBe(3);
  });

  it("delta review 1a: at most 5 emails to one address in 24 hours across every business", async () => {
    const target = "everywhere@example.test";
    const here = await invite(owner.id, target);
    for (let i = 0; i < 3; i += 1) expect(await queue(owner.id, here.id)).toEqual({ ok: true });
    // two other people, each in a business of their own
    const results: unknown[] = [];
    for (const label of ["inv-x1", "inv-x2"]) {
      const other = await createUser(label);
      const otherOrg = await createOrg(other.id, `עסק ${label}`);
      const token = await asUser(other.id, async (q) => (await one<{ t: string }>(q, "select public.create_invitation($1, $2, 'member') as t", [otherOrg, target])).t);
      const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.invitations where token_hash = $1", [sha(token)])).id);
      results.push(await asUser(other.id, async (q) => (await one<{ r: unknown }>(q, "select public.invitation_email_queue($1, $2) as r", [otherOrg, id])).r));
      results.push(await asUser(other.id, async (q) => (await one<{ r: unknown }>(q, "select public.invitation_email_queue($1, $2) as r", [otherOrg, id])).r));
    }
    // 3 + 2 go out; the sixth and seventh are refused with the same neutral answer
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: false, reason: "rate" }, { ok: false, reason: "rate" }]);
    expect(await asAdmin((q) => count(q, "select 1 from app.invitation_email_sends where email = $1", [target]))).toBe(5);
  });

  it("caps 100 a business day, and 100 per requesting person in 24 hours across businesses", async () => {
    const day = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from public.organizations where id = $1", [org])).d);
    const fill = (target: string, by: string, n: number) =>
      asAdmin((q) =>
        q("insert into app.invitation_email_sends (organization_id, invitation_id, email, requested_by, day) select $1, gen_random_uuid(), 'filler' || g || '@example.test', $2, $3::date from generate_series(1, $4) g", [target, by, day, n]),
      );
    const { id } = await invite(owner.id, "cap@example.test");
    const used = await asAdmin((q) => count(q, "select 1 from app.invitation_email_sends where organization_id = $1 and day = $2::date", [org, day]));
    await fill(org, admin.id, 100 - used);
    expect(await queue(owner.id, id)).toEqual({ ok: false, reason: "rate_business" });
    // the same owner in another business: 100 sends in 24 hours across businesses stop them there too
    const otherOrg = await createOrg(owner.id, "עסק נוסף");
    const elsewhere = await asUser(owner.id, async (q) => (await one<{ t: string }>(q, "select public.create_invitation($1, 'elsewhere@example.test', 'member') as t", [otherOrg])).t);
    const elsewhereId = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.invitations where token_hash = $1", [sha(elsewhere)])).id);
    const mine = await asAdmin((q) => count(q, "select 1 from app.invitation_email_sends where requested_by = $1", [owner.id]));
    // the owner's 100 sit in a third business, so neither the address nor the business cap is what answers
    const thirdOrg = await createOrg(owner.id, "עסק שלישי");
    await fill(thirdOrg, owner.id, 100 - mine);
    expect(await asUser(owner.id, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invitation_email_queue($1, $2) as r", [otherOrg, elsewhereId])).r)).toEqual({
      ok: false,
      reason: "rate_requester",
    });
  });
});

describe("the composer", () => {
  let owner: U, admin: U;
  let org: string;
  const invite = async (email: string, role = "member") => {
    const token = await asUser(owner.id, async (q) => (await one<{ t: string }>(q, "select public.create_invitation($1, $2, $3) as t", [org, email, role])).t);
    const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.invitations where token_hash = $1", [sha(token)])).id);
    return { token, id };
  };
  const claimed = async (id: string, by: string) => {
    await asAdmin((q) => q("select app.enqueue_job($1, 'invite.send', $2, now() - interval '1 second')", [org, JSON.stringify({ invitation_id: id, requested_by: by })]));
    const rows = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string; payload: Record<string, string> }> }>(q, "select public.claim_jobs(array['invite.send'], 100) as r")).r);
    const mine = rows.find((r) => r.payload.invitation_id === id && r.payload.requested_by === by);
    expect(mine).toBeDefined();
    return { id: mine!.id, lease: mine!.lease };
  };
  const compose = (job: { id: string; lease: string }) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invitation_job_compose($1, $2) as r", [job.id, job.lease])).r);

  beforeAll(async () => {
    owner = await createUser("invc-owner");
    org = await createOrg(owner.id, "עסק המוזמנים");
    admin = await addMember(org, owner.id, "admin", "invc-admin");
  });

  afterAll(async () => {
    await asAdmin((q) =>
      q("update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where kind = 'invite.send' and status in ('queued', 'running')"),
    );
  });

  it("answers the address, the business, the role and a new token; only its hash is kept and the old link stops working", async () => {
    const { token: copied, id } = await invite("fresh@example.test");
    const r = await compose(await claimed(id, owner.id));
    expect(Object.keys(r).sort()).toEqual(["business_name", "expires_at", "role", "to", "token"]);
    expect(r).toMatchObject({ to: "fresh@example.test", business_name: "עסק המוזמנים", role: "member" });
    const token = String(r.token);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(copied);
    const hash = await asAdmin(async (q) => (await one<{ h: string }>(q, "select token_hash as h from public.invitations where id = $1", [id])).h);
    expect(hash).toBe(sha(token));
    // nothing plain anywhere: not on the job, not in the queue
    const jobText = await asAdmin(async (q) => (await one<{ t: string }>(q, "select coalesce(string_agg(payload::text || coalesce(last_error, ''), ''), '') as t from app.jobs where kind = 'invite.send'")).t);
    expect(jobText).not.toContain(token);
    // the copied link no longer finds the invitation; the new one does
    const invitee = await createUser("invc-fresh");
    await asAdmin((q) => q("update auth.users set email = 'fresh@example.test' where id = $1", [invitee.id]));
    expect((await pgError(asUser(invitee.id, (q) => q("select public.accept_invitation($1)", [copied])))).code).toBe("P0002");
    await asUser(invitee.id, (q) => q("select public.accept_invitation($1)", [token]));
    expect(await asAdmin(async (q) => (await one<{ a: boolean }>(q, "select accepted_at is not null as a from public.invitations where id = $1", [id])).a)).toBe(true);
  });

  it("refuses on a stale lease and when anything changed since the job was queued", async () => {
    const { id } = await invite("later@example.test");
    const job = await claimed(id, admin.id);
    expect(await compose({ id: job.id, lease: "00000000-0000-4000-8000-000000000000" })).toEqual({ refused: "stale" });
    // the person who asked is no longer an admin
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, admin.id]));
    try {
      expect(await compose(job)).toEqual({ refused: "inviter_gone" });
    } finally {
      await asAdmin((q) => q("update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2", [org, admin.id]));
    }
    // an admin invitation asked by an admin
    const adminInvite = await invite("another-admin@example.test", "admin");
    expect(await compose(await claimed(adminInvite.id, admin.id))).toEqual({ refused: "inviter_gone" });
    // expired, then revoked
    const expired = await invite("expired@example.test");
    const expiredJob = await claimed(expired.id, owner.id);
    await asAdmin((q) => q("update public.invitations set expires_at = now() - interval '1 minute' where id = $1", [expired.id]));
    expect(await compose(expiredJob)).toEqual({ refused: "expired" });
    await asUser(owner.id, (q) => q("update public.invitations set revoked_at = now() where id = $1", [id]));
    expect(await compose(job)).toEqual({ refused: "not_pending" });
    // a business that cannot write
    const open = await invite("closed@example.test");
    const closedJob = await claimed(open.id, owner.id);
    const status = await asAdmin(async (q) => (await one<{ s: string }>(q, "select status::text as s from public.organizations where id = $1", [org])).s);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await compose(closedJob)).toEqual({ refused: "business_closed" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2::public.org_status where id = $1", [org, status]));
    }
  });

  it("delta review 1b: a business name holding a link, an @ or a :// is sent as the neutral word", async () => {
    const original = await asAdmin(async (q) => (await one<{ n: string }>(q, "select name as n from public.organizations where id = $1", [org])).n);
    try {
      for (const name of ["קנו עכשיו evil.com", "כתבו לי a@b.co", "https://x.example", "בקרו www.bad.example"]) {
        await asAdmin((q) => q("update public.organizations set name = $2 where id = $1", [org, name]));
        const { id } = await invite(`n${Math.random().toString(36).slice(2, 8)}@example.test`);
        const r = await compose(await claimed(id, owner.id));
        expect(r.business_name, name).toBe("העסק");
      }
      await asAdmin((q) => q("update public.organizations set name = 'מספרת רותי' where id = $1", [org]));
      const { id } = await invite("plain-name@example.test");
      expect((await compose(await claimed(id, owner.id))).business_name).toBe("מספרת רותי");
    } finally {
      await asAdmin((q) => q("update public.organizations set name = $2 where id = $1", [org, original]));
    }
  });

  it("only the service role calls the composer", async () => {
    const err = await pgError(asUser(owner.id, (q) => q("select public.invitation_job_compose('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')")));
    expect(err.code).toBe("42501");
  });
});

describe("retention of the send logs (delta review 3, the hand-pasted 021291)", () => {
  it("removes invitation sends after 30 days and report sends after 90, nothing younger", async () => {
    const owner = await createUser("purge-owner");
    const org = await createOrg(owner.id, "עסק הניקוי");
    const ages = [29, 31];
    for (const days of ages) {
      await asAdmin((q) =>
        q("insert into app.invitation_email_sends (organization_id, invitation_id, email, requested_by, day, requested_at) values ($1, gen_random_uuid(), $2, $3, current_date - $4::int, now() - make_interval(days => $4::int))", [
          org,
          `purge${days}@example.test`,
          owner.id,
          days,
        ]),
      );
    }
    for (const days of [89, 91]) {
      await asAdmin((q) =>
        q("insert into app.report_schedule_sends (schedule_id, user_id, day, organization_id, queued_at) values (gen_random_uuid(), $2, current_date - $3::int, $1, now() - make_interval(days => $3::int))", [
          org,
          owner.id,
          days,
        ]),
      );
    }
    const removed = await asAdmin(async (q) => (await q<{ n: number }>("select app.staff_mail_purge_rows(5000) as n")).rows[0].n);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await asAdmin(async (q) => (await q<{ e: string }>("select email as e from app.invitation_email_sends where organization_id = $1", [org])).rows.map((r) => r.e))).toEqual([
      "purge29@example.test",
    ]);
    expect(await asAdmin((q) => count(q, "select 1 from app.report_schedule_sends where organization_id = $1 and day = current_date - 89", [org]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.report_schedule_sends where organization_id = $1", [org]))).toBe(1);
    // the wrapper the cron calls runs it now that it exists; nobody but the server may call either
    await asAdmin((q) => q("select app.run_staff_mail_purge()"));
    const cron = await asAdmin(async (q) => {
      const has = (await q<{ n: number }>("select count(*)::int as n from pg_extension where extname = 'pg_cron'")).rows[0].n;
      return has ? (await q<{ command: string }>("select command from cron.job where jobname = 'crm-staff-mail-purge'")).rows[0]?.command : "no pg_cron";
    });
    expect(["select app.run_staff_mail_purge();", "no pg_cron"]).toContain(cron);
    expect((await pgError(asUser(owner.id, (q) => q("select app.staff_mail_purge_rows(1)")))).code).toBe("42501");
  });
});
