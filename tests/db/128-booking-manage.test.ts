import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Reply = Record<string, unknown>;

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();

/**
 * CAL-10b (owner, 15 October 2026): the customer's personal link to cancel or change a booking. The token is made
 * by booking_submit and answered once; only its SHA-256 is kept. Every public function is service_role only and
 * answers only what the page shows. The businesses keep UTC, every day is a working day 09-17, so nothing here
 * depends on the hour or the weekday.
 */
describe("the personal link of a booking (CAL-10b)", () => {
  let owner: U, rep: U, mate: U;
  let org: string, otherOrg: string;
  let pageId: string, pageToken: string, otherPageToken: string;
  let type: string;

  const book = (t: string, startsAt: string, phone: string, name = "לקוחה", ip: string | null = null) =>
    asService(async (q) =>
      (await q<{ r: Reply }>("select public.booking_submit($1, $2, $3, $4) as r", [t, startsAt, JSON.stringify({ full_name: name, phone, answers: { goal: "פגישה" } }), ip])).rows[0].r,
    );
  const allNotices = (user: U) =>
    asAdmin(async (q) => (await q<{ type: string; title: string }>("select type, title from public.notifications where user_id = $1 order by created_at", [user.id])).rows);
  const addParticipant = (meetingId: string, user: U) =>
    asAdmin((q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, meetingId, user.id]));
  const setMembership = (user: U, status: string) =>
    asAdmin((q) => q("update public.memberships set status = $3 where organization_id = $1 and user_id = $2", [org, user.id, status]));
  const manage = (t: string, from: string | null = null, ip: string | null = null) =>
    asService(async (q) => (await q<{ r: Reply }>("select public.booking_manage_public($1, $2, $3) as r", [t, from, ip])).rows[0].r);
  const cancel = (t: string, ip: string | null = null) => asService(async (q) => (await q<{ r: Reply }>("select public.booking_manage_cancel($1, $2) as r", [t, ip])).rows[0].r);
  const change = (t: string, startsAt: string | null, ip: string | null = null) =>
    asService(async (q) => (await q<{ r: Reply }>("select public.booking_manage_change($1, $2, $3) as r", [t, startsAt, ip])).rows[0].r);
  const meetingAt = (startsAt: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ id: string; status: string; lead_id: string | null; contact_id: string | null; owner_id: string; title: string; description: string }>(
            "select id, status, lead_id, contact_id, owner_id, title, description from public.meetings where organization_id = $1 and starts_at = $2 order by created_at",
            [org, startsAt],
          )
        ).rows,
    );
  const notices = (user: U) =>
    asAdmin(async (q) => (await q<{ title: string; body: string }>("select title, body from public.notifications where user_id = $1 and type = 'meeting_cancelled' order by created_at", [user.id])).rows);
  const setPage = (fields: string) => asAdmin((q) => q(`update public.booking_pages set ${fields} where id = $1`, [pageId]));

  beforeAll(async () => {
    owner = await createUser("bm-owner");
    org = await createOrg(owner.id, "עסק הביטולים");
    rep = await addMember(org, owner.id, "member", "bm-rep");
    mate = await addMember(org, owner.id, "member", "bm-mate");
    const outsider = await createUser("bm-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      for (const o of [org, otherOrg]) {
        await q("update public.organizations set timezone = 'UTC', phone = null where id = $1", [o]);
        await q(
          `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
           values ($1, '{}', false, false, '{}', $2)
           on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
          [o, JSON.stringify(ALL_WEEK)],
        );
      }
      await q("update public.profiles set full_name = 'דנה הנציגה', timezone = null where id = $1", [rep.id]);
    });
    type = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meeting_types (organization_id, name, duration_minutes, meeting_format, location, buffer_before_minutes, buffer_after_minutes) values ($1, 'ייעוץ', 60, 'in_person', 'רחוב הרצל 1', 15, 15) returning id",
          [org],
        )
      ).rows[0].id,
    );
    const page = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string; token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'תורים', $3, 0, 30, 60) returning id, token",
          [org, rep.id, type],
        )
      ).rows[0],
    );
    pageId = page.id;
    pageToken = page.token;
    otherPageToken = await asUser(outsider.id, async (q) => {
      const t = (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 order by position limit 1", [otherOrg])).rows[0].id;
      return (
        await q<{ token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, slot_step_minutes) values ($1, $2, 'זר', $3, 0, 60) returning token",
          [otherOrg, outsider.id, t],
        )
      ).rows[0].token;
    });
  });

  it("the booking answers the link once; only its SHA-256 is kept, one per meeting", async () => {
    const r = await book(pageToken, at(dayAhead(5), "10:00"), "0501110001");
    const token = r.manage_token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const [meeting] = await meetingAt(at(dayAhead(5), "10:00"));
    const rows = await asAdmin(async (q) => (await q<{ token_hash: string; ok: boolean }>(
      "select token_hash, token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex') as ok from app.booking_manage_links where meeting_id = $1",
      [meeting.id, token],
    )).rows);
    expect(rows).toEqual([{ token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), ok: true }]);
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where token_hash = $1", [token]))).toBe(0);
  });

  it("the page answers only what it shows: the time, the type and the rep; a week of times for a change, the meeting not blocking", async () => {
    const day = dayAhead(6);
    const r = await book(pageToken, at(day, "10:00"), "0501110002", "יעל");
    const page = await manage(r.manage_token as string, day);
    expect(Object.keys(page).sort()).toEqual(
      ["brand", "built_with", "business", "call_phone", "can_cancel", "change", "ends_at", "meeting", "notice_hours", "rep", "starts_at", "status", "time_zone"].sort(),
    );
    expect(page).toMatchObject({
      status: "planned",
      can_cancel: true,
      notice_hours: 24,
      call_phone: null,
      business: "עסק הביטולים",
      rep: "דנה הנציגה",
      time_zone: "UTC",
      meeting: { name: "ייעוץ", format: "in_person", location: "רחוב הרצל 1" },
    });
    const slots = ((page.change as Reply).slots as string[]).map((s) => new Date(s).toISOString());
    // 09:00 and 11:00 touch the meeting's buffers, but the meeting being moved never blocks; its own time is not offered
    expect(slots).toEqual(expect.arrayContaining([at(day, "09:00"), at(day, "11:00")]));
    expect(slots).not.toContain(at(day, "10:00"));
    // no ids, no token, nothing of the customer
    const [meeting] = await meetingAt(at(day, "10:00"));
    const text = JSON.stringify(page);
    for (const secret of [meeting.id, meeting.lead_id ?? "", org, pageId, pageToken, rep.id, type, "יעל", "0501110002", "פגישה", r.manage_token as string]) {
      expect(text).not.toContain(secret);
    }
  });

  it("not found: a malformed or unknown token, a deleted meeting, a closed business; read only is unavailable", async () => {
    for (const t of ["", "x", "0".repeat(64), "A".repeat(64), pageToken]) expect((await pgError(manage(t))).code).toBe("P0002");
    for (const t of ["0".repeat(64), pageToken]) {
      expect((await pgError(cancel(t))).code).toBe("P0002");
      expect((await pgError(change(t, at(dayAhead(7), "12:00")))).code).toBe("P0002");
    }
    const r = await book(pageToken, at(dayAhead(7), "10:00"), "0501110003");
    const token = r.manage_token as string;
    for (const status of ["read_only"]) {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
      expect(await manage(token)).toEqual({ unavailable: true });
      expect((await pgError(cancel(token))).hint).toBe("booking:unavailable");
    }
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    expect((await pgError(manage(token))).code).toBe("P0002");
    expect((await pgError(cancel(token))).code).toBe("P0002");
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    expect(await manage(token)).toHaveProperty("status", "planned");
    // the meeting removed: its link goes with it
    const [meeting] = await meetingAt(at(dayAhead(7), "10:00"));
    await asUser(owner.id, (q) => q("delete from public.meetings where id = $1", [meeting.id]));
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where meeting_id = $1", [meeting.id]))).toBe(0);
    expect((await pgError(manage(token))).code).toBe("P0002");
  });

  it("only the server may call the functions; the tables are out of reach", async () => {
    for (const run of [asAnon, (fn: Parameters<typeof asAnon>[0]) => asUser(rep.id, fn)]) {
      for (const sql of ["select public.booking_manage_public('x')", "select public.booking_manage_cancel('x')", "select public.booking_manage_change('x', now())", "select 1 from app.booking_manage_links"]) {
        expect((await pgError(run((q) => q(sql)))).code).toBe("42501");
      }
    }
    const fns = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; definer: boolean; anon: boolean; authed: boolean; service: boolean }>(
            `select p.proname as name, p.prosecdef as definer,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authed,
                    has_function_privilege('service_role', p.oid, 'execute') as service
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'booking_manage_%' order by 1`,
          )
        ).rows,
    );
    expect(fns).toEqual(
      ["booking_manage_cancel", "booking_manage_change", "booking_manage_public"].map((name) => ({ name, definer: true, anon: false, authed: false, service: true })),
    );
    // the helpers in schema app: nobody but the owner
    const helpers = await asAdmin(
      async (q) =>
        (
          await q<{ n: number }>(
            `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and (p.proname like 'booking\\_manage\\_%' or p.proname in ('booking_refusal', 'booking_sender', 'booking_slots', 'booking_slots_020100_retired'))
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                     or has_function_privilege('service_role', p.oid, 'execute'))`,
          )
        ).rows[0].n,
    );
    expect(helpers).toBe(0);
  });

  it("cancel: the meeting cancelled, a timeline entry, the rep told once (mutable); the page then says cancelled", async () => {
    const day = dayAhead(8);
    const r = await book(pageToken, at(day, "10:00"), "0501110004");
    const token = r.manage_token as string;
    const before = (await notices(rep)).length;
    expect(await cancel(token)).toEqual({ status: "cancelled" });
    const [meeting] = await meetingAt(at(day, "10:00"));
    expect(meeting.status).toBe("cancelled");
    const entries = await asAdmin(
      async (q) =>
        (await q<{ type: string; body: string; kind: string }>("select type, body, metadata ->> 'kind' as kind from public.activities where lead_id = $1 and type = 'system'", [meeting.lead_id])).rows,
    );
    expect(entries).toEqual([{ type: "system", body: expect.stringContaining("בוטלה על ידי הלקוח"), kind: "booking_cancelled" }]);
    const told = await notices(rep);
    expect(told.length).toBe(before + 1);
    expect(told[told.length - 1].title).toContain("הלקוח ביטל פגישה");
    // again: the same answer, nobody told twice
    expect(await cancel(token)).toEqual({ status: "cancelled" });
    expect((await notices(rep)).length).toBe(before + 1);
    expect(await manage(token)).toMatchObject({ status: "cancelled", can_cancel: false, change: null, call_phone: null });
    // the slot is free again
    expect((await book(pageToken, at(day, "10:00"), "0501110005")).status).toBe("booked");
    // a rep who muted the kind is not told (it is not 'system')
    await asUser(rep.id, (q) => q("select public.set_notification_settings($1, $2)", [["meeting_cancelled"], []]));
    const muted = await book(pageToken, at(day, "13:00"), "0501110006");
    await cancel(muted.manage_token as string);
    expect((await notices(rep)).length).toBe(before + 1);
    await asUser(rep.id, (q) => q("select public.set_notification_settings($1, $2)", [[], []]));
  });

  it("below the threshold: no cancel or change here, the business's phone when set; 0 = up to the start", async () => {
    await setPage("cancel_notice_hours = 72");
    const r = await book(pageToken, at(dayAhead(1), "10:00"), "0501110007");
    const token = r.manage_token as string;
    expect(await manage(token)).toMatchObject({ status: "planned", can_cancel: false, change: null, call_phone: null, notice_hours: 72 });
    await asAdmin((q) => q("update public.organizations set phone = '03-5551234' where id = $1", [org]));
    expect(await manage(token)).toMatchObject({ can_cancel: false, call_phone: "03-5551234" });
    expect((await pgError(cancel(token))).hint).toBe("booking:too_late");
    expect((await pgError(change(token, at(dayAhead(9), "12:00")))).hint).toBe("booking:too_late");
    expect((await meetingAt(at(dayAhead(1), "10:00")))[0].status).toBe("planned");
    await setPage("cancel_notice_hours = 0");
    expect(await manage(token)).toMatchObject({ can_cancel: true, call_phone: null });
    await setPage("cancel_notice_hours = 24");
    await asAdmin((q) => q("update public.organizations set phone = null where id = $1", [org]));
  });

  it("change: a cancel and a new booking of the page, through its slots and refusals; the new meeting has its own link", async () => {
    const day = dayAhead(10);
    const r = await book(pageToken, at(day, "10:00"), "0501110008", "רון");
    const token = r.manage_token as string;
    // never offered, or taken: answered, the meeting untouched
    expect(await change(token, at(day, "20:00"))).toEqual({ status: "invalid_time" });
    expect(await change(token, null)).toEqual({ status: "invalid_time" });
    const other = await book(pageToken, at(day, "14:00"), "0501110009");
    expect(await change(token, at(day, "14:00"))).toEqual({ status: "slot_taken" });
    expect((await meetingAt(at(day, "10:00")))[0].status).toBe("planned");
    // the next free hour: the meeting itself does not block it
    const moved = await change(token, at(day, "11:00"), "c".repeat(64));
    expect(Object.keys(moved).sort()).toEqual(["ends_at", "manage_token", "meeting", "rep", "starts_at", "status", "time_zone"]);
    expect(moved).toMatchObject({ status: "booked", rep: "דנה הנציגה", meeting: { name: "ייעוץ" } });
    expect(moved.manage_token).not.toBe(token);
    const [old] = await meetingAt(at(day, "10:00"));
    const [fresh] = await meetingAt(at(day, "11:00"));
    expect(old.status).toBe("cancelled");
    expect(fresh).toMatchObject({ status: "planned", lead_id: old.lead_id, contact_id: old.contact_id, owner_id: rep.id, title: old.title });
    expect(fresh.description).toContain("הועברה בקישור האישי");
    const entry = await asAdmin(async (q) => (await q<{ kind: string }>("select metadata ->> 'kind' as kind from public.activities where lead_id = $1 and type = 'system'", [old.lead_id])).rows);
    expect(entry).toEqual([{ kind: "booking_changed" }]);
    expect((await notices(rep)).at(-1)?.title).toContain("הלקוח העביר פגישה");
    // the old link shows it cancelled; the new one manages the new meeting
    expect(await manage(token)).toMatchObject({ status: "cancelled" });
    expect(await manage(moved.manage_token as string)).toMatchObject({ status: "planned", starts_at: expect.stringContaining(`${day}T11:00`) });
    expect((await pgError(change(token, at(day, "15:00")))).hint).toBe("booking:too_late");
    // the page off: no change (a cancel still works)
    await setPage("is_active = false");
    expect((await pgError(change(moved.manage_token as string, at(day, "15:00")))).hint).toBe("booking:unavailable");
    expect((await manage(moved.manage_token as string)).change).toBeNull();
    await setPage("is_active = true");
    expect(other.status).toBe("booked");
  });

  it("limits: 5 cancel or change attempts per sender in 10 minutes; views 60; a closed page takes no change", async () => {
    const day = dayAhead(12);
    const r = await book(pageToken, at(day, "10:00"), "0501110010");
    const token = r.manage_token as string;
    const ip = "m".repeat(64);
    for (let i = 0; i < 5; i++) expect((await change(token, at(day, "20:00"), ip)).status).toBe("invalid_time");
    expect((await pgError(change(token, at(day, "12:00"), ip))).hint).toBe("rate_limited");
    expect((await pgError(cancel(token, ip))).hint).toBe("rate_limited");
    expect((await change(token, at(day, "12:00"), "n".repeat(64))).status).toBe("booked");
    const viewer = "v".repeat(64);
    const fresh = (await manage(token)) as Reply;
    expect(fresh.status).toBe("cancelled");
    for (let i = 0; i < 60; i++) await manage(token, null, viewer);
    expect(await manage(token, null, viewer)).toEqual({ rate_limited: true });
    // closed for the hour (CAL-10): no change through the link either
    const second = await book(pageToken, at(dayAhead(13), "10:00"), "0501110011");
    await asAdmin((q) => q("insert into app.booking_page_closures (page_id, organization_id, closed_until) values ($1, $2, now() + interval '1 hour')", [pageId, org]));
    expect((await pgError(change(second.manage_token as string, at(dayAhead(13), "12:00")))).hint).toBe("booking:closed");
    expect((await manage(second.manage_token as string)).change).toBeNull();
    expect(await cancel(second.manage_token as string)).toEqual({ status: "cancelled" });
    await asAdmin((q) => q("update app.booking_page_closures set closed_until = now() - interval '1 second' where page_id = $1", [pageId]));
  });

  it("a link reaches its own meeting only: never another business's", async () => {
    const mine = await book(pageToken, at(dayAhead(14), "10:00"), "0501110012");
    const theirs = await book(otherPageToken, at(dayAhead(14), "10:00"), "0501110012");
    expect(await cancel(theirs.manage_token as string)).toEqual({ status: "cancelled" });
    expect((await meetingAt(at(dayAhead(14), "10:00")))[0].status).toBe("planned");
    const otherMeetings = await asAdmin(
      async (q) => (await q<{ status: string }>("select status from public.meetings where organization_id = $1 and starts_at = $2", [otherOrg, at(dayAhead(14), "10:00")])).rows,
    );
    expect(otherMeetings).toEqual([{ status: "cancelled" }]);
    expect(await manage(mine.manage_token as string)).toMatchObject({ status: "planned", business: "עסק הביטולים" });
    expect(await manage(theirs.manage_token as string)).toMatchObject({ status: "cancelled", business: "עסק אחר" });
  });

  it("the threshold is the page owner's to set, 0 to 72 hours", async () => {
    expect(await asUser(rep.id, async (q) => (await q("update public.booking_pages set cancel_notice_hours = 48 where id = $1", [pageId])).rowCount)).toBe(1);
    expect((await pgError(asUser(rep.id, (q) => q("update public.booking_pages set cancel_notice_hours = 73 where id = $1", [pageId])))).code).toBe("23514");
    expect((await pgError(asUser(rep.id, (q) => q("update public.booking_pages set cancel_notice_hours = -1 where id = $1", [pageId])))).code).toBe("23514");
    await setPage("cancel_notice_hours = 24");
  });
  it("a meeting that took place or was a no-show: no cancel or change through the link", async () => {
    const day = dayAhead(15);
    for (const status of ["held", "no_show"]) {
      const at10 = at(day, status === "held" ? "10:00" : "13:00");
      const r = await book(pageToken, at10, status === "held" ? "0501110013" : "0501110014");
      const [meeting] = await meetingAt(at10);
      await asAdmin((q) => q("update public.meetings set status = $2 where id = $1", [meeting.id, status]));
      expect((await pgError(cancel(r.manage_token as string))).hint).toBe("booking:too_late");
      expect((await pgError(change(r.manage_token as string, at(day, "15:00")))).hint).toBe("booking:too_late");
      expect((await meetingAt(at10))[0].status).toBe(status);
      expect(await manage(r.manage_token as string)).toMatchObject({ status: "past", can_cancel: false, change: null });
    }
  });

  it("a token resolves only by its whole hash: a stored hash that shares a prefix is no match", async () => {
    const day = dayAhead(16);
    const r = await book(pageToken, at(day, "10:00"), "0501110015");
    const mine = r.manage_token as string;
    // a meeting with a link whose hash shares the first 32 characters with a token nobody was given
    const other = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at, owner_id) values ($1, 'אחרת', $2, $3, $4) returning id",
          [org, at(day, "15:00"), at(day, "16:00"), rep.id],
        )
      ).rows[0].id,
    );
    const stranger = "f".repeat(63) + "e";
    await asAdmin((q) =>
      q(
        `insert into app.booking_manage_links (token_hash, organization_id, meeting_id, page_id)
         values (left(encode(sha256(convert_to($1, 'UTF8')), 'hex'), 32) || repeat('0', 32), $2, $3, $4)`,
        [stranger, org, other, pageId],
      ),
    );
    expect((await pgError(manage(stranger))).code).toBe("P0002");
    expect((await pgError(cancel(stranger))).code).toBe("P0002");
    expect(await asAdmin(async (q) => (await q<{ status: string }>("select status from public.meetings where id = $1", [other])).rows[0].status)).toBe("planned");
    expect(new Date((await manage(mine)).starts_at as string).toISOString()).toBe(at(day, "10:00"));
  });

  it("the page gone: the threshold falls back to 24 hours", async () => {
    const page2 = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string; token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, slot_step_minutes, cancel_notice_hours) values ($1, $2, 'דף שני', $3, 0, 60, 0) returning id, token",
          [org, rep.id, type],
        )
      ).rows[0],
    );
    const r = await book(page2.token, at(dayAhead(17), "10:00"), "0501110016");
    const token = r.manage_token as string;
    // twelve hours from now
    await asAdmin((q) =>
      q("update public.meetings set starts_at = now() + interval '12 hours', ends_at = now() + interval '13 hours' where organization_id = $1 and starts_at = $2", [org, at(dayAhead(17), "10:00")]),
    );
    expect(await manage(token)).toMatchObject({ can_cancel: true, notice_hours: 0 });
    await asUser(rep.id, (q) => q("delete from public.booking_pages where id = $1", [page2.id]));
    expect(await manage(token)).toMatchObject({ status: "planned", can_cancel: false, notice_hours: 24, change: null });
    expect((await pgError(cancel(token))).hint).toBe("booking:too_late");
  });

  it("only active members are told: a suspended organizer or participant gets no meeting_cancelled", async () => {
    const day = dayAhead(18);
    const r = await book(pageToken, at(day, "10:00"), "0501110017");
    const [meeting] = await meetingAt(at(day, "10:00"));
    await addParticipant(meeting.id, mate);
    const before = { rep: (await notices(rep)).length, mate: (await notices(mate)).length };
    await setMembership(rep, "suspended");
    await setMembership(mate, "suspended");
    try {
      expect(await cancel(r.manage_token as string)).toEqual({ status: "cancelled" });
    } finally {
      await setMembership(rep, "active");
      await setMembership(mate, "active");
    }
    expect((await notices(rep)).length).toBe(before.rep);
    expect((await notices(mate)).length).toBe(before.mate);
  });

  it("a cancel tells the active participants too", async () => {
    const day = dayAhead(19);
    const r = await book(pageToken, at(day, "10:00"), "0501110018");
    const [meeting] = await meetingAt(at(day, "10:00"));
    await addParticipant(meeting.id, mate);
    const before = (await notices(mate)).length;
    await cancel(r.manage_token as string);
    const told = await notices(mate);
    expect(told.length).toBe(before + 1);
    expect(told.at(-1)?.title).toContain("הלקוח ביטל פגישה");
  });

  it("a change carries the participants and tells each person once: the moved notice, no meeting_scheduled", async () => {
    const day = dayAhead(20);
    const r = await book(pageToken, at(day, "10:00"), "0501110019");
    const [meeting] = await meetingAt(at(day, "10:00"));
    await addParticipant(meeting.id, mate);
    const before = { rep: (await allNotices(rep)).length, mate: (await allNotices(mate)).length };
    expect((await change(r.manage_token as string, at(day, "13:00"))).status).toBe("booked");
    const [fresh] = await meetingAt(at(day, "13:00"));
    const participants = await asAdmin(
      async (q) => (await q<{ user_id: string }>("select user_id from public.meeting_participants where meeting_id = $1", [fresh.id])).rows.map((x) => x.user_id),
    );
    expect(participants).toEqual([mate.id]);
    for (const [who, n] of [[rep, before.rep], [mate, before.mate]] as const) {
      const added = (await allNotices(who)).slice(n);
      expect(added).toEqual([{ type: "meeting_cancelled", title: expect.stringContaining("הלקוח העביר פגישה") }]);
    }
    // later meetings still tell people as usual (the hold is only for the change)
    const later = await book(pageToken, at(day, "15:00"), "0501110020");
    expect(later.status).toBe("booked");
    const [laterMeeting] = await meetingAt(at(day, "15:00"));
    await addParticipant(laterMeeting.id, mate);
    expect((await allNotices(mate)).at(-1)?.type).toBe("meeting_scheduled");
  });

  it("a change after the page moved to another rep: the new rep gets the meeting and the moved notice", async () => {
    const day = dayAhead(22);
    const r = await book(pageToken, at(day, "10:00"), "0501110025");
    await asUser(owner.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [pageId, mate.id]));
    try {
      const before = { rep: (await allNotices(rep)).length, mate: (await allNotices(mate)).length };
      expect((await change(r.manage_token as string, at(day, "13:00"))).status).toBe("booked");
      expect((await meetingAt(at(day, "13:00")))[0].owner_id).toBe(mate.id);
      for (const [who, n] of [[rep, before.rep], [mate, before.mate]] as const) {
        expect((await allNotices(who)).slice(n)).toEqual([{ type: "meeting_cancelled", title: expect.stringContaining("הלקוח העביר פגישה") }]);
      }
    } finally {
      await asUser(owner.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [pageId, rep.id]));
    }
  });

  it("the sender is scoped to the page: bookings and link attempts share one limit there, and nowhere else", async () => {
    const day = dayAhead(21);
    const r = await book(pageToken, at(day, "10:00"), "0501110021");
    const ip = "s".repeat(64);
    for (let i = 0; i < 4; i++) expect((await book(pageToken, at(day, "20:00"), "0501110022", "x", ip)).status).toBe("invalid_time");
    expect((await change(r.manage_token as string, at(day, "20:00"), ip)).status).toBe("invalid_time");
    expect((await pgError(cancel(r.manage_token as string, ip))).hint).toBe("rate_limited");
    expect((await pgError(book(pageToken, at(day, "13:00"), "0501110023", "x", ip))).hint).toBe("rate_limited");
    // another page (another business) counts the same sender afresh, and nothing stores the hash as sent
    expect((await book(otherPageToken, at(day, "10:00"), "0501110024", "x", ip)).status).toBe("booked");
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where ip_hash = $1", [ip]))).toBe(0);
    const otherPageId = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.booking_pages where token = $1", [otherPageToken])).rows[0].id);
    const scoped = await asAdmin(
      async (q) =>
        (await q<{ a: string; b: string }>("select app.booking_sender($1, $3) as a, app.booking_sender($2, $3) as b", [pageId, otherPageId, ip])).rows[0],
    );
    expect(scoped.a).not.toBe(scoped.b);
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and ip_hash = $2", [otherPageId, scoped.b]))).toBe(1);
  });
});
