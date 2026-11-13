import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// USR-11 (first part): quiet hours. During the user's window (in the business's time zone) the bell gets the notification at
// once and only the phone push waits until the window ends; 'system', 'lead_new' and 'meeting_reminder' are never held (answer
// (5) ב); muted and bell-only kinds keep their rules; saving quiet hours judges held pushes again (answer (4) ב); the end is the
// wall-clock end, never earlier (answer (6) ב).

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

  it("Israel's spring change: the window ends at its wall-clock end; an end the clock jumps over ends at the jump", async () => {
    // 27 March 2026: 02:00 IST jumps to 03:00 IDT (00:00 UTC). 04:00 IDT, a 22:00-07:00 window: ends 07:00 IDT = 04:00 UTC
    expect(await endOf("22:00", "07:00", "Asia/Jerusalem", "2026-03-27T01:00:00Z")).toBe("2026-03-27T04:00");
    // 01:30 IST in a 01:00-03:30 window: held until 03:30 IDT (00:30 UTC)
    expect(await endOf("01:00", "03:30", "Asia/Jerusalem", "2026-03-26T23:30:00Z")).toBe("2026-03-27T00:30");
    // 01:30 IST in a 01:00-02:30 window: 02:30 never happens that night; the first instant after it is 03:00 IDT (00:00 UTC)
    expect(await endOf("01:00", "02:30", "Asia/Jerusalem", "2026-03-26T23:30:00Z")).toBe("2026-03-27T00:00");
  });

  it("Israel's autumn change: the wall-clock end, never earlier, the first time the clock shows it", async () => {
    // 25 October 2026: 02:00 IDT falls back to 01:00 IST (23:00 UTC). 03:00 IST in a 22:00-07:00 window: 07:00 IST = 05:00 UTC
    // (10 hours after the window began; 021276 capped it at 9, answer (6) ב removed the cap)
    expect(await endOf("22:00", "07:00", "Asia/Jerusalem", "2026-10-25T01:00:00Z")).toBe("2026-10-25T05:00");
    // 01:10 IDT in a 01:00-01:30 window (the hour that repeats): the clock first shows 01:30 at 22:30 UTC (IDT)
    expect(await endOf("01:00", "01:30", "Asia/Jerusalem", "2026-10-24T22:10:00Z")).toBe("2026-10-24T22:30");
    // 01:10 IST, the second time round: ends at 01:30 IST = 23:30 UTC
    expect(await endOf("01:00", "01:30", "Asia/Jerusalem", "2026-10-24T23:10:00Z")).toBe("2026-10-24T23:30");
  });

  it("off or equal ends never hold", async () => {
    expect(await asAdmin(async (q) => (await q("select app.quiet_hours_end(null, '07:00', 'Asia/Jerusalem', now()) as e")).rows[0].e)).toBeNull();
    expect(await endOf("07:00", "07:00", "Asia/Jerusalem", "2026-11-14T05:00:00Z")).toBeNull();
  });
});

describe("quiet hours on notifications and the push claim", () => {
  let owner: string, rep: string, other: string, org: string;
  // the local wall-clock hour now in the business's zone, read in each test, so the window can be put around now or away
  // from it; every window below still holds (or still misses) if the hour rolls over during the test
  const localHour = () =>
    asAdmin(async (q) => Number((await q<{ h: string }>("select extract(hour from now() at time zone 'Asia/Tokyo')::int as h")).rows[0].h));

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
    });
  });

  it("stores quiet hours only through the function; a half pair or equal ends is refused", async () => {
    expect((await pgError(setQuiet(rep, "22:00", null))).hint).toBe("notification_settings:quiet");
    expect((await pgError(setQuiet(rep, "08:00", "08:00"))).hint).toBe("notification_settings:quiet");
    expect((await pgError(setQuiet(rep, "24:00", "07:00"))).hint).toBe("notification_settings:quiet");
    expect((await pgError(setQuiet(rep, "22:00", "24:00"))).hint).toBe("notification_settings:quiet");
    expect((await pgError(asAdmin((q) => q("insert into public.notification_settings (user_id, quiet_from, quiet_until) values ($1, '22:00', '24:00')", [owner]))))).toMatchObject({ code: "23514" });
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
    const hour = await localHour();
    await setQuiet(rep, pad(hour - 1), pad(hour - 2));
    const held = await notify(rep, "task_reminder", "מוחזק");
    expect(held.pushed).toBe(false);
    expect(held.push_after).not.toBeNull();
    const span = await asAdmin(async (q) => Number((await q<{ s: string }>("select extract(epoch from (push_after - now())) / 3600 as s from public.notifications where id = $1", [held.id])).rows[0].s));
    expect(span).toBeGreaterThan(20);
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
    const hour = await localHour();
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
    const hour = await localHour();
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

  it("a business zone the server does not know holds nothing, and the notification is still made", async () => {
    const hour = await localHour();
    const odd = await createOrg(owner, "עסק אזור זמן לא מוכר");
    const member = (await addMember(odd, owner, "member", "quiet-odd")).id;
    await setQuiet(member, pad(hour - 1), pad(hour - 2));
    // a stored zone from before the time zone check (the check refuses it today, so it is written past the triggers), all in one
    // transaction that puts the zone back, so no other test ever sees it
    const row = await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.organizations set timezone = 'Mars/Olympus' where id = $1", [odd]);
      await q("set local session_replication_role = origin");
      const made = (await q<{ push_after: string | null }>("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'task_reminder', 'x') returning push_after", [odd, member])).rows;
      await q("set local session_replication_role = replica");
      await q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [odd]);
      return made;
    });
    expect(row).toEqual([{ push_after: null }]);
  });

  it("urgent kinds (new lead, meeting reminder) and system are never held, in the window too", async () => {
    const hour = await localHour();
    await setQuiet(rep, pad(hour - 1), pad(hour - 2));
    expect(await asAdmin(async (q) => (await q<{ k: string[] }>("select app.quiet_hours_exempt_kinds() as k")).rows[0].k)).toEqual(["system", "lead_new", "meeting_reminder"]);
    for (const kind of ["lead_new", "meeting_reminder", "system"]) {
      const made = await notify(rep, kind, `דחוף ${kind}`);
      expect(made).toMatchObject({ pushed: false, push_after: null });
    }
    expect((await notify(rep, "task_reminder", "לא דחוף")).push_after).not.toBeNull();
  });

  it("saving quiet hours judges the caller's held pushes again at once; other users and the two-argument call move nothing", async () => {
    const pushAfter = (id: string) =>
      asAdmin(async (q) => (await q<{ p: string | null; due: boolean }>("select push_after::text as p, push_after <= now() as due from public.notifications where id = $1", [id])).rows[0]);
    const expectedEnd = (from: string, until: string) =>
      asAdmin(async (q) => (await q<{ e: string | null }>("select app.quiet_hours_end($1::time, $2::time, 'Asia/Tokyo', now())::text as e", [from, until])).rows[0].e);

    let hour = await localHour();
    await setQuiet(rep, pad(hour - 1), pad(hour + 2));
    await setQuiet(other, pad(hour - 1), pad(hour + 2));
    const mine = await notify(rep, "task_reminder", "שלי מוחזק");
    const theirs = await notify(other, "task_reminder", "של אחר מוחזק");
    expect(mine.push_after).not.toBeNull();
    expect(theirs.push_after).not.toBeNull();
    const theirsBefore = (await pushAfter(theirs.id)).p;

    // the two-argument call keeps the held push as it was
    const before = (await pushAfter(mine.id)).p;
    await asUser(rep, (q) => q("select public.set_notification_settings('{}'::text[], '{}'::text[])"));
    expect((await pushAfter(mine.id)).p).toBe(before);

    // a new window that still holds now: held until the new window's end
    hour = await localHour();
    await setQuiet(rep, pad(hour - 2), pad(hour + 3));
    expect((await pushAfter(mine.id)).p).toBe(await expectedEnd(pad(hour - 2), pad(hour + 3)));

    // an urgent kind held before answer (5) is released by the same save
    const urgent = await notify(rep, "lead_new", "ליד ישן");
    await asAdmin((q) => q("update public.notifications set push_after = now() + interval '2 hours' where id = $1", [urgent.id]));
    hour = await localHour();
    await setQuiet(rep, pad(hour - 2), pad(hour + 3));
    expect((await pushAfter(urgent.id)).due).toBe(true);
    expect((await pushAfter(mine.id)).due).toBe(false);

    // a window that no longer holds now: released at once, and fresh for the claim even though it was made long ago
    await asAdmin((q) => q("update public.notifications set created_at = now() - interval '5 hours' where id = $1", [mine.id]));
    hour = await localHour();
    await setQuiet(rep, pad(hour + 4), pad(hour + 6));
    expect((await pushAfter(mine.id)).due).toBe(true);
    expect((await claimMine([mine.id, theirs.id, urgent.id])).map((n) => n.id).sort()).toEqual([mine.id, urgent.id].sort());

    // switching off releases what is still held
    hour = await localHour();
    await setQuiet(rep, pad(hour - 1), pad(hour + 2));
    const again = await notify(rep, "task_reminder", "מוחזק שוב");
    expect((await pushAfter(again.id)).due).toBe(false);
    await setQuiet(rep, null, null);
    expect((await pushAfter(again.id)).due).toBe(true);

    // the other user's held push did not move
    expect((await pushAfter(theirs.id)).p).toBe(theirsBefore);
    await setQuiet(other, null, null);
    expect((await pushAfter(theirs.id)).due).toBe(true);
  });

  it("a held push of a kind the same save makes bell-only or muted is never pushed", async () => {
    const hour = await localHour();
    await setQuiet(rep, pad(hour - 1), pad(hour + 2));
    const bellOnly = await notify(rep, "task_reminder", "יהפוך לפעמון בלבד");
    const muted = await notify(rep, "follow", "יושתק");
    const plain = await notify(rep, "mention", "ישוחרר");
    for (const n of [bellOnly, muted, plain]) expect(n.push_after).not.toBeNull();
    await asUser(rep, (q) => q("select public.set_notification_settings($1, $2, true, null, null)", [["follow"], ["task_reminder"]]));
    const rows = await asAdmin(async (q) =>
      (await q<{ id: string; pushed: boolean; due: boolean }>("select id, pushed_at is not null as pushed, push_after <= now() as due from public.notifications where id = any($1)", [[bellOnly.id, muted.id, plain.id]])).rows,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[bellOnly.id].pushed).toBe(true);
    expect(by[muted.id].pushed).toBe(true);
    expect(by[plain.id]).toMatchObject({ pushed: false, due: true });
    expect((await claimMine([bellOnly.id, muted.id, plain.id])).map((n) => n.id)).toEqual([plain.id]);
    await asUser(rep, (q) => q("select public.set_notification_settings('{}'::text[], '{}'::text[])"));
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
