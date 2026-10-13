import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

// Owner, 13 October 2026 (migration 0163): a new lead in a suspended business tells its owner a count
// only; a cancelled business's public pages are closed; a closed business changes no settings or
// membership. All of it is OFF until the platform owner switches the notices on.
const staffIds: string[] = [];
afterAll(async () => {
  await asAdmin(async (q) => {
    await q("update app.suspension_cancel_settings set lead_notices = false, enabled = false where id");
    await q("delete from app.platform_staff where user_id = any($1)", [staffIds]);
  });
  await closePool();
});

type U = { id: string; email: string };

const FIRST = (name: string) => `נכנס ליד חדש ל${name}. כדי לראות אותו, חדשו את המנוי.`;
const DAILY = (n: number, name: string) => `${n} לידים מחכים לכם ב${name}. כדי לראות אותם, חדשו את המנוי.`;

const setStatus = (org: string, status: string) => asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));

const submit = (token: string, name: string, phone: string, ipHash: string | null = null) =>
  asService(async (q) => {
    const res = await q<{ result: { status: string } }>("select public.intake_submit($1, 'form', $2, $3, null, false) as result", [
      token,
      JSON.stringify({ full_name: name, phone, message: "תוכן סודי" }),
      ipHash,
    ]);
    return res.rows[0].result;
  });

/** The plan notices a user got in a business (entity 'subscription'), oldest first. */
const planNotices = (org: string, userId: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ title: string; body: string | null; type: string; entity_type: string; entity_id: string }>(
          "select title, body, type, entity_type, entity_id from public.notifications where organization_id = $1 and user_id = $2 and entity_type = 'subscription' order by created_at, id",
          [org, userId],
        )
      ).rows,
  );

const runDaily = (org: string, at: Date) =>
  asAdmin(async (q) => (await q<{ r: Record<string, unknown> }>("select app.run_suspended_lead_notices($1::timestamptz, $2) as r", [at.toISOString(), org])).rows[0].r);
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** A business with an owner, an admin and a member, and a public form. */
async function business(label: string) {
  const owner = await createUser(`${label}-owner`);
  const name = `עסק ${label}`;
  const org = await createOrg(owner.id, name);
  const admin = await addMember(org, owner.id, "admin", `${label}-admin`);
  const member = await addMember(org, owner.id, "member", `${label}-member`);
  const form = await asUser(owner.id, async (q) => (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס באתר') returning id, token", [org])).rows[0]);
  return { org, name, owner, admin, member, form };
}

describe("new-lead notices of a suspended business, and the closed business's public pages", () => {
  let pOwner: U, pSupport: U;

  beforeAll(async () => {
    pOwner = await createUser("ln-platform-owner");
    pSupport = await createUser("ln-platform-support");
    staffIds.push(pOwner.id, pSupport.id);
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'owner') on conflict (user_id) do update set role = excluded.role", [pOwner.id]);
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [pSupport.id]);
    });
  });

  it("off: a lead into a suspended business tells nobody and counts nothing", async () => {
    const b = await business("ln-off");
    await setStatus(b.org, "suspended");
    expect((await submit(b.form.token, "דנה", "050-1110001")).status).toBe("accepted");
    expect(await planNotices(b.org, b.owner.id)).toEqual([]);
    expect(await runDaily(b.org, plusDays(new Date(), 2))).toEqual({ enabled: false });
    const waiting = await asAdmin(async (q) => (await q<{ n: number }>("select leads_waiting as n from app.org_suspensions where organization_id = $1 and ended_at is null", [b.org])).rows[0].n);
    expect(waiting).toBe(0);
  });

  it("only the platform owner switches it, with a second factor, and it is logged", async () => {
    expect((await pgError(asMfaUser(pSupport.id, (q) => q("select public.platform_set_suspended_lead_notices(true)")))).code).toBe("42501");
    expect((await pgError(asUser(pOwner.id, (q) => q("select public.platform_set_suspended_lead_notices(true)")))).code).toBe("42501");
    const status = await asMfaUser(pSupport.id, async (q) => (await q<{ s: { enabled: boolean } }>("select public.platform_suspended_lead_notices_status() as s")).rows[0].s);
    expect(status.enabled).toBe(false);
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_suspended_lead_notices(true)"));
    const logged = await asAdmin(async (q) =>
      Number((await q<{ n: string }>("select count(*) as n from app.platform_log where action = 'suspended_lead_notices.switch' and actor_id = $1", [pOwner.id])).rows[0].n),
    );
    expect(logged).toBe(1);
  });

  it("on: the owner only, a count only; the first lead at once, then at most one a day with the count", async () => {
    const b = await business("ln-on");
    const other = await business("ln-other");
    await setStatus(b.org, "suspended");

    expect((await submit(b.form.token, "דנה ברק", "050-2220001")).status).toBe("accepted");
    expect(await planNotices(b.org, b.owner.id)).toEqual([{ title: FIRST(b.name), body: null, type: "system", entity_type: "subscription", entity_id: b.org }]);
    for (const who of [b.admin, b.member]) {
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and user_id = $2 and created_at > now() - interval '1 minute'", [b.org, who.id]))).toBe(0);
    }

    await submit(b.form.token, "רון לוי", "050-2220002");
    await submit(b.form.token, "מיכל כהן", "050-2220003");
    expect(await planNotices(b.org, b.owner.id)).toHaveLength(1);
    // the same local day as the first notice: nothing more
    expect(await runDaily(b.org, new Date())).toEqual({ enabled: true, sent: 0 });
    // the next day: one notice with the count, once
    expect(await runDaily(b.org, plusDays(new Date(), 1))).toEqual({ enabled: true, sent: 1 });
    expect(await runDaily(b.org, plusDays(new Date(), 1.1))).toEqual({ enabled: true, sent: 0 });
    const sent = await planNotices(b.org, b.owner.id);
    expect(sent.map((n) => n.title)).toEqual([FIRST(b.name), DAILY(2, b.name)]);
    // no detail of any lead anywhere in what the owner got
    const all = await asAdmin(async (q) => (await q<{ t: string }>("select title || coalesce(body, '') as t from public.notifications where organization_id = $1 and user_id = $2", [b.org, b.owner.id])).rows.map((r) => r.t).join(" "));
    for (const secret of ["דנה", "רון", "מיכל", "050-222", "0502220", "תוכן סודי", "טופס באתר"]) expect(all).not.toContain(secret);
    // nothing waiting, nothing sent
    expect(await runDaily(b.org, plusDays(new Date(), 3))).toEqual({ enabled: true, sent: 0 });

    // the push carries the title and the business name only, and no lead buttons
    await asAdmin((q) => q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example/ln', 'k', 'a')", [b.owner.id]));
    await asAdmin((q) => q("update public.notifications set pushed_at = null where organization_id = $1 and user_id = $2 and entity_type = 'subscription'", [b.org, b.owner.id]));
    const pushed = await asService(async (q) => (await q<{ r: Array<Record<string, unknown>> }>("select public.claim_push_notifications(500) as r")).rows[0].r);
    const mine = pushed.filter((p) => p.organization_id === b.org);
    expect(mine.length).toBe(2);
    for (const p of mine) {
      expect(p.user_id).toBe(b.owner.id);
      expect(p.lead_actions).toBe(false);
      expect(p.entity_type).toBe("subscription");
      expect(JSON.stringify(p)).not.toMatch(/דנה|רון|מיכל|050-222/);
    }

    // another business is untouched
    expect((await submit(other.form.token, "ליד רגיל", "050-2220009")).status).toBe("accepted");
    expect(await planNotices(other.org, other.owner.id)).toEqual([]);
  });

  it("stops when the business pays, and when it is cancelled; a new suspension starts afresh", async () => {
    const b = await business("ln-stop");
    await setStatus(b.org, "suspended");
    await submit(b.form.token, "א", "050-3330001");
    await submit(b.form.token, "ב", "050-3330002");
    await setStatus(b.org, "active");
    expect(await runDaily(b.org, plusDays(new Date(), 1))).toMatchObject({ sent: 0 });
    await submit(b.form.token, "ג", "050-3330003");
    expect(await planNotices(b.org, b.owner.id)).toHaveLength(1);

    // suspended again: a new first notice
    await setStatus(b.org, "suspended");
    await submit(b.form.token, "ד", "050-3330004");
    await submit(b.form.token, "ה", "050-3330005");
    expect((await planNotices(b.org, b.owner.id)).map((n) => n.title)).toEqual([FIRST(b.name), FIRST(b.name)]);
    await setStatus(b.org, "cancelled");
    expect(await runDaily(b.org, plusDays(new Date(), 1))).toMatchObject({ sent: 0 });
    expect(await planNotices(b.org, b.owner.id)).toHaveLength(2);
  });

  it("a cancelled business: the form shows only the inactive marker, and a submit stores nothing at all", async () => {
    const b = await business("ln-cancelled");
    await setStatus(b.org, "cancelled");
    const form = await asService(async (q) => (await q<{ f: unknown }>("select public.intake_form($1) as f", [b.form.token])).rows[0].f);
    expect(form).toEqual({ inactive: true });
    const before = await asAdmin(async (q) => ({
      subs: await count(q, "select 1 from public.form_submissions where organization_id = $1", [b.org]),
      leads: await count(q, "select 1 from public.leads where organization_id = $1", [b.org]),
      notes: await count(q, "select 1 from public.notifications where organization_id = $1", [b.org]),
      events: await count(q, "select 1 from public.outbox_events where organization_id = $1", [b.org]),
    }));
    for (const spam of [false, true]) {
      const err = await pgError(
        asService((q) => q("select public.intake_submit($1, 'form', $2, 'iphash-ln', 'agent', $3)", [b.form.token, JSON.stringify({ full_name: "x", phone: "050-4440001" }), spam])),
      );
      expect(err.hint).toBe("org:read_only");
    }
    const after = await asAdmin(async (q) => ({
      subs: await count(q, "select 1 from public.form_submissions where organization_id = $1", [b.org]),
      leads: await count(q, "select 1 from public.leads where organization_id = $1", [b.org]),
      notes: await count(q, "select 1 from public.notifications where organization_id = $1", [b.org]),
      events: await count(q, "select 1 from public.outbox_events where organization_id = $1", [b.org]),
    }));
    expect(after).toEqual(before);
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where ip_hash = 'iphash-ln'"))).toBe(0);
    // open again: the form is back
    await setStatus(b.org, "active");
    const open = await asService(async (q) => (await q<{ f: Record<string, unknown> }>("select public.intake_form($1) as f", [b.form.token])).rows[0].f);
    expect(open.inactive).toBeUndefined();
    expect(Array.isArray(open.fields)).toBe(true);
    // the one rule for every public page
    const rule = (status: string) =>
      setStatus(b.org, status).then(() => asAdmin(async (q) => (await q<{ o: boolean }>("select app.org_public_pages_open($1) as o", [b.org])).rows[0].o));
    expect(await rule("read_only")).toBe(true);
    expect(await rule("suspended")).toBe(true);
    expect(await rule("cancelled")).toBe(false);
  });

  it("a closed business changes no settings and no membership; read_only and active still do", async () => {
    const b = await business("ln-writes");
    const target = await addMember(b.org, b.owner.id, "member", "ln-writes-target");
    const attempts = async () =>
      asUser(b.owner.id, async (q) => ({
        rename: (await q("update public.organizations set name = name, record_visibility = record_visibility where id = $1", [b.org])).rowCount! > 0,
        role: (await q("update public.memberships set role = role where organization_id = $1 and user_id = $2", [b.org, target.id])).rowCount! > 0,
        invite: (await q("update public.invitations set revoked_at = revoked_at where organization_id = $1", [b.org])).rowCount! > 0,
        grant: (await q("update public.support_access_grants set revoked_at = revoked_at where organization_id = $1", [b.org])).rowCount! > 0,
      }));
    await asUser(b.owner.id, (q) => q("select public.create_invitation($1, 'ln-writes-invite@example.test', 'member')", [b.org]));
    await asUser(b.owner.id, (q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [b.org]));

    for (const state of ["active", "read_only"]) {
      await setStatus(b.org, state);
      expect(await attempts(), state).toEqual({ rename: true, role: true, invite: true, grant: true });
    }
    for (const state of ["suspended", "cancelled"]) {
      await setStatus(b.org, state);
      expect(await attempts(), state).toEqual({ rename: false, role: false, invite: false, grant: false });
      expect(await asUser(b.owner.id, async (q) => (await q("delete from public.memberships where organization_id = $1 and user_id = $2", [b.org, target.id])).rowCount), state).toBe(0);
      expect(await asUser(b.owner.id, async (q) => (await q("delete from public.invitations where organization_id = $1", [b.org])).rowCount), state).toBe(0);
      const grant = await pgError(asUser(b.owner.id, (q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [b.org])));
      expect(grant.code, state).toBe("42501");
      const transfer = await pgError(asUser(b.owner.id, (q) => q("select public.transfer_ownership($1, $2)", [b.org, b.admin.id])));
      expect(transfer.hint, state).toBe("org:suspended");
    }
    // a member of a closed business sees no membership row (0161), so cannot leave it either until it is open
    expect(await asUser(b.member.id, async (q) => (await q("delete from public.memberships where organization_id = $1 and user_id = $2", [b.org, b.member.id])).rowCount)).toBe(0);
    // read_only and active: ownership still moves
    await setStatus(b.org, "read_only");
    await asUser(b.owner.id, (q) => q("select public.transfer_ownership($1, $2)", [b.org, b.admin.id]));
    expect(await asAdmin(async (q) => (await q<{ r: string }>("select role::text as r from public.memberships where organization_id = $1 and user_id = $2", [b.org, b.admin.id])).rows[0].r)).toBe("owner");
  });

  it("a closed business pushes nothing stored before the closing; a member cannot delete what they cannot read", async () => {
    const b = await business("ln-push");
    await asAdmin(async (q) => {
      await q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example/lnp', 'k', 'a')", [b.member.id]);
      await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'lead_new', 'ליד חדש: דנה')", [b.org, b.member.id]);
    });
    await setStatus(b.org, "suspended");
    const pushed = await asService(async (q) => (await q<{ r: Array<Record<string, unknown>> }>("select public.claim_push_notifications(500) as r")).rows[0].r);
    expect(pushed.filter((p) => p.organization_id === b.org)).toEqual([]);
    expect(await asUser(b.member.id, async (q) => (await q("delete from public.notifications where organization_id = $1", [b.org])).rowCount)).toBe(0);
    await setStatus(b.org, "active");
    expect(await asUser(b.member.id, async (q) => (await q("delete from public.notifications where organization_id = $1", [b.org])).rowCount)).toBe(1);
  });

  it("a suspended business takes leads through CAP-09's intake, and its waiting rotation leads stay unassigned", async () => {
    const b = await business("ln-rotation");
    await setStatus(b.org, "suspended");
    expect((await submit(b.form.token, "ליד ממתין", "050-5550001")).status).toBe("accepted");
    const lead = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.leads where organization_id = $1 and full_name = 'ליד ממתין'", [b.org])).rows[0].id);
    await asAdmin(async (q) => {
      await q("update public.leads set owner_id = null where id = $1", [lead]);
      await q("insert into app.rotation_waiting_leads (lead_id, organization_id, next_check_at) values ($1, $2, now() - interval '1 minute') on conflict (lead_id) do update set resolved_at = null, next_check_at = excluded.next_check_at", [lead, b.org]);
      await q("select app.assign_waiting_rotation_leads()");
    });
    const state = await asAdmin(async (q) =>
      (await q<{ owner: string | null; resolved: Date | null; later: boolean }>(
        "select l.owner_id as owner, w.resolved_at as resolved, w.next_check_at > now() as later from public.leads l join app.rotation_waiting_leads w on w.lead_id = l.id where l.id = $1",
        [lead],
      )).rows[0],
    );
    expect(state).toEqual({ owner: null, resolved: null, later: true });
  });

  it("the suspension start is set only by the server when the business is suspended", async () => {
    for (const role of ["authenticated", "anon", "service_role"]) {
      const can = await asAdmin(async (q) =>
        (await q<{ c: boolean }>("select has_table_privilege($1, 'app.org_suspensions', 'INSERT, UPDATE, DELETE, SELECT') as c", [role])).rows[0].c,
      );
      expect(can, role).toBe(false);
    }
    // no function writes suspended_at, apart from the trigger's insert
    const writers = await asAdmin(async (q) =>
      (await q<{ p: string }>("select p.proname as p from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app', 'public') and p.prosrc ~* 'suspended_at\\s*=' order by 1")).rows.map((r) => r.p),
    );
    expect(writers).toEqual([]);
  });
});
