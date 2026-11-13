import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// USR-11 (first part): quiet hours. During the user's window (in the business's time zone) the bell gets the notification at
// once and only the phone push waits until the window ends; 'system' is never held; muted and bell-only kinds keep their rules.

type Claimed = { id: string; user_id: string };

const endOf = (from: string, until: string, zone: string, at: string) =>
  asAdmin(async (q) =>
    (await q<{ e: string | null }>("select to_char(app.quiet_hours_end($1::time, $2::time, $3, $4::timestamptz) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI') as e", [from, until, zone, at])).rows[0].e,
  );

describe("the quiet window (app.quiet_hours_end)", () => {
  it("a same-day window holds inside it and ends at its end, in the business's zone", async () => {
    // 2026-11-13 14:00 in Jerusalem (UTC+2) = 12:00 UTC
    expect(await endOf("13:00", "16:00", "Asia/Jerusalem", "2026-11-13T12:00:00Z")).toBe("2026-11-13T14:00");
    expect(await endOf("13:00", "16:00", "Asia/Jerusalem", "2026-11-13T14:00:00Z")).toBeNull(); // 16:00 local: the end is outside
    expect(await endOf("13:00", "16:00", "Asia/Jerusalem", "2026-11-13T10:59:00Z")).toBeNull(); // 12:59 local
  });

  it("a window across midnight holds on both sides of it", async () => {
    // 23:30 local -> ends 07:00 the next day
    expect(await endOf("22:00", "07:00", "Asia/Jerusalem", "2026-11-13T21:30:00Z")).toBe("2026-11-14T05:00");
    // 03:00 local -> ends 07:00 the same day
    expect(await endOf("22:00", "07:00", "Asia/Jerusalem", "2026-11-14T01:00:00Z")).toBe("2026-11-14T05:00");
    // 12:00 local: outside
    expect(await endOf("22:00", "07:00", "Asia/Jerusalem", "2026-11-14T10:00:00Z")).toBeNull();
  });

  it("the same instant is judged by each business's own zone", async () => {
    // 2026-11-13 21:30 UTC is 23:30 in Jerusalem (quiet) and 16:30 in New York (not quiet)
    expect(await endOf("22:00", "07:00", "Asia/Jerusalem", "2026-11-13T21:30:00Z")).toBe("2026-11-14T05:00");
    expect(await endOf("22:00", "07:00", "America/New_York", "2026-11-13T21:30:00Z")).toBeNull();
    // and 03:30 UTC is 22:30 in New York: quiet until 07:00 there (12:00 UTC)
    expect(await endOf("22:00", "07:00", "America/New_York", "2026-11-14T03:30:00Z")).toBe("2026-11-14T12:00");
  });

  it("off or equal ends never hold", async () => {
    expect(await asAdmin(async (q) => (await q("select app.quiet_hours_end(null, '07:00', 'Asia/Jerusalem', now()) as e")).rows[0].e)).toBeNull();
    expect(await endOf("07:00", "07:00", "Asia/Jerusalem", "2026-11-14T05:00:00Z")).toBeNull();
  });
});

describe("quiet hours on notifications and the push claim", () => {
  let owner: string, rep: string, other: string, org: string;
  // the local wall-clock hour now in the business's zone, so the window can be put around now or away from it
  let hour: number;

  const pad = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
  const setQuiet = (user: string, from: string | null, until: string | null) =>
    asUser(user, (q) => q("select public.set_notification_settings('{}'::text[], '{}'::text[], true, $1::time, $2::time)", [from, until]));
  const notify = (user: string, type: string, title: string) =>
    asAdmin(async (q) => {
      const r = await q<{ id: string; push_after: string | null; pushed: boolean }>(
        "insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, $3, $4) returning id, push_after, pushed_at is not null as pushed",
        [org, user, type, title],
      );
      return r.rows[0];
    });
  const claimMine = async (ids: string[]) =>
    (await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_push_notifications(500) as r")).rows[0].r)).filter((n) => ids.includes(n.id));

  beforeAll(async () => {
    owner = (await createUser("quiet-owner")).id;
    org = await createOrg(owner, "עסק שעות שקט");
    rep = (await addMember(org, owner, "member", "quiet-rep")).id;
    other = (await addMember(org, owner, "member", "quiet-other")).id;
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'Asia/Tokyo' where id = $1", [org]);
      for (const user of [rep, other]) {
        await q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'k', 'a')", [user, `https://push.example.test/quiet/${user}`]);
      }
      hour = Number((await q<{ h: string }>("select extract(hour from now() at time zone 'Asia/Tokyo')::int as h")).rows[0].h);
    });
  });

  it("stores quiet hours only through the function; a half pair or equal ends is refused", async () => {
    expect((await pgError(setQuiet(rep, "22:00", null))).hint).toBe("notification_settings:quiet");
    expect((await pgError(setQuiet(rep, "08:00", "08:00"))).hint).toBe("notification_settings:quiet");
    expect((await pgError(asUser(rep, (q) => q("update public.notification_settings set quiet_from = '01:00'")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.set_notification_settings('{}', '{}', true, '22:00', '07:00')")))).code).toBe("42501");
    expect((await pgError(asAdmin((q) => q("insert into public.notification_settings (user_id, quiet_from) values ($1, '01:00')", [owner]))))).toMatchObject({ code: "23514" });
  });

  it("the two-argument call keeps the stored quiet hours; p_quiet_set with nulls switches them off", async () => {
    await setQuiet(rep, "22:00", "07:00");
    await asUser(rep, (q) => q("select public.set_notification_settings($1, $2)", [["automation"], []]));
    const row = await asUser(rep, async (q) => (await q("select muted, quiet_from::text, quiet_until::text from public.notification_settings")).rows);
    expect(row).toEqual([{ muted: ["automation"], quiet_from: "22:00:00", quiet_until: "07:00:00" }]);
    await setQuiet(rep, null, null);
    const off = await asUser(rep, async (q) => (await q("select quiet_from, quiet_until from public.notification_settings")).rows);
    expect(off).toEqual([{ quiet_from: null, quiet_until: null }]);
  });

  it("inside the window the bell row is made at once with the push held to the window's end; others are not held", async () => {
    // a window across midnight that holds now: from an hour ago until two hours before now (the next day)
    await setQuiet(rep, pad(hour - 1), pad(hour - 2));
    const held = await notify(rep, "task_reminder", "מוחזק");
    expect(held.pushed).toBe(false);
    expect(held.push_after).not.toBeNull();
    const span = await asAdmin(async (q) => Number((await q<{ s: string }>("select extract(epoch from (push_after - now())) / 3600 as s from public.notifications where id = $1", [held.id])).rows[0].s));
    expect(span).toBeGreaterThan(21);
    expect(span).toBeLessThanOrEqual(23);
    // the rep's bell sees it now
    const bell = await asUser(rep, async (q) => (await q("select id from public.notifications where id = $1", [held.id])).rows);
    expect(bell).toHaveLength(1);
    // 'system' always pushes; another user is not affected
    const system = await notify(rep, "system", "אבטחה");
    expect(system.push_after).toBeNull();
    const others = await notify(other, "task_reminder", "לא מוחזק");
    expect(others.push_after).toBeNull();
    const claimed = await claimMine([held.id, system.id, others.id]);
    expect(claimed.map((n) => n.id).sort()).toEqual([system.id, others.id].sort());
    // the window ends: the held push is claimed, even though it was made long ago
    await asAdmin((q) => q("update public.notifications set created_at = now() - interval '20 hours', push_after = now() - interval '1 minute' where id = $1", [held.id]));
    expect((await claimMine([held.id])).map((n) => n.id)).toEqual([held.id]);
  });

  it("outside the window nothing is held; muted and bell-only kinds keep their rules", async () => {
    await setQuiet(rep, pad(hour + 2), pad(hour + 3));
    expect((await notify(rep, "task_reminder", "מחוץ לחלון")).push_after).toBeNull();
    await asUser(rep, (q) => q("select public.set_notification_settings($1, $2, true, $3::time, $4::time)", [["automation"], ["assigned"], pad(hour - 1), pad(hour + 2)]));
    expect(await asAdmin(async (q) => {
      await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'automation', 'x')", [org, rep]);
      return (await q("select 1 from public.notifications where user_id = $1 and type = 'automation'", [rep])).rowCount;
    })).toBe(0);
    const bellOnly = await notify(rep, "assigned", "רק פעמון");
    expect(bellOnly).toMatchObject({ pushed: true, push_after: null });
  });

  it("a held push read in the bell is never pushed; one released more than an hour ago is stale", async () => {
    await setQuiet(rep, pad(hour - 1), pad(hour + 2));
    const read = await notify(rep, "task_reminder", "נקרא");
    const stale = await notify(rep, "task_reminder", "ישן");
    expect(read.push_after).not.toBeNull();
    await asAdmin(async (q) => {
      await q("update public.notifications set push_after = now() - interval '1 minute', read_at = now() where id = $1", [read.id]);
      await q("update public.notifications set push_after = now() - interval '2 hours' where id = $1", [stale.id]);
    });
    expect(await claimMine([read.id, stale.id])).toEqual([]);
  });

  it("the old two-argument function is out of the API; the new one is not for anon", async () => {
    const grants = await asAdmin(async (q) =>
      (await q<{ sig: string; anon: boolean; auth: boolean; svc: boolean }>(`
        select p.oid::regprocedure::text as sig,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as auth,
               has_function_privilege('service_role', p.oid, 'execute') as svc
          from pg_proc p where p.proname in ('set_notification_settings', 'set_notification_settings_021276_retired', 'quiet_hours_end')
         order by 1`)).rows,
    );
    expect(grants).toEqual([
      { sig: "app.quiet_hours_end(time without time zone,time without time zone,text,timestamp with time zone)", anon: false, auth: false, svc: false },
      { sig: "app.set_notification_settings_021276_retired(text[],text[])", anon: false, auth: false, svc: false },
      { sig: "set_notification_settings(text[],text[],boolean,time without time zone,time without time zone)", anon: false, auth: true, svc: true },
    ]);
  });
});
