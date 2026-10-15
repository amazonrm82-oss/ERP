import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "pg";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));

/** YYYY-MM-DD of today + n days (UTC; the test businesses keep UTC). */
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();

/**
 * CAL-10: the public booking page. booking_page_public / booking_submit are service_role only, answer
 * only the page's public fields, offer slots inside the rep's working hours and clear of the rep's
 * meetings (with buffers), and book by linking the phone to an existing lead or contact, else a new lead.
 */
describe("public booking page (CAL-10)", () => {
  let owner: U, rep: U, other: U, outsider: U;
  let org: string, otherOrg: string;
  let type: string;
  let token: string;
  let pageId: string;
  let otherToken: string;
  let source: string;
  const target = dayAhead(3);

  const publicPage = (t: string, from: string | null = target) =>
    asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.booking_page_public($1, $2) as r", [t, from])).rows[0].r);
  const slotsOf = async (t: string, from: string = target) => {
    const r = await publicPage(t, from);
    return (r.slots as string[]).map((s) => new Date(s).toISOString());
  };
  const book = (t: string, startsAt: string, payload: Record<string, unknown>, ipHash: string | null = null, spam = false) =>
    asService(async (q) =>
      (await q<{ r: Record<string, unknown> }>("select public.booking_submit($1, $2, $3, $4, null, $5) as r", [t, startsAt, JSON.stringify(payload), ipHash, spam])).rows[0].r,
    );
  const newPage = (by: U, o: string, extra: Record<string, unknown> = {}) =>
    asUser(by.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: o, user_id: by.id, title: "קביעת פגישת ייעוץ", ...extra };
      const cols = Object.keys(row);
      return (
        await q<{ id: string; token: string }>(
          `insert into public.booking_pages (${cols.join(", ")}) values (${cols.map((c, i) => (c === "questions" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")}) returning id, token`,
          Object.values(row).map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
        )
      ).rows[0];
    });

  beforeAll(async () => {
    owner = await createUser("bk-owner");
    org = await createOrg(owner.id, "עסק התורים");
    rep = await addMember(org, owner.id, "member", "bk-rep");
    other = await addMember(org, owner.id, "member", "bk-other");
    outsider = await createUser("bk-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      for (const o of [org, otherOrg]) {
        await q("update public.organizations set timezone = 'UTC' where id = $1", [o]);
        // no rest days or holidays: every day is a working day in these tests
        await q(
          `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
           values ($1, '{}', false, false, '{}')
           on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}'`,
          [o],
        );
      }
      await q("update public.profiles set working_hours = $2, timezone = null where id = any($1::uuid[])", [[rep.id, other.id, outsider.id], JSON.stringify(ALL_WEEK)]);
      await q("update public.profiles set full_name = 'דנה הנציגה' where id = $1", [rep.id]);
    });
    type = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meeting_types (organization_id, name, duration_minutes, meeting_format, location, buffer_before_minutes, buffer_after_minutes) values ($1, 'ייעוץ ראשון', 60, 'in_person', 'רחוב הרצל 1', 15, 15) returning id",
          [org],
        )
      ).rows[0].id,
    );
    source = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 order by name limit 1", [org])).rows[0].id);
    const page = await newPage(rep, org, {
      meeting_type_id: type,
      source_id: source,
      min_notice_minutes: 0,
      max_days_ahead: 14,
      slot_step_minutes: 60,
      intro: "בחרו זמן שנוח לכם",
      questions: [
        { id: "goal", label: "מה תרצו להשיג?", required: true },
        { id: "notes", label: "הערות", required: false },
      ],
    });
    token = page.token;
    pageId = page.id;
    const otherType = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 order by position limit 1", [otherOrg])).rows[0].id);
    otherToken = (await newPage(outsider, otherOrg, { meeting_type_id: otherType, min_notice_minutes: 0 })).token;
    // the rep is busy 12:00-13:00 on the target day; a cancelled meeting blocks nothing
    await asUser(rep.id, async (q) => {
      await q("insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'תפוס', $2, $3)", [org, at(target, "12:00"), at(target, "13:00")]);
      await q("insert into public.meetings (organization_id, title, starts_at, ends_at, status) values ($1, 'בוטלה', $2, $3, 'cancelled')", [
        org,
        at(target, "09:00"),
        at(target, "10:00"),
      ]);
    });
  });

  it("the token is made by the server, 32 hex characters", () => {
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the public page answers only its public fields", async () => {
    const r = await publicPage(token);
    expect(Object.keys(r).sort()).toEqual(
      ["brand", "built_with", "business", "from", "intro", "last_day", "meeting", "questions", "rep", "slots", "time_zone", "title", "today"].sort(),
    );
    expect(r).toMatchObject({
      title: "קביעת פגישת ייעוץ",
      intro: "בחרו זמן שנוח לכם",
      business: "עסק התורים",
      rep: "דנה הנציגה",
      time_zone: "UTC",
      meeting: { name: "ייעוץ ראשון", duration_minutes: 60, format: "in_person", location: "רחוב הרצל 1" },
      from: target,
    });
    expect(Object.keys(r.brand as object).sort()).toEqual(["color", "logo"]);
    // no id, token, email, phone or owner of anything
    const text = JSON.stringify(r);
    for (const secret of [pageId, rep.id, owner.id, org, type, source, rep.email, token]) expect(text).not.toContain(secret);
  });

  it("slots: inside working hours, clear of the rep's meetings with both buffers, cancelled ones ignored", async () => {
    const slots = (await slotsOf(token)).filter((s) => s.startsWith(target));
    // 09-17, 60 minutes, step 60; the meeting 12-13 with the type's 15-minute buffers blocks 11:00, 12:00 and 13:00
    expect(slots).toEqual(["09:00", "10:00", "14:00", "15:00", "16:00"].map((h) => at(target, h)));
  });

  it("no working hours: the page is not published and cannot be turned on; the business's hours are enough", async () => {
    await asAdmin((q) => q("update public.profiles set working_hours = null where id = $1", [rep.id]));
    // the public page: not found (it does not mean "all day")
    expect((await pgError(publicPage(token))).code).toBe("P0002");
    expect((await pgError(book(token, at(target, "10:00"), { full_name: "x", phone: "0501234567", answers: { goal: "x" } }))).code).toBe("P0002");
    // the settings: kept on as it is, but cannot be turned on again or made on
    await asUser(rep.id, (q) => q("update public.booking_pages set is_active = false where id = $1", [pageId]));
    expect((await pgError(asUser(rep.id, (q) => q("update public.booking_pages set is_active = true where id = $1", [pageId])))).hint).toBe("booking_page:no_hours");
    expect((await pgError(newPage(rep, org, { meeting_type_id: type }))).hint).toBe("booking_page:no_hours");
    // an admin cannot hand an active page to a rep without hours either
    const others = await newPage(other, org, { meeting_type_id: type });
    expect((await pgError(asUser(owner.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [others.id, rep.id])))).hint).toBe("booking_page:no_hours");
    // a page saved off is fine
    expect((await newPage(rep, org, { meeting_type_id: type, is_active: false })).token).toMatch(/^[0-9a-f]{32}$/);
    // the business's hours are enough
    await asAdmin((q) => q("update public.org_calendar_settings set working_hours = $2 where organization_id = $1", [org, JSON.stringify(ALL_WEEK)]));
    await asUser(rep.id, (q) => q("update public.booking_pages set is_active = true where id = $1", [pageId]));
    expect(await publicPage(token)).toHaveProperty("slots");
    await asAdmin(async (q) => {
      await q("update public.org_calendar_settings set working_hours = null where organization_id = $1", [org]);
      await q("update public.profiles set working_hours = $2 where id = $1", [rep.id, JSON.stringify(ALL_WEEK)]);
    });
  });

  it("no slots before the minimum notice, or past the days ahead", async () => {
    // a minimum notice of 5 days hides the target day (3 days ahead)
    await asUser(rep.id, (q) => q("update public.booking_pages set min_notice_minutes = 7200 where id = $1", [pageId]));
    expect((await slotsOf(token)).filter((s) => s.startsWith(target))).toEqual([]);
    await asUser(rep.id, (q) => q("update public.booking_pages set min_notice_minutes = 0, max_days_ahead = 2 where id = $1", [pageId]));
    expect((await slotsOf(token)).filter((s) => s.startsWith(target))).toEqual([]);
    expect((await publicPage(token, dayAhead(40))).from).toBe(dayAhead(2));
    await asUser(rep.id, (q) => q("update public.booking_pages set max_days_ahead = 14 where id = $1", [pageId]));
  });

  it("only the server may call the public functions", async () => {
    for (const run of [asAnon, (fn: Parameters<typeof asAnon>[0]) => asUser(rep.id, fn)]) {
      expect((await pgError(run((q) => q("select public.booking_page_public($1)", [token])))).code).toBe("42501");
      expect((await pgError(run((q) => q("select public.booking_submit($1, now(), '{}'::jsonb)", [token])))).code).toBe("42501");
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
              where n.nspname = 'public' and p.proname in ('booking_page_public', 'booking_submit') order by 1`,
          )
        ).rows,
    );
    expect(fns).toEqual([
      { name: "booking_page_public", definer: true, anon: false, authed: false, service: true },
      { name: "booking_submit", definer: true, anon: false, authed: false, service: true },
    ]);
  });

  it("not found: unknown token, page off, rep gone or a viewer, type off, business closed or without the flag; read-only is unavailable", async () => {
    const notFound = async () => (await pgError(publicPage(token))).code;
    expect((await pgError(publicPage("0".repeat(32)))).code).toBe("P0002");
    expect((await pgError(publicPage(""))).code).toBe("P0002");

    await asUser(rep.id, (q) => q("update public.booking_pages set is_active = false where id = $1", [pageId]));
    expect(await notFound()).toBe("P0002");
    await asUser(rep.id, (q) => q("update public.booking_pages set is_active = true where id = $1", [pageId]));

    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, rep.id]));
    expect(await notFound()).toBe("P0002");
    await asAdmin((q) => q("update public.memberships set status = 'active', role = 'viewer', seat_type = 'view' where organization_id = $1 and user_id = $2", [org, rep.id]));
    expect(await notFound()).toBe("P0002");
    await asAdmin((q) => q("update public.memberships set role = 'member', seat_type = 'full' where organization_id = $1 and user_id = $2", [org, rep.id]));

    await asAdmin((q) => q("update public.meeting_types set is_active = false where id = $1", [type]));
    expect(await notFound()).toBe("P0002");
    await asAdmin((q) => q("update public.meeting_types set is_active = true where id = $1", [type]));

    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"booking_page\": false}' where organization_id = $1", [org]));
    expect(await notFound()).toBe("P0002");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'booking_page' where organization_id = $1", [org]));

    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    expect(await notFound()).toBe("P0002");
    // read-only or suspended: "not available now", with nothing of the business
    for (const status of ["read_only", "suspended"]) {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
      expect(await publicPage(token)).toEqual({ unavailable: true });
      expect((await pgError(book(token, at(target, "10:00"), { full_name: "x", phone: "0501234567" }))).hint).toBe("booking:unavailable");
    }
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    expect(await publicPage(token)).toHaveProperty("slots");
  });

  it("a booking of a new person: a lead of the rep from the page's source, and the meeting with the answers and the type's buffers", async () => {
    const result = await book(token, at(target, "10:00"), {
      full_name: "יעל לקוחה",
      phone: "050-7771111",
      email: "Yael@Example.test",
      answers: { goal: "לשפר מכירות", notes: "", unknown: "נזרק" },
      attribution: { utm_source: "google", utm_campaign: "סתיו" },
    });
    expect(Object.keys(result).sort()).toEqual(["ends_at", "meeting", "rep", "starts_at", "status", "time_zone"]);
    expect(result).toMatchObject({ status: "booked", rep: "דנה הנציגה", meeting: { name: "ייעוץ ראשון", format: "in_person", location: "רחוב הרצל 1" } });
    const lead = await asAdmin(
      async (q) =>
        (
          await q<{ id: string; owner_id: string; source_id: string; email: string; campaign: string }>(
            "select id, owner_id, source_id, email, campaign from public.leads where organization_id = $1 and phone_e164 = '+972507771111'",
            [org],
          )
        ).rows,
    );
    expect(lead).toHaveLength(1);
    expect(lead[0]).toMatchObject({ owner_id: rep.id, source_id: source, email: "yael@example.test", campaign: "סתיו" });
    const meeting = await asAdmin(
      async (q) =>
        (
          await q<{ owner_id: string; lead_id: string; meeting_type_id: string; buffer_before_minutes: number; buffer_after_minutes: number; description: string; title: string; status: string }>(
            "select owner_id, lead_id, meeting_type_id, buffer_before_minutes, buffer_after_minutes, description, title, status from public.meetings where organization_id = $1 and starts_at = $2 and status <> 'cancelled'",
            [org, at(target, "10:00")],
          )
        ).rows,
    );
    expect(meeting).toHaveLength(1);
    expect(meeting[0]).toMatchObject({ owner_id: rep.id, lead_id: lead[0].id, meeting_type_id: type, buffer_before_minutes: 15, buffer_after_minutes: 15, status: "planned", title: "ייעוץ ראשון: יעל לקוחה" });
    expect(meeting[0].description).toContain("מה תרצו להשיג?: לשפר מכירות");
    expect(meeting[0].description).not.toContain("נזרק");
    // the rep is told
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'meeting_scheduled'", [rep.id]))).toBeGreaterThanOrEqual(1);
    // the slot is gone, and so is 09:00 (its buffer after touches the new meeting)
    const left = (await slotsOf(token)).filter((s) => s.startsWith(target));
    expect(left).toEqual(["14:00", "15:00", "16:00"].map((h) => at(target, h)));
    // booking it again: refused with an answer (not an error), so the refused attempt stays counted
    const refusedBefore = await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'refused'", [pageId]));
    expect(await book(token, at(target, "10:00"), { full_name: "שני", phone: "0507772222", answers: { goal: "x" } })).toEqual({ status: "slot_taken" });
    // a time that was never a slot (outside hours, off the step, in the past, far ahead): invalid, not a race
    for (const when of [at(target, "20:00"), at(target, "14:30"), new Date(Date.now() - DAY).toISOString(), at(dayAhead(40), "10:00")]) {
      expect(await book(token, when, { full_name: "שני", phone: "0507772222", answers: { goal: "x" } })).toEqual({ status: "invalid_time" });
    }
    // only the race counts toward closing the page
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'refused'", [pageId]))).toBe(refusedBefore + 1);
    // nothing was made for the refused attempts
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone_e164 = '+972507772222'", [org]))).toBe(0);
  });

  it("an existing record is linked by phone: a lead, else a contact by any of its phones; never another business's", async () => {
    // a lead with that phone in another business, and none here
    await insertLead(outsider.id, otherOrg, { full_name: "זר", phone: "0508883333" });
    const leadHere = await insertLead(other.id, org, { full_name: "ליד קיים", phone: "0508884444", owner_id: other.id });
    const contact = await asUser(owner.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'איש קשר', '0508885555') returning id", [org])).rows[0].id;
      await q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', '0508886666')", [org, id]);
      return id;
    });
    const leadsBefore = await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]));

    // two hours apart, so the buffers never touch
    const day = dayAhead(4);
    await book(token, at(day, "09:00"), { full_name: "ליד קיים", phone: "+972-50-888-4444", answers: { goal: "א" } });
    await book(token, at(day, "11:00"), { full_name: "איש קשר", phone: "050 888 6666", answers: { goal: "ב" } });
    await book(token, at(day, "13:00"), { full_name: "חדש כאן", phone: "0508883333", answers: { goal: "ג" } });

    const meetings = await asAdmin(
      async (q) =>
        (
          await q<{ h: string; lead_id: string | null; contact_id: string | null }>(
            "select to_char(starts_at at time zone 'UTC', 'HH24:MI') as h, lead_id, contact_id from public.meetings where organization_id = $1 and starts_at::date = $2 and title like 'ייעוץ ראשון:%' order by starts_at",
            [org, day],
          )
        ).rows,
    );
    expect(meetings.find((m) => m.h === "09:00")).toMatchObject({ lead_id: leadHere, contact_id: null });
    expect(meetings.find((m) => m.h === "11:00")).toMatchObject({ lead_id: null, contact_id: contact });
    // the other business's lead with this phone is never touched: a new lead here
    const fresh = meetings.find((m) => m.h === "13:00");
    expect(fresh?.lead_id).toBeTruthy();
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(leadsBefore + 1);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and id = $2", [otherOrg, fresh?.lead_id]))).toBe(0);
    // the existing records got a timeline entry naming the booking
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where organization_id = $1 and type = 'inquiry' and lead_id = $2 and metadata ? 'booking_page_id'", [org, leadHere]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where organization_id = $1 and type = 'inquiry' and contact_id = $2 and metadata ? 'booking_page_id'", [org, contact]))).toBe(1);
    // the other business's page books in that business only
    expect((await slotsOf(otherToken)).length).toBeGreaterThan(0);
  });

  it("never links a record in the recycle bin; a new lead gets the source \"דף קביעת תור\" and the page's name", async () => {
    const day = dayAhead(8);
    // a lead in the bin, a contact in the bin, and a live lead whose contact is in the bin
    const binLead = await insertLead(other.id, org, { full_name: "בסל", phone: "0509990001", owner_id: other.id });
    const binContact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'איש בסל', '0509990002') returning id", [org])).rows[0].id,
    );
    const liveLead = await insertLead(other.id, org, { full_name: "חי", phone: "0509990003", owner_id: other.id });
    const goneContact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'הומר', '0509990004') returning id", [org])).rows[0].id,
    );
    await asAdmin(async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [binLead]);
      await q("update public.contacts set deleted_at = now() where id = any($1::uuid[])", [[binContact, goneContact]]);
      await q("update public.leads set converted_contact_id = $2 where id = $1", [liveLead, goneContact]);
    });
    // a page without a source of its own
    const page = await newPage(rep, org, { meeting_type_id: type, min_notice_minutes: 0, slot_step_minutes: 60, title: "תורים לסדנה" });
    await book(page.token, at(day, "09:00"), { full_name: "בסל", phone: "0509990001" });
    await book(page.token, at(day, "11:00"), { full_name: "איש בסל", phone: "0509990002" });
    await book(page.token, at(day, "13:00"), { full_name: "חי", phone: "0509990003" }, null);
    await book(page.token, at(day, "15:00"), { full_name: "עם קמפיין", phone: "0509990005", attribution: { utm_campaign: "חורף" } });
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ h: string; lead_id: string | null; contact_id: string | null; source: string | null; kind: string | null; campaign: string | null; deleted: boolean | null }>(
            `select to_char(m.starts_at at time zone 'UTC', 'HH24:MI') as h, m.lead_id, m.contact_id, s.name as source, s.kind, l.campaign, l.deleted_at is not null as deleted
               from public.meetings m
               left join public.leads l on l.organization_id = m.organization_id and l.id = m.lead_id
               left join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
              where m.organization_id = $1 and m.starts_at::date = $2 and m.title like 'ייעוץ ראשון:%' order by m.starts_at`,
            [org, day],
          )
        ).rows,
    );
    expect(rows).toHaveLength(4);
    // the bin: a new lead each time, from the page's default source, named by the page
    for (const r of rows.slice(0, 2)) {
      expect(r).toMatchObject({ contact_id: null, source: "דף קביעת תור", kind: "booking", campaign: "תורים לסדנה", deleted: false });
      expect([binLead]).not.toContain(r.lead_id);
    }
    // the live lead is linked, without its contact in the bin
    expect(rows[2]).toMatchObject({ lead_id: liveLead, contact_id: null });
    // the visit's campaign wins over the page's name
    expect(rows[3]).toMatchObject({ source: "דף קביעת תור", campaign: "חורף" });
    // the source was made once and is reused
    expect(await asAdmin((q) => count(q, "select 1 from public.lead_sources where organization_id = $1 and kind = 'booking'", [org]))).toBe(1);
  });

  it("checks the person and the answers", async () => {
    const day = dayAhead(5);
    const ok = { full_name: "בודק", phone: "0507779999", answers: { goal: "בדיקה" } };
    expect((await pgError(book(token, at(day, "09:00"), { ...ok, full_name: " " }))).hint).toBe("booking:full_name");
    expect((await pgError(book(token, at(day, "09:00"), { ...ok, phone: "abc" }))).hint).toBe("booking:phone");
    expect((await pgError(book(token, at(day, "09:00"), { ...ok, email: "not-an-email" }))).hint).toBe("booking:email");
    expect((await pgError(book(token, at(day, "09:00"), { ...ok, answers: { notes: "x" } }))).hint).toBe("booking:answer");
    expect((await pgError(book(token, at(day, "09:00"), { ...ok, answers: { goal: 5 } }))).hint).toBe("booking:answer");
  });

  it("rate limits: 5 attempts per sender in 10 minutes; spam is logged, never booked; hashes are cleared after the window", async () => {
    const hash = "h".repeat(64);
    for (let i = 0; i < 5; i++) expect(await book(token, at(dayAhead(6), "09:00"), {}, hash, true)).toEqual({ status: "spam" });
    expect((await pgError(book(token, at(dayAhead(6), "09:00"), { full_name: "x", phone: "0507770000", answers: { goal: "x" } }, hash))).hint).toBe("rate_limited");
    // another sender still books
    expect((await book(token, at(dayAhead(6), "09:00"), { full_name: "אחר", phone: "0507770001", answers: { goal: "x" } }, "k".repeat(64))).status).toBe("booked");
    // the hashes are kept only for the window
    await asAdmin((q) => q("update app.booking_requests set created_at = now() - interval '20 minutes' where ip_hash = $1", [hash]));
    const cleared = await asAdmin(async (q) => (await q<{ n: number }>("select app.clear_booking_ip_hashes() as n")).rows[0].n);
    expect(cleared).toBe(5);
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where ip_hash = $1", [hash]))).toBe(0);
  });

  it("view limit: 60 per sender in 10 minutes, then nothing is worked out; views never close a page and leave no rows", async () => {
    const view = (h: string | null) =>
      asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.booking_page_public($1, $2, $3) as r", [token, target, h])).rows[0].r);
    const sender = "v".repeat(64);
    const requestsBefore = await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1", [pageId]));
    for (let i = 0; i < 60; i++) expect(await view(sender)).toHaveProperty("slots");
    expect(await view(sender)).toEqual({ rate_limited: true });
    // one counter row for the sender's bucket, no row per view, no hash kept
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1", [pageId]))).toBe(requestsBefore);
    const counters = await asAdmin(async (q) => (await q<{ views: number }>("select views from app.booking_view_counts where page_id = $1", [pageId])).rows);
    // counted first (the refused view too), so parallel views cannot pass the limit
    expect(counters).toEqual([{ views: 61 }]);
    // others still see the page, with or without a sender hash, however many views there are
    for (let i = 0; i < 100; i++) expect(await view(null)).toHaveProperty("slots");
    expect(await view("w".repeat(64))).toHaveProperty("slots");
    // the next window reuses the counter (an update, never a new row)
    await asAdmin((q) => q("update app.booking_view_counts set window_start = now() - interval '11 minutes' where page_id = $1", [pageId]));
    expect(await view(sender)).toHaveProperty("slots");
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_view_counts where page_id = $1", [pageId]))).toBe(2);
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select max(views)::int as n from app.booking_view_counts where page_id = $1", [pageId])).rows[0].n)).toBe(1);
  });

  it("a burst in parallel on separate connections: only 5 attempts of one sender pass", async () => {
    const hash = "p".repeat(64);
    const clients = Array.from({ length: 12 }, () => new Client({ connectionString: TEST_DB_URL }));
    await Promise.all(clients.map((c) => c.connect()));
    try {
      const results = await Promise.all(
        clients.map(async (c) => {
          await c.query("begin");
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
          await c.query("set local role service_role");
          try {
            const r = (await c.query<{ r: { status: string } }>("select public.booking_submit($1, $2, '{}'::jsonb, $3, null, true) as r", [token, at(dayAhead(6), "09:00"), hash])).rows[0].r;
            // hold the transaction open a moment, so the calls overlap
            await c.query("select pg_sleep(0.2)");
            await c.query("commit");
            return r.status;
          } catch (error) {
            await c.query("rollback");
            return (error as { hint?: string }).hint ?? "error";
          }
        }),
      );
      expect(results.filter((r) => r === "spam")).toHaveLength(5);
      expect(results.filter((r) => r === "rate_limited")).toHaveLength(7);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and ip_hash = $2", [pageId, hash]))).toBe(5);
  });

  it("spam counts only against its sender: 60 spam posts from many senders do not shut the page", async () => {
    for (let s = 0; s < 12; s++) {
      for (let i = 0; i < 5; i++) expect(await book(token, at(dayAhead(6), "10:00"), {}, `-${s}`.padStart(64, "s"), true)).toEqual({ status: "spam" });
    }
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'spam' and created_at > now() - interval '1 hour'", [pageId]))).toBeGreaterThanOrEqual(60);
    expect((await book(token, at(dayAhead(6), "11:00"), { full_name: "לקוח אמיתי", phone: "0507770202", answers: { goal: "x" } }, "f".repeat(64))).status).toBe("booked");
  });

  it("200 failed attempts within an hour close the page for an hour and tell its rep and the owners once", async () => {
    const notices = () =>
      asAdmin(async (q) =>
        (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and type = 'system' and title = 'דף קביעת תור נסגר לשעה' order by user_id", [org])).rows.map(
          (r) => r.user_id,
        ),
      );
    const failed = await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'refused' and created_at > now() - interval '1 hour'", [pageId]));
    // 200 junk posts with no sender hash (no time, a time long past, off the grid, outside the hours) never close it
    const junk = await asService(
      async (q) =>
        (
          await q<{ s: string }>(
            `select public.booking_submit($1, case i % 4 when 0 then null when 1 then '2000-01-01T00:00:00Z'::timestamptz
                                                     when 2 then $2::timestamptz when 3 then $3::timestamptz end,
                                          '{"full_name": "זבל", "phone": "0507770999", "answers": {"goal": "x"}}'::jsonb) ->> 'status' as s
               from generate_series(1, 200) i`,
            [token, at(target, "14:30"), at(target, "20:00")],
          )
        ).rows.map((r) => r.s),
    );
    expect(new Set(junk)).toEqual(new Set(["invalid_time"]));
    expect(await publicPage(token)).toHaveProperty("slots");
    expect(await notices()).toEqual([]);
    // so do posts for a time an old meeting holds (it was never offered free)
    await asAdmin(async (q) => {
      // touch_row keeps created_at; the test backdates the meeting with triggers off for this one statement
      await q("set local session_replication_role = replica");
      await q("update public.meetings set created_at = now() - interval '2 hours' where organization_id = $1 and starts_at = $2", [org, at(target, "12:00")]);
    });
    expect(await book(token, at(target, "12:00"), { full_name: "x", phone: "0507770303", answers: { goal: "x" } }, "o".repeat(64))).toEqual({ status: "slot_taken" });
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'refused' and created_at > now() - interval '1 hour'", [pageId]))).toBe(failed);
    // one real booking and 200 re-posts of its time (each a race: the meeting is from this hour) count once
    const reposts = await asService(
      async (q) =>
        (
          await q<{ s: string }>(
            `select public.booking_submit($1, $2::timestamptz, '{"full_name": "שוב", "phone": "0507770998", "answers": {"goal": "x"}}'::jsonb) ->> 'status' as s
               from generate_series(1, 200) i`,
            [token, at(target, "10:00")],
          )
        ).rows.map((r) => r.s),
    );
    expect(new Set(reposts)).toEqual(new Set(["slot_taken"]));
    const counted = await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'refused' and created_at > now() - interval '1 hour'", [pageId]));
    expect(counted).toBeLessThanOrEqual(failed + 1);
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_requests where page_id = $1 and outcome = 'refused' and starts_at = $2 and created_at > now() - interval '1 hour'", [pageId, at(target, "10:00")]))).toBe(1);
    expect(await publicPage(token)).toHaveProperty("slots");
    expect(await notices()).toEqual([]);
    // 200 different real races do close it: 198 before (rows, each its own time), then two more through the page,
    // at two times booked earlier in this run
    await asAdmin((q) =>
      q(
        "insert into app.booking_requests (page_id, organization_id, ip_hash, outcome, starts_at) select $1, $2, null, 'refused', now() + make_interval(days => 30, mins => i) from generate_series(1, $3::int) i",
        [pageId, org, 198 - counted],
      ),
    );
    expect(await book(token, at(dayAhead(4), "09:00"), { full_name: "x", phone: "0507770303", answers: { goal: "x" } }, "g".repeat(64))).toEqual({ status: "slot_taken" });
    expect(await notices()).toEqual([]);
    expect(await publicPage(token)).toHaveProperty("slots");
    // the 200th
    expect(await book(token, at(dayAhead(4), "11:00"), { full_name: "x", phone: "0507770303", answers: { goal: "x" } }, "h2".padEnd(64, "h"))).toEqual({ status: "slot_taken" });
    expect(await notices()).toEqual([owner.id, rep.id].sort());
    // closed: the page is "not available now", a booking is refused before anything is checked
    expect(await publicPage(token)).toEqual({ unavailable: true });
    expect((await pgError(book(token, at(dayAhead(6), "13:00"), { full_name: "x", phone: "0507770304", answers: { goal: "x" } }, "i".repeat(64)))).hint).toBe("booking:closed");
    expect(await notices()).toHaveLength(2);
    // an hour later it opens by itself
    await asAdmin(async (q) => {
      await q("update app.booking_page_closures set closed_until = now() - interval '1 second' where page_id = $1", [pageId]);
      await q("update app.booking_requests set created_at = now() - interval '2 hours' where page_id = $1", [pageId]);
    });
    expect(await publicPage(token)).toHaveProperty("slots");
    expect((await book(token, at(dayAhead(6), "13:00"), { full_name: "אחרי הסגירה", phone: "0507770305", answers: { goal: "x" } }, "j".repeat(64))).status).toBe("booked");
    expect(await notices()).toHaveLength(2);
  });

  it("the plan: the booking_page flag and the allowance (business + per full seat)", async () => {
    const setPlan = (features: Record<string, unknown>, limits: Record<string, unknown>) =>
      asAdmin((q) => q("update public.subscriptions set feature_overrides = $2, limit_overrides = $3 where organization_id = $1", [org, JSON.stringify(features), JSON.stringify(limits)]));
    await setPlan({ booking_page: false }, {});
    expect((await pgError(newPage(other, org, { meeting_type_id: type }))).hint).toBe("feature:booking_page");
    const pages = await asAdmin((q) => count(q, "select 1 from public.booking_pages where organization_id = $1", [org]));
    const seats = await asAdmin((q) => count(q, "select 1 from public.memberships where organization_id = $1 and status = 'active' and seat_type = 'full'", [org]));
    // exactly full now: business-wide 0, per seat so that seats x per = pages
    await setPlan({ booking_page: true }, { max_booking_pages: pages, max_booking_pages_per_user: 0 });
    expect((await pgError(newPage(other, org, { meeting_type_id: type }))).hint).toBe("limit:max_booking_pages");
    await setPlan({ booking_page: true }, { max_booking_pages: 0, max_booking_pages_per_user: Math.ceil((pages + 1) / seats) });
    expect((await newPage(other, org, { meeting_type_id: type })).token).toMatch(/^[0-9a-f]{32}$/);
    // a null (unlimited) value of either key is unlimited, even when the other one is full (0 here, so "and" in place
    // of "or" in the null check would refuse)
    await setPlan({ booking_page: true }, { max_booking_pages: null, max_booking_pages_per_user: 0 });
    expect((await newPage(other, org, { meeting_type_id: type })).token).toMatch(/^[0-9a-f]{32}$/);
    await setPlan({ booking_page: true }, { max_booking_pages: 0, max_booking_pages_per_user: null });
    expect((await newPage(other, org, { meeting_type_id: type })).token).toMatch(/^[0-9a-f]{32}$/);
    await setPlan({}, {});
  });

  it("checks a page's questions, rep and meeting type", async () => {
    expect((await pgError(newPage(other, org, { meeting_type_id: type, questions: [{ id: "a", label: "", required: true }] }))).hint).toBe("booking_page:questions");
    expect(
      (await pgError(newPage(other, org, { meeting_type_id: type, questions: [{ id: "a", label: "א", required: true }, { id: "a", label: "ב", required: false }] }))).hint,
    ).toBe("booking_page:questions");
    expect((await pgError(newPage(other, org, { meeting_type_id: type, questions: [{ id: "a", label: "א", required: "yes" }] }))).hint).toBe("booking_page:questions");
    const off = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.meeting_types (organization_id, name, is_active) values ($1, 'כבוי', false) returning id", [org])).rows[0].id,
    );
    expect((await pgError(newPage(other, org, { meeting_type_id: off }))).hint).toBe("booking_page:type");
    // a type of another business cannot be referenced at all
    const foreign = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 limit 1", [otherOrg])).rows[0].id);
    expect((await pgError(newPage(other, org, { meeting_type_id: foreign }))).code).toMatch(/^(23503|22023)$/);
    // an outsider: plain RLS refusal, nothing about the business
    expect((await pgError(newPage(outsider, org, { meeting_type_id: type }))).code).toBe("42501");
  });
});

/**
 * The slots are worked out as ranges (review of 15 October 2026). They must equal the CAP-09 rule as it was
 * checked before, minute by minute: app.member_in_hours at every 15 minutes of the meeting and at its last
 * minute. The fixture mixes split hours, the older one-range shape, a day to midnight ("23:59"), a rest day of the
 * business (its zone), leave (the rep's zone) and a rep in another zone than the business; and the business's
 * hours for a rep with none of their own.
 */
describe("booking slots equal the CAP-09 rule (CAL-10)", () => {
  let org: string;
  let owner: U, rep: U, plain: U;

  const sampled = (pageId: string, from: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ s: Date }>(
            `with p as (
               select b.*, t.duration_minutes as dur, app.intake_zone(o.timezone) as zone
                 from public.booking_pages b
                 join public.meeting_types t on t.organization_id = b.organization_id and t.id = b.meeting_type_id
                 join public.organizations o on o.id = b.organization_id
                where b.id = $1),
             c as (
               select p.*, (local_t at time zone p.zone) as s
                 from p cross join lateral generate_series($2::date::timestamp, ($2::date + 6)::timestamp + interval '1 day' - make_interval(mins => p.slot_step_minutes),
                                                           make_interval(mins => p.slot_step_minutes)) local_t)
             select c.s from c
              where c.s >= now()
                and app.member_in_hours(c.organization_id, c.user_id, c.s + make_interval(mins => c.dur) - interval '1 minute')
                and not exists (select 1 from generate_series(c.s, c.s + make_interval(mins => c.dur) - interval '1 minute', interval '15 minutes') x
                                 where not app.member_in_hours(c.organization_id, c.user_id, x))
              order by c.s`,
            [pageId, from],
          )
        ).rows.map((r) => r.s.toISOString()),
    );
  const ranged = (pageId: string, from: string) =>
    asAdmin(async (q) => (await q<{ s: Date }>("select s from app.booking_slots($1, $2::date, 7) s", [pageId, from])).rows.map((r) => r.s.toISOString()));

  beforeAll(async () => {
    owner = await createUser("bks-owner");
    org = await createOrg(owner.id, "עסק השעות");
    rep = await addMember(org, owner.id, "member", "bks-rep");
    plain = await addMember(org, owner.id, "member", "bks-plain");
    const today = dayAhead(0);
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]);
      // Saturday off, the business's hours for whoever has none of their own
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{6}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{6}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify({ sun: [{ start: "08:30", end: "12:00" }, { start: "12:45", end: "18:15" }], mon: { start: "07:00", end: "23:59" }, tue: [{ start: "09:00", end: "10:30" }], wed: [{ start: "09:00", end: "17:00" }], thu: [{ start: "10:00", end: "23:59" }], fri: [{ start: "08:00", end: "13:00" }], sat: [{ start: "09:00", end: "17:00" }] })],
      );
      // the rep works in New York time: split days, the older one-range shape, days to midnight
      await q("update public.profiles set timezone = 'America/New_York', working_hours = $2 where id = $1", [
        rep.id,
        JSON.stringify({
          sun: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:30" }],
          mon: { start: "08:00", end: "23:59" },
          tue: [{ start: "04:00", end: "11:45" }, { start: "12:15", end: "23:59" }],
          wed: [{ start: "10:00", end: "11:15" }],
          thu: [{ start: "06:00", end: "14:00" }, { start: "15:00", end: "16:30" }, { start: "20:00", end: "23:59" }],
          fri: [{ start: "09:00", end: "23:59" }],
          sat: [{ start: "10:00", end: "14:00" }],
        }),
      ]);
      await q("update public.profiles set timezone = null, working_hours = null where id = $1", [plain.id]);
      // two days of leave, three days from now (the rep's own dates)
      const leave = new Date(`${today}T00:00:00Z`).getTime() + 3 * DAY;
      await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, $3, $4)", [
        org,
        rep.id,
        new Date(leave).toISOString().slice(0, 10),
        new Date(leave + DAY).toISOString().slice(0, 10),
      ]);
    });
  });

  for (const minutes of [60, 240, 45]) {
    it(`a ${minutes}-minute meeting, every 15 minutes, over a week: the same starts`, async () => {
      const type = await asUser(owner.id, async (q) =>
        (await q<{ id: string }>("insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, $2, $3) returning id", [org, `סוג ${minutes}`, minutes])).rows[0].id,
      );
      for (const who of [rep, plain]) {
        const page = (
          await asAdmin(
            async (q) =>
              (
                await q<{ id: string }>(
                  "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'דף', $3, 0, 30, 15) returning id",
                  [org, who.id, type],
                )
              ).rows[0],
          )
        ).id;
        for (const from of [dayAhead(1), dayAhead(8)]) {
          const expected = await sampled(page, from);
          expect(expected.length).toBeGreaterThan(0);
          expect(await ranged(page, from)).toEqual(expected);
        }
      }
    });
  }
});

/**
 * Who may write a booking page, in statements that only the write policies judge (no WHERE, no RETURNING),
 * so that each part of each policy is needed: the person check, can_write and is_member.
 */
describe("booking pages: each part of the policies is needed (CAL-10)", () => {
  let org: string;
  let owner: U, repA: U, repB: U, idle: U, viewer: U, gone: U;
  const pages: Record<string, string> = {};

  const titleOf = (id: string) => asAdmin(async (q) => (await q<{ title: string }>("select title from public.booking_pages where id = $1", [id])).rows[0]?.title);
  const ownerOf = (id: string) => asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.booking_pages where id = $1", [id])).rows[0]?.user_id);
  const total = () => asAdmin((q) => count(q, "select 1 from public.booking_pages where organization_id = $1", [org]));
  const rowCount = (who: U, sql: string, params: unknown[] = []) => asUser(who.id, async (q) => (await q(sql, params)).rowCount);

  beforeAll(async () => {
    owner = await createUser("bkp-owner");
    org = await createOrg(owner.id, "עסק ההרשאות");
    repA = await addMember(org, owner.id, "member", "bkp-a");
    repB = await addMember(org, owner.id, "member", "bkp-b");
    idle = await addMember(org, owner.id, "member", "bkp-idle");
    viewer = await addMember(org, owner.id, "member", "bkp-viewer");
    gone = await addMember(org, owner.id, "member", "bkp-gone");
    await asAdmin((q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, working_hours) values ($1, $2)
         on conflict (organization_id) do update set working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      ),
    );
    for (const [key, who] of [["a", repA], ["b", repB], ["viewer", viewer], ["gone", gone]] as const) {
      pages[key] = await asUser(who.id, async (q) =>
        (await q<{ id: string }>("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'מקור') returning id", [org, who.id])).rows[0].id,
      );
    }
    // a viewer who still owns a page, and a suspended member who owns one
    await asAdmin(async (q) => {
      await q("update public.memberships set role = 'viewer', seat_type = 'view' where organization_id = $1 and user_id = $2", [org, viewer.id]);
      await q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, gone.id]);
    });
  });

  it("a member cannot make a page for another rep (insert: the person check)", async () => {
    expect((await pgError(asUser(idle.id, (q) => q("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'זר')", [org, repA.id])))).code).toBe("42501");
    expect(await total()).toBe(4);
  });

  it("a member's update or delete without a WHERE reaches only their own pages (update USING, delete: the person check)", async () => {
    expect(await rowCount(idle, "update public.booking_pages set title = 'נחטף'")).toBe(0);
    expect(await titleOf(pages.a)).toBe("מקור");
    expect(await rowCount(idle, "delete from public.booking_pages")).toBe(0);
    expect(await total()).toBe(4);
    // their own: yes
    expect(await rowCount(repA, "update public.booking_pages set title = 'שלי'")).toBe(1);
    expect(await titleOf(pages.a)).toBe("שלי");
    expect(await titleOf(pages.b)).toBe("מקור");
  });

  it("a member cannot hand their own page to someone else (update CHECK: the person check)", async () => {
    expect((await pgError(asUser(repA.id, (q) => q("update public.booking_pages set user_id = $1", [repB.id])))).code).toBe("42501");
    expect(await ownerOf(pages.a)).toBe(repA.id);
    // an admin may
    await asUser(owner.id, (q) => q("update public.booking_pages set user_id = $1 where id = $2", [repB.id, pages.a]));
    expect(await ownerOf(pages.a)).toBe(repB.id);
    await asUser(owner.id, (q) => q("update public.booking_pages set user_id = $1 where id = $2", [repA.id, pages.a]));
  });

  it("a viewer who still owns a page cannot write it (can_write)", async () => {
    expect((await pgError(asUser(viewer.id, (q) => q("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'צופה')", [org, viewer.id])))).code).toBe("42501");
    expect(await rowCount(viewer, "update public.booking_pages set title = 'צופה'")).toBe(0);
    expect(await titleOf(pages.viewer)).toBe("מקור");
    expect(await rowCount(viewer, "delete from public.booking_pages")).toBe(0);
    expect(await total()).toBe(4);
    // but reads it
    expect(await asUser(viewer.id, (q) => count(q, "select 1 from public.booking_pages where organization_id = $1", [org]))).toBe(1);
  });

  it("nobody writes in a read-only business (can_write)", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      for (const who of [owner, repA]) {
        expect((await pgError(asUser(who.id, (q) => q("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'בקריאה')", [org, who.id])))).code).toBe("42501");
        expect(await rowCount(who, "update public.booking_pages set title = 'בקריאה'")).toBe(0);
        expect(await rowCount(who, "delete from public.booking_pages")).toBe(0);
      }
      expect(await titleOf(pages.b)).toBe("מקור");
      expect(await total()).toBe(4);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a suspended member does not read their own page (select: is_member)", async () => {
    expect(await asUser(gone.id, (q) => count(q, "select 1 from public.booking_pages"))).toBe(0);
    expect(await asUser(repA.id, (q) => count(q, "select 1 from public.booking_pages"))).toBe(1);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.booking_pages where organization_id = $1", [org]))).toBe(4);
  });
});

/**
 * Owner, 15 October 2026: a team manager (role manager) manages the pages of the `member`-role people of the teams
 * they manage or a team below; never another manager's, an admin's, the owner's, or anyone outside those teams. A
 * `member` marked as a team's manager gets nothing more.
 */
describe("booking pages: a team manager manages their people's pages (CAL-10)", () => {
  let org: string;
  let owner: U, mgr: U, inTeam: U, inChild: U, outside: U, peerMgr: U, admin: U, flagged: U;
  const pages: Record<string, string> = {};

  const titleOf = (id: string) => asAdmin(async (q) => (await q<{ title: string }>("select title from public.booking_pages where id = $1", [id])).rows[0]?.title);
  const ownerOf = (id: string) => asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.booking_pages where id = $1", [id])).rows[0]?.user_id);
  const visible = (who: U) =>
    asUser(who.id, async (q) => (await q<{ id: string }>("select id from public.booking_pages where organization_id = $1 order by id", [org])).rows.map((r) => r.id));
  const keysOf = (ids: string[]) => Object.entries(pages).filter(([, id]) => ids.includes(id)).map(([k]) => k).sort();

  beforeAll(async () => {
    owner = await createUser("bkm-owner");
    org = await createOrg(owner.id, "עסק הצוותים");
    mgr = await addMember(org, owner.id, "manager", "bkm-mgr");
    inTeam = await addMember(org, owner.id, "member", "bkm-in");
    inChild = await addMember(org, owner.id, "member", "bkm-child");
    outside = await addMember(org, owner.id, "member", "bkm-out");
    peerMgr = await addMember(org, owner.id, "manager", "bkm-peer");
    admin = await addMember(org, owner.id, "admin", "bkm-admin");
    flagged = await addMember(org, owner.id, "member", "bkm-flagged");
    await asAdmin(async (q) => {
      await q(
        `insert into public.org_calendar_settings (organization_id, working_hours) values ($1, $2)
         on conflict (organization_id) do update set working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      );
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      const child = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'מכירות צפון', $2) returning id", [org, team])).rows[0].id;
      const other = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'שירות') returning id", [org])).rows[0].id;
      for (const [t, u, m] of [
        [team, mgr.id, true],
        [team, inTeam.id, false],
        [child, inChild.id, false],
        [team, peerMgr.id, false],
        [team, admin.id, false],
        [other, outside.id, false],
        // a member marked manager of the team: the role decides, so nothing more
        [team, flagged.id, true],
      ] as const) {
        await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, $4)", [org, t, u, m]);
      }
    });
    for (const [key, who] of [["mgr", mgr], ["inTeam", inTeam], ["inChild", inChild], ["outside", outside], ["peerMgr", peerMgr], ["admin", admin], ["flagged", flagged]] as const) {
      pages[key] = await asUser(who.id, async (q) =>
        (await q<{ id: string }>("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'מקור') returning id", [org, who.id])).rows[0].id,
      );
    }
  });

  it("reads their own and their people's pages, in the team and the team below; nobody else's", async () => {
    // flagged is a member of the team (its manager mark gives them nothing), so their page is the manager's too
    expect(keysOf(await visible(mgr))).toEqual(["flagged", "inChild", "inTeam", "mgr"]);
    expect(keysOf(await visible(flagged))).toEqual(["flagged"]);
    expect(keysOf(await visible(peerMgr))).toEqual(["peerMgr"]);
    expect((await visible(owner)).length).toBe(7);
  });

  it("makes a page for a person of the team, not for anyone else", async () => {
    const make = (who: U, rep: U) => asUser(who.id, (q) => q("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'חדש')", [org, rep.id]));
    await make(mgr, inChild);
    for (const rep of [outside, peerMgr, admin, owner]) expect((await pgError(make(mgr, rep))).code).toBe("42501");
    expect((await pgError(make(flagged, inTeam))).code).toBe("42501");
  });

  it("an update without a WHERE reaches exactly their own and their people's pages", async () => {
    // their own, inTeam, inChild, flagged and the page made for inChild above
    expect((await asUser(mgr.id, (q) => q("update public.booking_pages set title = 'מנהל'"))).rowCount).toBe(5);
    for (const key of ["mgr", "inTeam", "inChild", "flagged"]) expect(await titleOf(pages[key])).toBe("מנהל");
    for (const key of ["outside", "peerMgr", "admin"]) expect(await titleOf(pages[key])).toBe("מקור");
    expect((await asUser(flagged.id, (q) => q("update public.booking_pages set title = 'מסומן'"))).rowCount).toBe(1);
    expect(await titleOf(pages.inTeam)).toBe("מנהל");
  });

  it("hands a page only among their own people and themselves", async () => {
    await asUser(mgr.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [pages.inTeam, inChild.id]));
    expect(await ownerOf(pages.inTeam)).toBe(inChild.id);
    await asUser(mgr.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [pages.inTeam, inTeam.id]));
    for (const rep of [outside, peerMgr, admin]) {
      expect((await pgError(asUser(mgr.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [pages.inTeam, rep.id])))).code).toBe("42501");
    }
    expect(await ownerOf(pages.inTeam)).toBe(inTeam.id);
    // the new rep is checked on its own, whatever the old one was: handing every page they manage to the owner or to
    // a member of another team is refused (a statement only the update policy's CHECK judges)
    for (const rep of [owner, outside]) {
      expect((await pgError(asUser(mgr.id, (q) => q("update public.booking_pages set user_id = $1", [rep.id])))).code).toBe("42501");
    }
    expect(await ownerOf(pages.inTeam)).toBe(inTeam.id);
    expect(await ownerOf(pages.mgr)).toBe(mgr.id);
  });

  it("a person who leaves the team, or a manager who becomes a member, takes the rights away", async () => {
    await asAdmin((q) => q("update public.team_members set team_id = (select id from public.teams where organization_id = $1 and name = 'שירות') where organization_id = $1 and user_id = $2", [org, inChild.id]));
    expect(keysOf(await visible(mgr))).toEqual(["flagged", "inTeam", "mgr"]);
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, mgr.id]));
    expect(keysOf(await visible(mgr))).toEqual(["mgr"]);
    await asAdmin(async (q) => {
      await q("update public.memberships set role = 'manager' where organization_id = $1 and user_id = $2", [org, mgr.id]);
      await q("update public.team_members set team_id = (select id from public.teams where organization_id = $1 and name = 'מכירות צפון') where organization_id = $1 and user_id = $2", [org, inChild.id]);
    });
  });

  it("a delete without a WHERE removes exactly their own and their people's pages", async () => {
    const before = await asAdmin((q) => count(q, "select 1 from public.booking_pages where organization_id = $1", [org]));
    // their own, inTeam, inChild, flagged and the page made for inChild above
    expect((await asUser(mgr.id, (q) => q("delete from public.booking_pages"))).rowCount).toBe(5);
    expect(await asAdmin((q) => count(q, "select 1 from public.booking_pages where organization_id = $1", [org]))).toBe(before - 5);
    for (const key of ["outside", "peerMgr", "admin"]) expect(await titleOf(pages[key])).toBeTruthy();
  });
});
