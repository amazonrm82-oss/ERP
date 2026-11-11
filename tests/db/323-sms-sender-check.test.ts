import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asService, asUser, closePool, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

afterAll(closePool);

const start = (user: string, org: string) =>
  asUser(user, async (q) => (await q<{ r: Answer }>("select public.sms_sender_verify_start($1) as r", [org])).rows[0].r);
const verify = (user: string, org: string, code: string) =>
  asUser(user, async (q) => (await q<{ r: Answer }>("select public.sms_sender_verify($1, $2) as r", [org, code])).rows[0].r);
const checkJob = (org: string) =>
  asAdmin(
    async (q) =>
      (await q<{ id: string; payload: Answer }>("select id, payload from app.jobs where organization_id = $1 and payload ? 'sender_check_id' order by created_at desc limit 1", [org]))
        .rows[0],
  );
const claim = async (id: string): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
const issue = (job: Claimed) => asService(async (q) => (await q<{ r: Answer }>("select public.sms_sender_code_issue($1, $2) as r", [job.id, job.lease])).rows[0].r);
const maySend = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Answer }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
const settings = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ name: string | null; phone: string | null; approved: boolean }>(
          "select sms_sender_name as name, sms_sender_verified_phone as phone, sms_sender_approved_at is not null as approved from public.org_message_settings where organization_id = $1",
          [org],
        )
      ).rows[0],
  );
const effective = (org: string) => asAdmin(async (q) => (await q<{ s: string | null }>("select app.sms_effective_sender($1) as s", [org])).rows[0].s);
const saveName = (user: string, org: string, value: string | null) =>
  asUser(user, async (q) => {
    const updated = await q("update public.org_message_settings set sms_sender_name = $2 where organization_id = $1 returning organization_id", [org, value]);
    if (updated.rowCount === 0) await q("insert into public.org_message_settings (organization_id, sms_sender_name) values ($1, $2)", [org, value]);
  });

/**
 * SMS-01b (owner (211) א): a sender number only when it is the business's own phone, verified once by an SMS code (hashed,
 * 10 minutes, 5 wrong tries then a 30-minute cool-down, through the queue as a verification_code); a letter name waits for
 * the platform's approval; until then the verified number, else the platform's default.
 */
describe("SMS sender verification and approval (SMS-01b)", () => {
  let owner: { id: string }, member: { id: string }, staff: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("sms-check-owner");
    org = await createOrg(owner.id, "עסק אימות");
    member = await addMember(org, owner.id, "member", "sms-check-member");
    staff = await createUser("sms-check-staff");
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '052-7770001' where id = $1", [org]);
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [staff.id]);
      // these tests are not about sending hours
      await q(
        "insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '24:00', false) on conflict (organization_id) do nothing",
        [org],
      );
    });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(() => asAdmin((q) => q("delete from app.platform_staff where user_id = $1", [staff.id])));

  it("a sender number must be the business's own phone", async () => {
    expect((await pgError(saveName(owner.id, org, "0529999999"))).hint).toBe("sms_sender:not_own_phone");
    await saveName(owner.id, org, "0527770001");
    expect((await settings(org)).name).toBe("0527770001");
    // not used until verified
    expect(await effective(org)).toBeNull();
  });

  it("the code goes through the queue to the business's phone, is hashed, and verifies the number once", async () => {
    expect((await pgError(start(member.id, org))).code).toBe("42501");
    expect(await start(owner.id, org)).toEqual({ ok: true });
    const job = await checkJob(org);
    expect(Object.keys(job.payload).sort()).toEqual(["channel", "message_type", "sender_check_id"]);
    expect(job.payload).toMatchObject({ channel: "sms", message_type: "verification_code" });
    const claimed = await claim(job.id);
    // review (1): no code before the send check passed this lease
    expect(await issue(claimed)).toEqual({ refused: "stale" });
    expect(await maySend(claimed)).toEqual({ may_send: true });
    // the code is made only when it goes, once a lease; only its hash is kept
    const issued = await issue(claimed);
    expect(issued).toMatchObject({ phone: "+972527770001" });
    const code = String(issued.code);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(await issue(claimed)).toEqual({ refused: "issued" });
    const stored = await asAdmin(async (q) => (await q<{ h: string }>("select code_hash as h from app.sms_sender_checks where id = $1", [job.payload.sender_check_id])).rows[0].h);
    expect(stored).not.toContain(code);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // never counted in the SMS quota
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.sms_quota_months where organization_id = $1", [org])).rows[0].n)).toBe(0);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verify(owner.id, org, wrong)).toEqual({ ok: false, reason: "wrong", left: 4 });
    // review (1): the provider failed and the job is tried again on a new lease: a new code, the old one stops working
    await asAdmin((q) => q("update app.jobs set status = 'queued', lease_id = null, locked_until = null, next_run_at = now() where id = $1", [job.id]));
    const again = await claim(job.id);
    expect(await maySend(again)).toEqual({ may_send: true });
    const reissued = String((await issue(again)).code);
    expect(reissued).toMatch(/^[0-9]{6}$/);
    if (reissued !== code) expect(await verify(owner.id, org, code)).toMatchObject({ ok: false, reason: "wrong", left: 3 });
    expect(await verify(owner.id, org, reissued)).toEqual({ ok: true });
    expect((await settings(org)).phone).toBe("+972527770001");
    expect(await effective(org)).toBe("+972527770001");
    // the number counts only while it is the business's phone
    await asAdmin((q) => q("update public.organizations set phone = '052-7770002' where id = $1", [org]));
    expect(await effective(org)).toBeNull();
    await asAdmin((q) => q("update public.organizations set phone = '052-7770001' where id = $1", [org]));
    expect(await effective(org)).toBe("+972527770001");
  });

  it("an expired code is refused; five wrong codes end the check and cool the business down", async () => {
    const other = await createUser("sms-check-owner-2");
    const org2 = await createOrg(other.id, "עסק קירור");
    await asAdmin((q) => q("update public.organizations set phone = '052-7770003' where id = $1", [org2]));
    expect(await start(other.id, org2)).toEqual({ ok: true });
    const claimed = await claim((await checkJob(org2)).id);
    await asAdmin((q) =>
      q("insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '24:00', false) on conflict (organization_id) do nothing", [org2]),
    );
    expect(await maySend(claimed)).toEqual({ may_send: true });
    const code = String((await issue(claimed)).code);
    await asAdmin((q) => q("update app.sms_sender_checks set expires_at = now() - interval '1 second' where organization_id = $1", [org2]));
    expect(await verify(other.id, org2, code)).toEqual({ ok: false, reason: "expired" });
    await asAdmin((q) => q("update app.sms_sender_checks set expires_at = now() + interval '10 minutes' where organization_id = $1", [org2]));
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) expect((await verify(other.id, org2, wrong)).reason).toBe("wrong");
    // the check is dead and the business cools down: the right code and a new start are both refused
    expect((await verify(other.id, org2, code)).reason).toBe("cooldown");
    expect((await start(other.id, org2)).reason).toBe("cooldown");
    await asAdmin((q) => q("update app.sms_sender_checks set last_attempt_at = now() - interval '31 minutes' where organization_id = $1", [org2]));
    expect(await verify(other.id, org2, code)).toEqual({ ok: false, reason: "no_code" });
    expect(await start(other.id, org2)).toEqual({ ok: true });
  });

  it("a letter name waits for the platform's approval; until then the verified number is used", async () => {
    await saveName(owner.id, org, "MyShop");
    expect(await settings(org)).toMatchObject({ name: "MyShop", approved: false });
    expect(await effective(org)).toBe("+972527770001");
    // a person cannot approve; only platform staff with the second step
    expect((await pgError(asUser(owner.id, (q) => q("select public.platform_set_sms_sender_approval($1, 'MyShop', true)", [org])))).code).toBe("42501");
    expect((await pgError(asUser(staff.id, (q) => q("select public.platform_set_sms_sender_approval($1, 'MyShop', true)", [org])))).code).toBe("42501");
    const pending = await asMfaUser(staff.id, async (q) => (await q<{ r: Array<Record<string, unknown>> }>("select public.platform_list_sms_sender_pending() as r")).rows[0].r);
    expect(pending.find((p) => p.organization_id === org)).toMatchObject({ name: "MyShop" });
    expect(
      await asMfaUser(staff.id, async (q) => (await q<{ r: Answer }>("select public.platform_set_sms_sender_approval($1, 'Other', true) as r", [org])).rows[0].r),
    ).toEqual({ ok: false, reason: "changed" });
    expect(
      await asMfaUser(staff.id, async (q) => (await q<{ r: Answer }>("select public.platform_set_sms_sender_approval($1, 'MyShop', true) as r", [org])).rows[0].r),
    ).toEqual({ ok: true, approved: true });
    expect(await effective(org)).toBe("MyShop");
    const logged = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from app.platform_log where organization_id = $1 and action = 'sms_sender.approve'", [org])).rows[0].n,
    );
    expect(logged).toBe(1);
    // a new name waits again
    await saveName(owner.id, org, "MyShop2");
    expect(await settings(org)).toMatchObject({ name: "MyShop2", approved: false });
    expect(await effective(org)).toBe("+972527770001");
    // review (3): a rejection is kept, leaves the pending list, is told once to the owners, and a new name clears it
    expect(
      await asMfaUser(staff.id, async (q) => (await q<{ r: Answer }>("select public.platform_set_sms_sender_approval($1, 'MyShop2', false) as r", [org])).rows[0].r),
    ).toEqual({ ok: true, approved: false });
    const rejected = await asAdmin(
      async (q) => (await q<{ r: boolean }>("select sms_sender_rejected_at is not null as r from public.org_message_settings where organization_id = $1", [org])).rows[0].r,
    );
    expect(rejected).toBe(true);
    const stillPending = await asMfaUser(staff.id, async (q) => (await q<{ r: Array<Record<string, unknown>> }>("select public.platform_list_sms_sender_pending() as r")).rows[0].r);
    expect(stillPending.find((p) => p.organization_id === org)).toBeUndefined();
    const notices = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and title = 'שם השולח ב-SMS נדחה'", [org])).rows[0].n,
    );
    expect(notices).toBe(1);
    expect(await effective(org)).toBe("+972527770001");
    await saveName(owner.id, org, "MyShop3");
    expect(
      await asAdmin(
        async (q) => (await q<{ r: boolean }>("select sms_sender_rejected_at is null as r from public.org_message_settings where organization_id = $1", [org])).rows[0].r,
      ),
    ).toBe(true);
    // review (8): who approved is never selected by a client
    expect((await pgError(asUser(owner.id, (q) => q("select sms_sender_approved_by from public.org_message_settings where organization_id = $1", [org])))).code).toBe("42501");
    // a person never writes the server columns
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_message_settings set sms_sender_approved_at = now() where organization_id = $1", [org])))).code).toBe(
      "42501",
    );
  });

  it("review (6): a sender check's code is not held by HEB-09's pause; review (5): an SMS waiting for the flag is a cap waiter", async () => {
    const o = await createUser("sms-check-pause");
    const po = await createOrg(o.id, "עסק עצור לאימות");
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '052-7770009' where id = $1", [po]);
      await q("insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '24:00', false)", [po]);
    });
    await asUser(o.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'עצירה')", [po]));
    expect(await start(o.id, po)).toEqual({ ok: true });
    expect(await maySend(await claim((await checkJob(po)).id))).toEqual({ may_send: true });
    // a customer SMS of a business without the flag waits as a cap waiter, so the owners' cancel takes it
    await asUser(o.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [po]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": false}'::jsonb where organization_id = $1", [po]));
    const leadId = await insertLead(o.id, po, { phone: "0527770010" });
    const sms = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [po, JSON.stringify({ channel: "sms", message_type: "requested_document", lead_id: leadId })]))
          .rows[0].id,
    );
    expect(await maySend(await claim(sms))).toEqual({ may_send: false, reason: "sms_off", retry: true });
    expect(await asAdmin(async (q) => (await q<{ w: string | null }>("select cap_wait as w from app.jobs where id = $1", [sms])).rows[0].w)).toBe("sms_off");
    await asUser(o.id, (q) => q("select public.message_cancel_waiting($1, 'sms')", [po]));
    expect(await asAdmin(async (q) => (await q<{ s: string }>("select status as s from app.jobs where id = $1", [sms])).rows[0].s)).toBe("refused");
  });

  it("the payload of a check carries nothing a record does; the code is only for a live lease", async () => {
    const bad = await pgError(
      asAdmin((q) =>
        q("select app.enqueue_job($1, 'message.send', $2::jsonb, null)", [
          org,
          JSON.stringify({ channel: "sms", message_type: "marketing", sender_check_id: "11111111-1111-4111-8111-111111111111" }),
        ]),
      ),
    );
    expect(bad.message).toBeTruthy();
    // review (7): on sms a verification code names a sender check, never a record
    const lead = await insertLead(owner.id, org, { phone: "0527770011" });
    expect(
      (
        await pgError(
          asAdmin((q) => q("select app.enqueue_job($1, 'message.send', $2::jsonb, null)", [org, JSON.stringify({ channel: "sms", message_type: "verification_code", lead_id: lead })])),
        )
      ).message,
    ).toBeTruthy();
    expect(await asService(async (q) => (await q<{ r: Answer }>("select public.sms_sender_code_issue($1, $2) as r", ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"])).rows[0].r)).toEqual({
      refused: "stale",
    });
    const rights = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; issue: boolean; start: boolean }>(
            `select r as role, has_function_privilege(r, 'public.sms_sender_code_issue(uuid,uuid)', 'execute') as issue,
                    has_function_privilege(r, 'public.sms_sender_verify_start(uuid)', 'execute') as start
               from unnest(array['anon', 'authenticated', 'service_role']) r order by 1`,
          )
        ).rows,
    );
    expect(rights).toEqual([
      { role: "anon", issue: false, start: false },
      { role: "authenticated", issue: false, start: true },
      { role: "service_role", issue: true, start: true },
    ]);
  });

  it("RVW-80: finishing a verification code writes no message row and no warning; a customer's SMS is still recorded", async () => {
    const o = await createUser("sms-check-finish");
    const fo = await createOrg(o.id, "עסק סיום אימות");
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '052-7770030' where id = $1", [fo]);
      await q("insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '24:00', false)", [fo]);
    });
    expect(await start(o.id, fo)).toEqual({ ok: true });
    const claimed = await claim((await checkJob(fo)).id);
    expect(await maySend(claimed)).toEqual({ may_send: true });
    const notices: string[] = [];
    const client = new Client({ connectionString: TEST_DB_URL });
    client.on("notice", (n) => notices.push(n.message ?? ""));
    await client.connect();
    try {
      const done = await client.query<{ r: string }>("select public.finish_job($1, $2, true, null, false, true, 'fake', 'check-1', null) as r", [claimed.id, claimed.lease]);
      expect(done.rows[0].r).toBe("done");
    } finally {
      await client.end();
    }
    expect(await asAdmin(async (q) => (await q<{ o: string | null }>("select message_outcome as o from app.jobs where id = $1", [claimed.id])).rows[0].o)).toBe("sent");
    expect(notices.filter((n) => n.includes("jobs_record_message"))).toEqual([]);
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.messages where job_id = $1", [claimed.id])).rows[0].n)).toBe(0);
    // an SMS to a lead is still recorded on its timeline
    const leadId = await insertLead(o.id, fo, { phone: "0527770031" });
    const sms = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [fo, JSON.stringify({ channel: "sms", message_type: "requested_document", lead_id: leadId })]))
          .rows[0].id,
    );
    const job = await claim(sms);
    expect(await maySend(job)).toEqual({ may_send: true });
    await asService((q) => q("select public.finish_job($1, $2, true, null, false, true, 'fake', 'sms-1', null)", [job.id, job.lease]));
    expect(await asAdmin(async (q) => (await q<{ lead_id: string; status: string }>("select lead_id, status from public.messages where job_id = $1", [job.id])).rows)).toEqual([
      { lead_id: leadId, status: "sent" },
    ]);
  });

  it("RVW-81: a business whose plan has no SMS cannot ask for a verification code", async () => {
    const o = await createUser("sms-check-noflag");
    const nf = await createOrg(o.id, "עסק בלי SMS");
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '052-7770020' where id = $1", [nf]);
      await q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": false}'::jsonb where organization_id = $1", [nf]);
    });
    const refused = await pgError(start(o.id, nf));
    expect({ code: refused.code, hint: refused.hint }).toEqual({ code: "P0001", hint: "feature:sms" });
    // nothing was opened or queued
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.sms_sender_checks where organization_id = $1", [nf])).rows[0].n)).toBe(0);
    expect(await checkJob(nf)).toBeUndefined();
    // with the flag back the code goes as before
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'sms' where organization_id = $1", [nf]));
    expect(await start(o.id, nf)).toEqual({ ok: true });
  });
});
