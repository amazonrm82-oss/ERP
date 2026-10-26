import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own (the same as 242-244)
const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );
beforeAll(() => setKey(KEY));
afterAll(async () => {
  await setKey(KEY);
  await closePool();
});

type U = { id: string; email: string };
type Row = Record<string, unknown>;

/**
 * PRV-01: the retention policy. Off by default; owners and admins turn it on after a preview; a round lists the leads that
 * will be inactive within 14 days and tells every owner and admin; 14 days later the still-inactive ones go to the recycle
 * bin; after the purge their audit details are erased (not as the person's request) with one count-only line.
 */
describe("lead retention policy (PRV-01)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  const leads: Record<string, string> = {};

  const status = (who: U) => asUser(who.id, async (q) => (await q<{ r: Row }>("select public.lead_retention_status($1) as r", [org])).rows[0].r);
  const preview = (who: U, months: number) =>
    asUser(who.id, async (q) => (await q<{ r: Row }>("select public.lead_retention_preview($1, $2) as r", [org, months])).rows[0].r);
  const setPolicy = (who: U, enabled: boolean, months: number | null, confirm: boolean, inOrg = org) =>
    asUser(who.id, async (q) =>
      (await q<{ r: Row }>("select public.lead_retention_set($1, $2, $3, $4) as r", [inOrg, enabled, months, confirm])).rows[0].r,
    );
  const keep = (who: U, lead: string) => asUser(who.id, (q) => q("select public.lead_retention_keep($1, $2)", [org, lead]));
  const list = (who: U) =>
    asUser(who.id, async (q) => (await q<{ r: { leads: { id: string; kept_at: string | null }[] } & Row }>("select public.lead_retention_round_leads($1) as r", [org])).rows[0].r);
  const run = () => asAdmin(async (q) => (await q<{ r: Row }>("select app.run_lead_retention() as r")).rows[0].r);
  // touch_row keeps created_at: back-dating is a test-only write with the triggers off
  const raw = (sql: string, params: unknown[]) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(sql, params);
    });
  const ago = (lead: string, months: number) => raw("update public.leads set created_at = now() - make_interval(months => $2) where id = $1", [lead, months]);
  const deletedAt = async (lead: string) =>
    asAdmin(async (q) => (await q<{ d: string | null }>("select deleted_at as d from public.leads where id = $1", [lead])).rows[0]?.d);

  beforeAll(async () => {
    owner = await createUser("rt-owner");
    org = await createOrg(owner.id, "עסק שמירה");
    admin = await addMember(org, owner.id, "admin", "rt-admin");
    manager = await addMember(org, owner.id, "manager", "rt-manager");
    member = await addMember(org, owner.id, "member", "rt-member");
    viewer = await addMember(org, owner.id, "viewer", "rt-viewer");
    outsider = await createUser("rt-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");

    // 13 months old and untouched: inactive
    for (const [name, phone] of [
      ["old1", "050-7200001"],
      ["old2", "050-7200002"],
      ["old3", "050-7200003"],
      ["old4", "050-7200004"],
      ["optout", "050-7200005"],
      ["again", "050-7200007"],
      ["merged", "050-7200008"],
      ["forever", "050-7200009"],
    ]) {
      leads[name] = await insertLead(owner.id, org, { full_name: `ישן ${name}`, phone });
      await ago(leads[name], 13);
    }
    // 11.7 months: inactive within the 14 days of notice
    leads.soon = await insertLead(owner.id, org, { full_name: "כמעט", phone: "050-7200006" });
    await raw("update public.leads set created_at = now() - interval '12 months' + interval '7 days' where id = $1", [leads.soon]);
    // new: active
    leads.fresh = await insertLead(owner.id, org, { full_name: "חדש" });
    // old but with a recent call, a private note, an open task, a planned meeting, a recent contact stamp, converted,
    // the customer's own inquiry through a form (no author), a held meeting in the window, sample data
    for (const name of ["call", "note", "task", "meeting", "stamp", "converted", "inquiry", "held", "sample"]) {
      leads[name] = await insertLead(owner.id, org, { full_name: `פעיל ${name}`, email: `${name}@retention.test` });
      await ago(leads[name], 13);
    }
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, leads.call]));
    await asUser(owner.id, (q) =>
      q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'הערה', $2, true)", [org, leads.note]),
    );
    await asUser(owner.id, (q) => q("insert into public.tasks (organization_id, title, lead_id) values ($1, 'לחזור', $2)", [org, leads.task]));
    await asUser(owner.id, (q) =>
      q(
        "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישה', now() + interval '20 days', now() + interval '20 days 1 hour', $2)",
        [org, leads.meeting],
      ),
    );
    await raw("update public.leads set last_contacted_at = now() - interval '2 months' where id = $1", [leads.stamp]);
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'inquiry', 'חזרתי דרך הטופס', $2)", [org, leads.inquiry]),
    );
    await asUser(owner.id, (q) =>
      q(
        "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישה', now() + interval '1 day', now() + interval '1 day 1 hour', $2)",
        [org, leads.held],
      ),
    );
    await raw(
      "update public.meetings set starts_at = now() - interval '2 months', ends_at = now() - interval '2 months' + interval '1 hour', status = 'held' where lead_id = $1",
      [leads.held],
    );
    await asAdmin((q) => q("insert into app.sample_records (organization_id, lead_id, snapshot) values ($1, $2, '{}')", [org, leads.sample]));
    await asUser(owner.id, (q) => q("select public.convert_lead($1)", [leads.converted]));
    // an existing opt-out on a lead the policy will take, made while the key was missing: it stays (hashed later), its
    // erasure waits for the hash, and no erasure entry is added
    await setKey(null);
    await asUser(owner.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'withdrawn', 'manual', 'ביקש')", [
        org,
        leads.optout,
      ]),
    );
    await setKey(KEY);
    // an old lead in another business never appears here
    const foreign = await insertLead(outsider.id, otherOrg, { full_name: "זר" });
    await ago(foreign, 13);
  });

  it("the erasure core and the job are out of the API's reach", async () => {
    for (const fn of ["app.audit_erase_core(uuid, text, uuid, uuid)", "app.lead_retention_erase(uuid, uuid, timestamptz)", "app.run_lead_retention()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const can = await asAdmin(
          async (q) => (await q<{ x: boolean }>("select has_function_privilege($1, $2, 'execute') as x", [role, fn])).rows[0].x,
        );
        expect(can, `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("is off by default, and only owners and admins read or change it", async () => {
    expect(await status(owner)).toMatchObject({ enabled: false, months: null, open_round: null, last_round: null });
    for (const who of [manager, member, viewer, outsider]) {
      expect((await pgError(status(who))).code, who.email).toBe("42501");
      expect((await pgError(preview(who, 12))).code, who.email).toBe("42501");
      expect((await pgError(setPolicy(who, true, 12, true))).code, who.email).toBe("42501");
    }
    expect((await pgError(setPolicy(owner, true, 12, true, otherOrg))).code).toBe("42501");
    // the tables live in schema app: no client reads them
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.lead_retention_settings")))).code).toBe("42501");
  });

  it("needs at least 6 months and a confirmation after the preview; every change is audited", async () => {
    expect((await pgError(preview(owner, 5))).hint).toBe("retention:months");
    expect((await pgError(setPolicy(owner, true, 5, true))).hint).toBe("retention:months");
    expect((await pgError(setPolicy(owner, true, 12, false))).hint).toBe("retention:confirm");
    // inactive now: the five old ones; within the notice: also the one about to cross
    expect(await preview(admin, 12)).toEqual({ months: 12, now: 8, within_notice: 9 });
    expect(await setPolicy(admin, true, 12, true)).toEqual({ changed: true, round_cancelled: false });
    expect(await setPolicy(admin, true, 12, false)).toEqual({ changed: false });
    const audit = await asAdmin(
      async (q) =>
        (await q<{ actor_id: string; changes: Row }>("select actor_id, changes from public.audit_log where organization_id = $1 and action = 'retention_policy'", [org])).rows,
    );
    expect(audit).toEqual([
      {
        actor_id: admin.id,
        changes: { enabled: true, months: 12, previous_enabled: false, previous_months: null, round_cancelled: false },
      },
    ]);
  });

  it("a round lists the leads inactive within 14 days and tells every active owner and admin", async () => {
    expect(await run()).toMatchObject({ rounds: 1, binned: 0 });
    const s = (await status(owner)) as { open_round: { total: number; kept: number; due_at: string } };
    expect(s.open_round).toMatchObject({ total: 9, kept: 0 });
    const listed = (await list(owner)).leads.map((l) => l.id).sort();
    expect(listed).toEqual(
      [leads.old1, leads.old2, leads.old3, leads.old4, leads.optout, leads.soon, leads.again, leads.merged, leads.forever].sort(),
    );
    const notices = await asAdmin(
      async (q) =>
        (
          await q<{ user_id: string; title: string; entity_type: string }>(
            "select user_id, title, entity_type from public.notifications where organization_id = $1 and entity_type = 'lead_retention'",
            [org],
          )
        ).rows,
    );
    expect(notices.map((n) => n.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect(notices[0].title).toBe("מדיניות השמירה: 9 לידים יעברו לסל המחזור בעוד 14 יום");
    // one open round at a time
    expect(await run()).toMatchObject({ rounds: 0 });
    expect(await asAdmin((q) => count(q, "select 1 from app.lead_retention_rounds where organization_id = $1", [org]))).toBe(1);
  });

  it("'keep' takes one lead off the list and restarts its count; only owners and admins keep", async () => {
    for (const who of [manager, member, viewer, outsider]) {
      expect((await pgError(keep(who, leads.old4))).code, who.email).toBe("42501");
      expect((await pgError(list(who))).code, who.email).toBe("42501");
    }
    await keep(owner, leads.old4);
    expect((await pgError(keep(owner, leads.fresh))).hint).toBe("retention:not_listed");
    expect((await list(owner)).leads.find((l) => l.id === leads.old4)?.kept_at).toBeTruthy();
    expect(await preview(owner, 12)).toMatchObject({ now: 7 });
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'retention_keep' and entity_id = $2", [org, leads.old4])),
    ).toBe(1);
  });

  it("when due, moves the still-inactive leads to the bin and leaves out the kept and the active again", async () => {
    // old3 got a call meanwhile; soon has crossed by now (moved back a little)
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שוב', $2)", [org, leads.old3]));
    await raw("update public.leads set created_at = now() - interval '13 months' where id = $1", [leads.soon]);
    await asAdmin((q) => q("update app.lead_retention_rounds set due_at = now() - interval '1 minute' where organization_id = $1", [org]));
    expect(await run()).toMatchObject({ binned: 7 });
    for (const name of ["old1", "old2", "optout", "soon", "again", "merged", "forever"]) expect(await deletedAt(leads[name]), name).toBeTruthy();
    for (const name of ["old3", "old4", "fresh", "call", "note", "task", "meeting", "stamp", "inquiry", "held", "sample"]) {
      expect(await deletedAt(leads[name]), name).toBeNull();
    }
    expect(await status(owner)).toMatchObject({ open_round: null, last_round: { binned: 7 } });
    const done = await asAdmin(
      async (q) =>
        (await q<{ title: string }>("select title from public.notifications where organization_id = $1 and title like 'מדיניות השמירה העבירה%'", [org])).rows,
    );
    expect(done.map((d) => d.title)).toEqual(["מדיניות השמירה העבירה 7 לידים לסל המחזור", "מדיניות השמירה העבירה 7 לידים לסל המחזור"]);
    // the done notice opens the recycle bin
    expect(
      await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and entity_type = 'lead_retention_binned'", [org])),
    ).toBe(2);
  });

  it("a lead restored from the bin counts as kept", async () => {
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [leads.old2]));
    expect(await run()).toMatchObject({ restored: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from app.lead_retention_keeps where lead_id = $1", [leads.old2]))).toBe(1);
    expect(await preview(owner, 12)).toMatchObject({ now: 0 });
  });

  it("erases only the row the policy binned: not after a restore and a new delete, not a merged-away lead; a delete-forever from the bin is erased", async () => {
    const erased = (lead: string) =>
      asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'leads' and entity_id = $1 and changes = '{\"erased\": true}'::jsonb", [lead]));
    // restored and binned again by a person: no longer the policy's
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [leads.again]));
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [leads.again]));
    // restored and then removed while live (a merge deletes the duplicate this way), before the job saw the restore
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [leads.merged]));
    await asAdmin((q) => q("delete from public.leads where id = $1", [leads.merged]));
    // a person's "delete forever" while it is still in the bin from the policy: erased like the purge (accepted)
    await asAdmin((q) => q("delete from public.leads where id = $1", [leads.forever]));
    expect(await run()).toMatchObject({ restored: 1, erased: 1 });
    expect(await erased(leads.forever)).toBeGreaterThan(0);
    expect(await erased(leads.merged)).toBe(0);
    // the one binned again by a person, purged later, is not the policy's either
    await raw("update public.leads set deleted_at = now() - interval '31 days' where id = $1", [leads.again]);
    await asAdmin((q) => q("select app.purge_trash()"));
    expect(await run()).toMatchObject({ erased: 0 });
    expect(await erased(leads.again)).toBe(0);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from app.lead_retention_round_leads where lead_id = any($1) and restored_at is not null and erased_at is null", [
          [leads.again, leads.merged],
        ]),
      ),
    ).toBe(2);
  });

  it("after the purge erases the audit details, writes one count-only line and no do-not-contact entry", async () => {
    await setKey(null);
    // 31 days in the bin: the lead and the policy's own record of when it binned it move back together
    await raw(
      `with x as (update public.leads set deleted_at = now() - interval '31 days' where id = any($1) returning id, deleted_at)
       update app.lead_retention_round_leads rl set binned_at = x.deleted_at from x where rl.lead_id = x.id`,
      [[leads.old1, leads.optout, leads.soon]],
    );
    await asAdmin((q) => q("select app.purge_trash()"));
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = any($1)", [[leads.old1, leads.optout, leads.soon]]))).toBe(0);
    // the opt-out was made without the key: its lead waits like a paused erasure
    const first = await run();
    expect(first).toMatchObject({ erased: 2 });
    expect(await asAdmin((q) => count(q, "select 1 from app.lead_retention_round_leads where lead_id = $1 and erase_waits = 1", [leads.optout]))).toBe(1);
    await setKey(KEY);
    await asAdmin((q) => q("select app.consent_backfill_hashes()"));
    expect(await run()).toMatchObject({ erased: 1 });

    for (const name of ["old1", "optout", "soon"]) {
      const entries = await asAdmin(
        async (q) =>
          (await q<{ changes: Row }>(
            "select changes from public.audit_log where entity_type = 'leads' and entity_id = $1 and action not in ('erase', 'retention')",
            [leads[name]],
          )).rows,
      );
      expect(entries.length, name).toBeGreaterThan(0);
      for (const e of entries) expect(e.changes, name).toEqual({ erased: true });
      // the policy's erasure is recorded as 'retention', never as a privacy request's 'erase' (owner, 26 October 2026)
      const actions = await asAdmin(
        async (q) =>
          (await q<{ action: string; actor_id: string | null }>(
            "select action, actor_id from public.audit_log where entity_type = 'leads' and entity_id = $1 and action in ('erase', 'retention')",
            [leads[name]],
          )).rows,
      );
      expect(actions, name).toEqual([{ action: "retention", actor_id: null }]);
    }
    const lines = await asAdmin(
      async (q) =>
        (await q<{ actor_id: string | null; entity_id: string | null; changes: Row }>(
          "select actor_id, entity_id, changes from public.audit_log where organization_id = $1 and action = 'retention_purge' order by id",
          [org],
        )).rows,
    );
    expect(lines).toEqual([
      { actor_id: null, entity_id: null, changes: { count: 1 } },
      { actor_id: null, entity_id: null, changes: { count: 2 } },
      { actor_id: null, entity_id: null, changes: { count: 1 } },
    ]);
    // not the person's request: no block of any kind is written, and the existing opt-out still suppresses the address
    expect(await asAdmin((q) => count(q, "select 1 from public.consents where organization_id = $1 and source = 'erasure'", [org]))).toBe(0);
    // (a hashed address keeps its pending row with the value blanked by the backfill; none may still hold an address)
    expect(await asAdmin((q) => count(q, "select 1 from app.consent_blocklist_pending where organization_id = $1", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.consent_blocklist where organization_id = $1", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.consent_pending_address where organization_id = $1 and value is not null", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.pending_erasures where organization_id = $1 and person_request", [org]))).toBe(0);
    expect(
      await asAdmin(async (q) => (await q<{ s: boolean | null }>("select app.consent_suppressed($1, 'sms', '050-7200005') as s", [org])).rows[0].s),
    ).toBe(true);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.consents where organization_id = $1 and state = 'withdrawn' and source = 'manual'", [org])),
    ).toBe(1);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from app.pending_erasures where organization_id = $1 and person_request = false and completed_at is not null", [org]),
      ),
    ).toBe(4);
    // nothing left to do
    expect(await run()).toMatchObject({ erased: 0 });
  });

  it("changing the months or turning it off cancels the open round", async () => {
    await raw("update public.leads set created_at = now() - interval '13 months' where id = $1", [leads.fresh]);
    await run();
    expect(((await status(owner)) as { open_round: Row | null }).open_round).not.toBeNull();
    expect((await pgError(setPolicy(owner, true, 18, false))).hint).toBe("retention:confirm");
    expect(await setPolicy(owner, true, 18, true)).toEqual({ changed: true, round_cancelled: true });
    expect(((await status(owner)) as { open_round: Row | null }).open_round).toBeNull();
    // 13 months is not inactive under 18
    expect(await run()).toMatchObject({ rounds: 0 });
    await setPolicy(owner, true, 12, true);
    await run();
    expect(await setPolicy(owner, false, null, false)).toEqual({ changed: true, round_cancelled: true });
    expect(await status(owner)).toMatchObject({ enabled: false, open_round: null });
    expect(await run()).toMatchObject({ rounds: 0 });
  });

  it("a round due while the business cannot be written is cancelled, never carried out later; a new notice follows", async () => {
    await setPolicy(owner, true, 12, true);
    expect(await run()).toMatchObject({ rounds: 1 });
    await asAdmin((q) => q("update app.lead_retention_rounds set due_at = now() - interval '1 minute' where organization_id = $1 and status = 'open'", [org]));
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    expect((await pgError(setPolicy(owner, false, null, false))).code).toBe("42501");
    expect(await run()).toMatchObject({ rounds: 0, binned: 0, cancelled: 1 });
    expect(await deletedAt(leads.fresh)).toBeNull();
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    expect(await run()).toMatchObject({ rounds: 1, binned: 0 });
    const due = await asAdmin(
      async (q) =>
        (await q<{ fresh: boolean }>(
          "select due_at > now() + interval '13 days' as fresh from app.lead_retention_rounds where organization_id = $1 and status = 'open'",
          [org],
        )).rows[0].fresh,
    );
    expect(due).toBe(true);
  });

  it("'keep' is refused once the lead has moved to the bin, by the job or by a person", async () => {
    // the open round lists "fresh"; a second listed lead is added for the job's case
    const binnedByJob = await insertLead(owner.id, org, { full_name: "בסבב", phone: "050-7200010" });
    await asAdmin((q) =>
      q(
        `insert into app.lead_retention_round_leads (round_id, organization_id, lead_id)
         select id, organization_id, $2 from app.lead_retention_rounds where organization_id = $1 and status = 'open'`,
        [org, binnedByJob],
      ),
    );
    await raw(
      `with x as (update public.leads set deleted_at = now() where id = $1 returning id, deleted_at)
       update app.lead_retention_round_leads rl set binned_at = x.deleted_at from x where rl.lead_id = x.id`,
      [binnedByJob],
    );
    expect((await pgError(keep(owner, binnedByJob))).hint).toBe("retention:not_listed");
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [leads.fresh]));
    expect((await pgError(keep(owner, leads.fresh))).hint).toBe("retention:not_listed");
    expect(await asAdmin((q) => count(q, "select 1 from app.lead_retention_round_leads where lead_id = any($1) and kept_at is not null", [[binnedByJob, leads.fresh]]))).toBe(0);
    // the list shows both as in the bin, without "keep"
    for (const id of [binnedByJob, leads.fresh]) {
      const row = (await list(owner)).leads.find((l) => l.id === id) as { binned?: boolean } | undefined;
      expect(row?.binned, id).toBe(true);
    }
  });
});
