import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = Record<string, unknown>;

const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
const ORG_HOURS = { sun: [{ start: "08:00", end: "13:00" }, { start: "16:00", end: "19:00" }], mon: [{ start: "08:00", end: "17:00" }] };

/**
 * BIZ-01: the public business page, a secret-link page under hard rule 5's approved pattern (owner, 11 November 2026, answer
 * (271) ב; plan key `public_page`, every plan, answer (70) ב): one definer function per need, service_role only; only public
 * fields; "not found" for a page that is off, a business whose public pages are closed (deleted, cancelled) or a plan without
 * the key; a rate limit per sender after the lookup (no page-wide cap) with no hash kept; the form goes through intake_submit;
 * nothing of another business.
 */
describe("business page (BIZ-01)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, rep: U, outsider: U;
  let org: string, otherOrg: string;
  let page: { id: string; token: string };
  let bookingOpen: { id: string; token: string };
  let bookingOff: { id: string; token: string };
  let otherBooking: string;
  let hashSeq = 0;
  const hash = () => `bp-${process.pid}-${++hashSeq}`.padStart(64, "0");
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  const view = (token: string, ipHash: string | null = hash()) =>
    asService(async (q) => (await q<{ r: Page }>("select public.business_page_public($1, $2) as r", [token, ipHash])).rows[0].r);
  const submit = (token: string, payload: Record<string, unknown>, ipHash: string | null = hash(), spam = false) =>
    asService(async (q) =>
      (await q<{ r: Page }>("select public.business_page_submit($1, $2, $3, 'test', $4) as r", [token, JSON.stringify(payload), ipHash, spam])).rows[0].r,
    );
  const setPage = (sets: string, params: unknown[] = []) =>
    asUser(owner.id, (q) => q(`update public.business_pages set ${sets} where id = $1`, [page.id, ...params]));
  const resetCounts = () => asAdmin((q) => q("delete from app.business_page_view_counts where page_id = $1", [page.id]));
  const freshSender = async (pageId: string): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = hash();
      const used = await asAdmin(async (q) =>
        (
          await one<{ used: boolean }>(
            q,
            `select exists (select 1 from app.business_page_view_counts c
                             where c.page_id = $1
                               and c.bucket = ((hashtextextended(app.business_page_sender($1, $2), 0) % 1024) + 1024) % 1024) as used`,
            [pageId, candidate],
          )
        ).used,
      );
      if (!used) return candidate;
    }
    throw new Error("no free view bucket found");
  };

  beforeAll(async () => {
    owner = await createUser("bp-owner");
    org = await createOrg(owner.id, "סטודיו לדוגמה");
    admin = await addMember(org, owner.id, "admin", "bp-admin");
    manager = await addMember(org, owner.id, "manager", "bp-manager");
    member = await addMember(org, owner.id, "member", "bp-member");
    viewer = await addMember(org, owner.id, "viewer", "bp-viewer");
    rep = await addMember(org, owner.id, "member", "bp-rep");
    outsider = await createUser("bp-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC', phone = '03-5551234', website = 'https://studio.example.test' where id = $1", [org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify(ORG_HOURS)],
      );
      await q("update public.profiles set timezone = null, working_hours = $2 where id = $1", [rep.id, JSON.stringify(ALL_WEEK)]);
      await q("update public.subscriptions set feature_overrides = '{\"booking_page\": true}' where organization_id = $1", [org]);
    });
    const type = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'ייעוץ', 60) returning id", [org])).id,
    );
    const makeBooking = (title: string) =>
      asUser(rep.id, (q) =>
        one<{ id: string; token: string }>(
          q,
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id) values ($1, $2, $3, $4) returning id, token",
          [org, rep.id, title, type],
        ),
      );
    bookingOpen = await makeBooking("קביעת ייעוץ");
    bookingOff = await makeBooking("תור כבוי");
    await asUser(rep.id, (q) => q("update public.booking_pages set is_active = false where id = $1", [bookingOff.id]));
    otherBooking = await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      return (
        await one<{ id: string }>(q, "insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'של אחר') returning id", [otherOrg, outsider.id])
      ).id;
    });
    page = await asUser(owner.id, (q) =>
      one<{ id: string; token: string }>(
        q,
        `insert into public.business_pages (organization_id, is_active, about, booking_page_ids)
         values ($1, true, 'סטודיו לפילאטיס בתל אביב', $2::uuid[]) returning id, token`,
        [org, [bookingOpen.id, bookingOff.id]],
      ),
    );
  });

  it("owners and admins of the business manage the page; nobody else sees or writes it", async () => {
    const seen = (who: U) => asUser(who.id, (q) => count(q, "select 1 from public.business_pages where id = $1", [page.id]));
    expect(await seen(owner)).toBe(1);
    expect(await seen(admin)).toBe(1);
    for (const who of [manager, member, viewer, outsider]) expect(await seen(who)).toBe(0);
    for (const who of [manager, member, viewer, outsider]) {
      expect(await asUser(who.id, async (q) => (await q("update public.business_pages set about = 'נחטף'")).rowCount)).toBe(0);
    }
    // nobody deletes it (switching off takes it down); an outsider cannot add one to the business
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.business_pages where id = $1", [page.id])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("insert into public.business_pages (organization_id) values ($1)", [org]))))).toMatchObject({ code: "42501" });
    // one page per business
    expect((await pgError(asUser(admin.id, (q) => q("insert into public.business_pages (organization_id) values ($1)", [org])))).code).toBe("23505");
    expect(await asUser(admin.id, async (q) => (await q("update public.business_pages set about = 'סטודיו לפילאטיס' where id = $1", [page.id])).rowCount)).toBe(1);
    // the token is made by the server and never written by a person; nor the business
    for (const set of ["token = 'x'", `organization_id = '${otherOrg}'`]) {
      expect((await pgError(setPage(set))).code, set).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.business_pages (organization_id, token) values ($1, 'x')", [otherOrg]))))).toMatchObject({ code: "42501" });
    expect(page.token).toMatch(/^[0-9a-f]{32}$/);
    // a read-only business does not change it
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await asUser(owner.id, async (q) => (await q("update public.business_pages set about = 'x' where id = $1", [page.id])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("switching on needs the plan key; only the business's own booking pages, once each", async () => {
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"booking_page\": true, \"public_page\": false}' where organization_id = $1", [org]));
    try {
      await setPage("is_active = false");
      expect((await pgError(setPage("is_active = true"))).hint).toBe("feature:public_page");
      // every writer, the server too
      expect((await pgError(asAdmin((q) => q("update public.business_pages set is_active = true where id = $1", [page.id])))).hint).toBe("feature:public_page");
      // a change while on, or switching off, stays allowed (on: written past the triggers, as a plan lost later)
      await asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.business_pages set is_active = true where id = $1", [page.id]);
      });
      await setPage("about = 'עדיין'");
      expect((await pgError(view(page.token))).code).toBe("P0002");
      expect((await pgError(submit(page.token, { full_name: "x", phone: "050-1111111" }))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"booking_page\": true}' where organization_id = $1", [org]));
      await setPage("about = 'סטודיו לפילאטיס בתל אביב'");
    }
    expect((await pgError(setPage("booking_page_ids = $2::uuid[]", [[otherBooking]]))).hint).toBe("business_page:booking_page");
    expect((await pgError(setPage("booking_page_ids = $2::uuid[]", [[bookingOpen.id, bookingOpen.id]]))).hint).toBe("business_page:booking_page");
    expect((await pgError(setPage("booking_page_ids = $2::uuid[]", [[bookingOpen.id, null]]))).hint).toBe("business_page:booking_page");
    // at most 20 (the check holds past the triggers too)
    expect(
      (
        await pgError(
          asAdmin(async (q) => {
            await q("set local session_replication_role = replica");
            await q("update public.business_pages set booking_page_ids = array(select gen_random_uuid() from generate_series(1, 21)) where id = $1", [page.id]);
          }),
        )
      ).code,
    ).toBe("23514");
  });

  it("the page has its own form, made and changed only with the page, outside the web forms", async () => {
    const form = await asAdmin((q) =>
      one<{ id: string; token: string; kind: string; owner_id: string | null; assign_mode: string; source: string; source_kind: string }>(
        q,
        `select f.id, f.token, f.kind, f.owner_id, f.assign_mode, s.name as source, s.kind as source_kind
           from public.forms f join public.lead_sources s on s.organization_id = f.organization_id and s.id = f.source_id
          where f.business_page_id = $1`,
        [page.id],
      ),
    );
    expect(form).toMatchObject({ kind: "page", owner_id: null, assign_mode: "round_robin", source: "דף העסק", source_kind: "business_page" });
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.forms (organization_id, kind, name) values ($1, 'page', 'x')", [org])))).hint).toBe("form:page");
    expect((await pgError(asUser(owner.id, (q) => q("update public.forms set owner_id = $2 where id = $1", [form.id, owner.id])))).hint).toBe("form:page");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id])))).hint).toBe("form:page");
    // not a web form: no hosted page, no web-form intake
    expect(await asService(async (q) => (await q<{ r: unknown }>("select public.intake_form($1) as r", [form.token])).rows[0].r)).toBeNull();
    expect((await pgError(asService((q) => q("select public.intake_submit($1, 'form', '{\"full_name\": \"x\"}'::jsonb)", [form.token])))).code).toBe("P0002");
  });

  it("the page answers only public fields, by token, to the server only", async () => {
    await resetCounts();
    const answer = await view(page.token);
    expect(answer).toEqual({
      business: "סטודיו לדוגמה",
      brand: {},
      built_with: true,
      about: "סטודיו לפילאטיס בתל אביב",
      phone: "03-5551234",
      whatsapp: "97235551234",
      website: "https://studio.example.test",
      hours: ORG_HOURS,
      // only the open booking page, title and token
      booking: [{ title: "קביעת ייעוץ", token: bookingOpen.token }],
      form: true,
    });
    const text = JSON.stringify(answer);
    for (const secret of [page.id, page.token, org, owner.id, rep.id, bookingOpen.id, bookingOff.token, "bp-rep", "תור כבוי"]) {
      expect(text, secret).not.toContain(secret);
    }
    await setPage("show_phone = false, show_whatsapp = false, show_website = false, show_hours = false, show_form = false, booking_page_ids = '{}', about = null");
    expect(await view(page.token)).toEqual({ business: "סטודיו לדוגמה", brand: {}, built_with: true, booking: [], form: false });
    // with the form off, the submit is not found
    expect((await pgError(submit(page.token, { full_name: "x", phone: "050-1111111" }))).code).toBe("P0002");
    await setPage(
      "show_phone = true, show_whatsapp = true, show_website = true, show_hours = true, show_form = true, booking_page_ids = $2::uuid[], about = 'סטודיו לפילאטיס בתל אביב'",
      [[bookingOpen.id, bookingOff.id]],
    );
    // a booking page that was deleted, or another business's id written past the triggers, is never listed
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.business_pages set booking_page_ids = $2::uuid[] where id = $1", [page.id, [otherBooking, bookingOpen.id]]);
    });
    expect((await view(page.token)).booking).toEqual([{ title: "קביעת ייעוץ", token: bookingOpen.token }]);
    await setPage("booking_page_ids = $2::uuid[]", [[bookingOpen.id, bookingOff.id]]);
    // the browser roles: nothing
    expect((await pgError(view("0".repeat(32)))).code).toBe("P0002");
    for (const call of ["select public.business_page_public($1)", "select public.business_page_submit($1, '{}'::jsonb)"]) {
      expect((await pgError(asAnon((q) => q(call, [page.token]))))).toMatchObject({ code: "42501" });
      expect((await pgError(asUser(owner.id, (q) => q(call, [page.token]))))).toMatchObject({ code: "42501" });
    }
  });

  it("a page that is off and a business whose public pages are closed are not found; read-only still shows", async () => {
    const notFound = async (label: string) => {
      expect((await pgError(view(page.token))).code, label).toBe("P0002");
      expect((await pgError(submit(page.token, { full_name: "x", phone: "050-1111111" }))).code, label).toBe("P0002");
    };
    await setPage("is_active = false");
    await notFound("page off");
    await setPage("is_active = true");
    for (const status of ["cancelled"]) {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
      await notFound(status);
    }
    await asAdmin((q) => q("update public.organizations set status = 'active', deleted_at = now() where id = $1", [org]));
    await notFound("deleted");
    await asAdmin((q) => q("update public.organizations set status = 'read_only', deleted_at = null where id = $1", [org]));
    try {
      // read-only: the page shows and takes the form; booking pages are not open in a business that cannot write
      expect(await view(page.token)).toMatchObject({ form: true, booking: [] });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect(await view(page.token)).toMatchObject({ business: "סטודיו לדוגמה" });
  });

  it("the form makes a lead through intake_submit, and answers its status only", async () => {
    const reply = await submit(page.token, {
      full_name: "לקוחה מדף העסק",
      phone: "050-2224999",
      email: "client@example.test",
      message: "אשמח לפרטים",
      attribution: { utm_source: "instagram" },
      custom: { anything: "x" },
      callback: "now",
      company_name: "לא נשאל",
    });
    expect(reply).toEqual({ status: "accepted" });
    const lead = await asAdmin((q) =>
      one<{ source: string; company_name: string | null; message: string; utm: Record<string, unknown>; custom_fields: Record<string, unknown> }>(
        q,
        `select s.name as source, l.company_name, l.message, l.utm, l.custom_fields
           from public.leads l join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
          where l.organization_id = $1 and l.phone = '050-2224999'`,
        [org],
      ),
    );
    expect(lead).toMatchObject({ source: "דף העסק", company_name: null, message: "אשמח לפרטים" });
    expect(lead.utm).toMatchObject({ utm_source: "instagram" });
    expect(lead.custom_fields).toEqual({});
    expect(await submit(page.token, { full_name: "בוט", phone: "050-0000002" }, hash(), true)).toEqual({ status: "spam" });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '050-0000002'", [org]))).toBe(0);
    expect((await pgError(submit(page.token, { message: "בלי פרטים" }))).code).toBe("22023");
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [otherOrg]))).toBe(0);
  });

  it("rate limit after the lookup: 60 per sender in 10 minutes, no page-wide cap; no hash kept", async () => {
    await resetCounts();
    const sender = await freshSender(page.id);
    for (let i = 0; i < 60; i += 1) expect((await view(page.token, sender)).rate_limited).toBeUndefined();
    expect(await view(page.token, sender)).toEqual({ rate_limited: true });
    expect((await view(page.token, await freshSender(page.id))).business).toBe("סטודיו לדוגמה");
    // an unknown token counts nothing
    const counted = () => asAdmin((q) => count(q, "select 1 from app.business_page_view_counts"));
    const before = await counted();
    await pgError(view("f".repeat(32), hash()));
    expect(await counted()).toBe(before);
    // no page-wide cap: many senders together never take the page down for the next one
    for (let i = 0; i < 70; i += 1) expect((await view(page.token, await freshSender(page.id))).rate_limited, `sender ${i}`).toBeUndefined();
    expect((await view(page.token, await freshSender(page.id))).business).toBe("סטודיו לדוגמה");
    expect(await asAdmin((q) => count(q, "select 1 from pg_tables where schemaname = 'app' and tablename = 'business_page_view_totals'"))).toBe(0);
    // intake_submit's own per-sender limit holds for the form
    const poster = hash();
    for (let i = 0; i < 10; i += 1) await submit(page.token, { full_name: `שולח ${i}`, phone: `050-91000${10 + i}` }, poster);
    expect((await pgError(submit(page.token, { full_name: "האחד עשר", phone: "050-9100099" }, poster))).hint).toBe("rate_limited");
    const columns = async (table: string) =>
      asAdmin(async (q) =>
        (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'app' and table_name = $1", [table])).rows
          .map((r) => r.column_name)
          .sort(),
      );
    expect(await columns("business_page_view_counts")).toEqual(["bucket", "page_id", "views", "window_start"]);
    await resetCounts();
  });

  it("the sender is scoped to the page; the form's hash is never the server's own", async () => {
    const sender = hash();
    await submit(page.token, { full_name: "שולח משותף", phone: "050-3334001" }, sender);
    const stored = await asAdmin((q) =>
      one<{ ip_hash: string }>(q, "select s.ip_hash from public.form_submissions s where s.organization_id = $1 and s.payload ->> 'phone' = '050-3334001'", [org]),
    );
    const expected = await asAdmin((q) => one<{ h: string }>(q, "select app.business_page_sender($1, $2) as h", [page.id, sender]));
    expect(stored.ip_hash).toBe(expected.h);
    expect(stored.ip_hash).not.toBe(sender);
  });

  it("another business's page never reaches this one", async () => {
    const other = await asUser(outsider.id, (q) =>
      one<{ token: string }>(q, "insert into public.business_pages (organization_id, is_active, about) values ($1, true, 'אחר') returning token", [otherOrg]),
    );
    expect(await view(other.token)).toMatchObject({ business: "עסק אחר", about: "אחר" });
    expect(await submit(other.token, { full_name: "לקוח של אחר", phone: "053-1000002" })).toEqual({ status: "accepted" });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '053-1000002'", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '053-1000002'", [otherOrg]))).toBe(1);
    // the outsider cannot name this business's booking page
    expect((await pgError(asUser(outsider.id, (q) => q("update public.business_pages set booking_page_ids = $2::uuid[] where organization_id = $1", [otherOrg, [bookingOpen.id]])))).hint).toBe(
      "business_page:booking_page",
    );
  });

  it("a preview bot gets the display name and logo only, by the same rule", async () => {
    const preview = (token: string) =>
      asService(async (q) => (await q<{ p: Page }>("select public.link_preview_public('page', $1, $2) as p", [token, hash()])).rows[0].p);
    await asAdmin(async (q) => {
      await q("update app.link_preview_reads set minute = now() - interval '1 hour', reads = 0 where id = 1");
    });
    expect(await preview(page.token)).toEqual({ kind: "page", business: "סטודיו לדוגמה", logo: null });
    await setPage("is_active = false");
    expect(await preview(page.token)).toEqual({ not_found: true });
    await setPage("is_active = true");
    expect(await preview("0".repeat(32))).toEqual({ not_found: true });
  });
});
