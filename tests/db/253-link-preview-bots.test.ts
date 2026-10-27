import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Preview = Record<string, unknown>;
type Kind = "form" | "quote" | "order" | "booking" | "booking_manage" | "card";

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();
const DISPLAY = "שם התצוגה של העסק";
const LEGAL = 'השם הרשום של העסק בע"מ';

/**
 * WAB-05 follow-up (owner, 27 October 2026, answers (1) ב and (2) ב): public.link_preview_public(kind, token, ip_hash) is the one
 * narrow function a messaging app's preview bot gets instead of the page. Service role only; it answers only the business's
 * DISPLAY name and logo (a card adds the name the card always shows), never counts a view, never marks a quote viewed, tells
 * nobody, runs no automation, and writes only its own rate-limit counters. "Usable" follows each page's own rule.
 */
describe("link previews for preview bots (WAB-05)", () => {
  let owner: U, rep: U, outsider: U;
  let org: string, otherOrg: string;
  const tokens = {} as Record<Kind, string>;
  let otherCardToken: string;
  let quoteId: string, orderId: string, bookingPageId: string, cardId: string, typeId: string;

  // a fresh sender per call unless named, so the per-sender limit never trips the other tests
  let senderSeq = 0;
  const preview = (kind: string, token: string | null, ip: string | null = `sender-${process.pid}-${senderSeq++}`) =>
    asService(async (q) => (await q<{ p: Preview }>("select public.link_preview_public($1, $2, $3) as p", [kind, token, ip])).rows[0].p);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setStatus = (orgId: string, status: string) => asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, orgId]));

  beforeAll(async () => {
    // the total a minute outlives a run: start from zero
    await asAdmin((q) => q("update app.link_preview_reads set minute = now() - interval '1 hour', reads = 0 where id = 1"));
    owner = await createUser("lp-owner");
    org = await createOrg(owner.id, DISPLAY);
    rep = await addMember(org, owner.id, "member", "lp-rep");
    outsider = await createUser("lp-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC' where id = $1", [org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      );
      await q("update public.profiles set full_name = 'דנה הנציגה', timezone = null where id = $1", [rep.id]);
      await q("update public.subscriptions set feature_overrides = '{\"quotes\": true, \"orders\": true, \"booking_page\": true, \"business_card\": true}' where organization_id = $1", [org]);
    });
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, legal_name, phone) values ($1, 'licensed', $2, '03-5550000')
         on conflict (organization_id) do update set vat_status = 'licensed', legal_name = excluded.legal_name`,
        [org, LEGAL],
      ),
    );

    // the branding trigger wants a real upload; the test sets the path past the triggers (as test 153)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.organizations set logo_path = $2 where id = $1", [org, `${org}/logo-1`]);
    });

    // a web form
    tokens.form = await asUser(owner.id, async (q) => (await one<{ token: string }>(q, "insert into public.forms (organization_id, name) values ($1, 'טופס אתר') returning token", [org])).token);

    // a sent quote with a link, on a deal
    const pipe = await defaultPipeline(org);
    const q1 = await asUser(owner.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוחה סודית') returning id", [org])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          pipe.stages[0].id,
          contact,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה סודית', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 123400, 1)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t;
      // a numbered order with a link, on the same contact
      const order = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 55500)", [org, order]);
      await q("select public.order_confirm($1, $2)", [org, order]);
      const orderToken = (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, order])).t;
      return { quote, token, order, orderToken };
    });
    quoteId = q1.quote;
    tokens.quote = q1.token;
    orderId = q1.order;
    tokens.order = q1.orderToken;

    // a booking page, and one booking's personal link
    const type = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'ייעוץ', 60) returning id", [org])).id,
    );
    typeId = type;
    const page = await asUser(rep.id, async (q) =>
      one<{ id: string; token: string }>(
        q,
        "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'תורים', $3, 0, 30, 60) returning id, token",
        [org, rep.id, type],
      ),
    );
    bookingPageId = page.id;
    tokens.booking = page.token;
    const booked = await asService(async (q) =>
      (
        await one<{ r: Preview }>(q, "select public.booking_submit($1, $2, $3, null) as r", [
          page.token,
          at(dayAhead(5), "10:00"),
          JSON.stringify({ full_name: "לקוחה", phone: "0501110001" }),
        ])
      ).r,
    );
    expect(booked.status).toBe("booked");
    tokens.booking_manage = booked.manage_token as string;

    // a business card of the rep, and one of the other business
    const card = await asUser(rep.id, async (q) => one<{ id: string; token: string }>(q, "insert into public.business_cards (organization_id, user_id) values ($1, $2) returning id, token", [org, rep.id]));
    cardId = card.id;
    tokens.card = card.token;
    otherCardToken = await asUser(outsider.id, async (q) =>
      (await one<{ token: string }>(q, "insert into public.business_cards (organization_id, user_id) values ($1, $2) returning token", [otherOrg, outsider.id])).token,
    );
  });

  it("is for the service role only", async () => {
    expect((await pgError(asAnon((q) => q("select public.link_preview_public('card', $1, null)", [tokens.card])))).code).toBe("42501");
    for (const u of [owner, rep]) {
      expect((await pgError(asUser(u.id, (q) => q("select public.link_preview_public('card', $1, null)", [tokens.card])))).code).toBe("42501");
    }
    const grants = await asAdmin(async (q) =>
      (
        await q<{ grantee: string }>(
          `select grantee from information_schema.routine_privileges
            where routine_schema = 'public' and routine_name = 'link_preview_public' and privilege_type = 'EXECUTE' order by grantee`,
        )
      ).rows.map((r) => r.grantee),
    );
    expect(grants).not.toContain("anon");
    expect(grants).not.toContain("authenticated");
    expect(grants).not.toContain("PUBLIC");
    expect(grants).toContain("service_role");
  });

  it("answers only the display name and the logo (a card adds the name it always shows)", async () => {
    for (const kind of ["form", "quote", "order", "booking", "booking_manage"] as const) {
      const p = await preview(kind, tokens[kind]);
      expect(Object.keys(p).sort(), kind).toEqual(["business", "kind", "logo"]);
      expect(p, kind).toEqual({ kind, business: DISPLAY, logo: `${org}/logo-1` });
    }
    const card = await preview("card", tokens.card);
    expect(Object.keys(card).sort()).toEqual(["business", "kind", "logo", "rep"]);
    expect(card).toEqual({ kind: "card", business: DISPLAY, logo: `${org}/logo-1`, rep: "דנה הנציגה" });
    // never the registered name, a number, an amount, a title or a customer
    const all = JSON.stringify(await Promise.all((Object.keys(tokens) as Kind[]).map((k) => preview(k, tokens[k]))));
    for (const secret of [LEGAL, "לקוחה סודית", "הצעה סודית", "ייעוץ", "תורים"]) expect(all).not.toContain(secret);
  });

  it("a quote's or an order's design that hides the logo hides it in the preview too", async () => {
    await asUser(owner.id, (q) => q("insert into public.quote_designs (organization_id, show_logo) values ($1, false)", [org]));
    try {
      expect(await preview("quote", tokens.quote)).toEqual({ kind: "quote", business: DISPLAY, logo: null });
      expect(await preview("order", tokens.order)).toEqual({ kind: "order", business: DISPLAY, logo: null });
      expect((await preview("card", tokens.card)).logo).toBe(`${org}/logo-1`);
    } finally {
      await asUser(owner.id, (q) => q("update public.quote_designs set show_logo = true where organization_id = $1", [org]));
    }
  });

  it("not found for an unknown token, another kind's token, an unknown kind and another business's card is its own", async () => {
    for (const kind of ["form", "quote", "order", "booking", "booking_manage", "card"]) {
      expect(await preview(kind, "x".repeat(64))).toEqual({ not_found: true });
      expect(await preview(kind, null)).toEqual({ not_found: true });
      expect(await preview(kind, "")).toEqual({ not_found: true });
    }
    // a token of one page never opens another kind
    expect(await preview("order", tokens.quote)).toEqual({ not_found: true });
    expect(await preview("quote", tokens.order)).toEqual({ not_found: true });
    expect(await preview("form", tokens.booking)).toEqual({ not_found: true });
    expect(await preview("booking", tokens.card)).toEqual({ not_found: true });
    // the other business's card names the other business only
    expect(await preview("card", otherCardToken)).toMatchObject({ business: "עסק אחר" });
    expect((await pgError(preview("widget", tokens.form))).code).toBe("22023");
    expect((await pgError(preview("", tokens.form))).code).toBe("22023");
  });

  it("not found exactly when the page itself shows no business", async () => {
    // a revoked quote link, an inactive form, card or booking page, a flag turned off
    const service = <T,>(sql: string, params: unknown[]) => asService(async (q) => (await q<{ r: T }>(sql, params)).rows[0].r);
    await asUser(owner.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, quoteId]));
    expect(await preview("quote", tokens.quote)).toEqual({ not_found: true });
    expect((await pgError(service("select public.quote_public($1) as r", [tokens.quote]))).code).toBe("P0002");
    tokens.quote = await asUser(owner.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quoteId])).t);
    expect(await preview("quote", tokens.quote)).toMatchObject({ business: DISPLAY });

    // form: intake_form's rule (null = not found)
    await asUser(owner.id, (q) => q("update public.forms set is_active = false where token = $1", [tokens.form]));
    expect(await service("select public.intake_form($1) as r", [tokens.form])).toBeNull();
    expect(await preview("form", tokens.form)).toEqual({ not_found: true });
    await asUser(owner.id, (q) => q("update public.forms set is_active = true where token = $1", [tokens.form]));
    expect(await preview("form", tokens.form)).toMatchObject({ business: DISPLAY });

    // card
    await asUser(rep.id, (q) => q("update public.business_cards set is_active = false where id = $1", [cardId]));
    expect(await preview("card", tokens.card)).toEqual({ not_found: true });
    await asUser(rep.id, (q) => q("update public.business_cards set is_active = true where id = $1", [cardId]));

    // booking: a page closed for an hour answers "unavailable" (no business), so does the preview
    await asAdmin((q) => q("insert into app.booking_page_closures (page_id, organization_id, closed_until) values ($1, $2, now() + interval '1 hour')", [bookingPageId, org]));
    expect(await service("select public.booking_page_public($1, null, null) as r", [tokens.booking])).toEqual({ unavailable: true });
    expect(await preview("booking", tokens.booking)).toEqual({ not_found: true });
    await asAdmin((q) => q("update app.booking_page_closures set closed_until = now() - interval '1 second' where page_id = $1", [bookingPageId]));
    expect(await preview("booking", tokens.booking)).toMatchObject({ business: DISPLAY });

    // a flag turned off: quote, order, booking page and card answer not found
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"quotes\": false, \"orders\": false, \"booking_page\": false, \"business_card\": false}' where organization_id = $1", [org]));
    try {
      for (const kind of ["quote", "order", "booking", "card"] as const) expect(await preview(kind, tokens[kind]), kind).toEqual({ not_found: true });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"quotes\": true, \"orders\": true, \"booking_page\": true, \"business_card\": true}' where organization_id = $1", [org]));
    }

    // read only: the booking page and the personal link answer "unavailable" (no business); the others still show it
    await setStatus(org, "read_only");
    try {
      expect(await service("select public.booking_page_public($1, null, null) as r", [tokens.booking])).toEqual({ unavailable: true });
      expect(await service("select public.booking_manage_public($1, null, null) as r", [tokens.booking_manage])).toEqual({ unavailable: true });
      expect(await preview("booking", tokens.booking)).toEqual({ not_found: true });
      expect(await preview("booking_manage", tokens.booking_manage)).toEqual({ not_found: true });
      for (const kind of ["form", "quote", "order", "card"] as const) expect(await preview(kind, tokens[kind]), kind).toMatchObject({ business: DISPLAY });
    } finally {
      await setStatus(org, "active");
    }

    // public pages closed (a cancelled business): not found everywhere
    await setStatus(org, "cancelled");
    try {
      for (const kind of Object.keys(tokens) as Kind[]) expect(await preview(kind, tokens[kind]), kind).toEqual({ not_found: true });
    } finally {
      await setStatus(org, "active");
    }
    for (const kind of Object.keys(tokens) as Kind[]) expect(await preview(kind, tokens[kind]), kind).toMatchObject({ business: DISPLAY });
  });

  it("counts no view, changes no status, tells nobody and runs no automation", async () => {
    const snapshot = () =>
      asAdmin(async (q) => {
        const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(q, sql, params)).n);
        return {
          quoteStatus: (await one<{ status: string }>(q, "select status from public.quotes where id = $1", [quoteId])).status,
          quoteViews: await n("select count(*) as n from public.quote_views where quote_id = $1", [quoteId]),
          quoteWindow: await n("select coalesce(sum(window_count), 0) as n from app.quote_links where quote_id = $1", [quoteId]),
          orderWindow: await n("select coalesce(sum(window_count), 0) as n from app.order_links where order_id = $1", [orderId]),
          orderViews: await n("select coalesce(sum(views), 0) as n from app.order_link_view_counts where order_id = $1", [orderId]),
          bookingViews: await n("select coalesce(sum(views), 0) as n from app.booking_view_counts where page_id = $1", [bookingPageId]),
          cardViews: await n("select coalesce(sum(views), 0) as n from app.business_card_view_counts where card_id = $1", [cardId]),
          outbox: await n("select count(*) as n from public.outbox_events where organization_id = $1", [org]),
          notifications: await n("select count(*) as n from public.notifications where organization_id = $1", [org]),
          runs: await n("select count(*) as n from public.automation_runs where organization_id = $1", [org]),
          activities: await n("select count(*) as n from public.activities where organization_id = $1", [org]),
          audit: await n("select count(*) as n from public.audit_log where organization_id = $1", [org]),
        };
      });
    const before = await snapshot();
    expect(before.quoteStatus).toBe("sent");
    for (let i = 0; i < 3; i++) {
      for (const kind of Object.keys(tokens) as Kind[]) expect(await preview(kind, tokens[kind], `same-sender-${i}`), kind).toMatchObject({ business: DISPLAY });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("limits each sender, and all previews together", async () => {
    // the total a minute is shared by the whole file (and an earlier run in the same minute): start from zero
    await asAdmin((q) => q("update app.link_preview_reads set minute = now() - interval '1 hour', reads = 0 where id = 1"));
    const sender = `limited-${process.pid}`;
    const limit = await asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.link_preview_sender_limit() as n")).n));
    expect(limit).toBe(30);
    for (let i = 0; i < limit; i++) expect(await preview("card", tokens.card, sender)).toMatchObject({ business: DISPLAY });
    expect(await preview("card", tokens.card, sender)).toEqual({ refused: "rate" });
    // the limit is per sender AND link (review L2, as app.order_link_sender): the same sender on another link is not limited,
    // nor is another sender on this link
    expect(await preview("form", tokens.form, sender)).toMatchObject({ business: DISPLAY });
    expect(await preview("card", tokens.card, `${sender}-other`)).toMatchObject({ business: DISPLAY });
    // an unknown token is counted too, before it is looked up
    const unknown = "y".repeat(64);
    for (let i = 0; i < limit; i++) expect(await preview("quote", unknown, sender)).toEqual({ not_found: true });
    expect(await preview("quote", unknown, sender)).toEqual({ refused: "rate" });
    // no hash is kept: only a bucket number and a count, in both sender tables, with no grants
    for (const table of ["link_preview_sender_counts", "link_preview_ip_counts"]) {
      const cols = await asAdmin(async (q) =>
        (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'app' and table_name = $1 order by column_name", [table])).rows.map((r) => r.column_name),
      );
      expect(cols, table).toEqual(["bucket", "views", "window_start"]);
      const grants = await asAdmin(async (q) => (await q("select 1 from information_schema.role_table_grants where table_schema = 'app' and table_name = $1 and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')", [table])).rowCount);
      expect(grants, table).toBe(0);
    }

    // one sender across all links: a new made-up token on every call is refused after 120 (not found counts too)
    const ipLimit = await asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.link_preview_ip_limit() as n")).n));
    expect(ipLimit).toBe(120);
    const roamer = `roamer-${process.pid}`;
    for (let i = 0; i < ipLimit; i++) {
      expect(await preview("quote", i.toString(16).padStart(64, "0").replace(/0/g, "z"), roamer), String(i)).toEqual({ not_found: true });
    }
    expect(await preview("quote", "q".repeat(64), roamer)).toEqual({ refused: "rate" });
    // a real link from the same sender too; another sender is not limited
    expect(await preview("card", tokens.card, roamer)).toEqual({ refused: "rate" });
    expect(await preview("card", tokens.card, `${roamer}-other`)).toMatchObject({ business: DISPLAY });

    // the total a minute (a minute ahead keeps the counter, whatever the clock does during the test)
    await asAdmin((q) =>
      q("insert into app.link_preview_reads (id, minute, reads) values (1, date_trunc('minute', now()) + interval '1 minute', 300) on conflict (id) do update set minute = excluded.minute, reads = excluded.reads"),
    );
    try {
      expect(await preview("card", tokens.card, null)).toEqual({ refused: "rate" });
      expect(await preview("form", tokens.form)).toEqual({ refused: "rate" });
    } finally {
      await asAdmin((q) => q("update app.link_preview_reads set minute = now() - interval '1 hour', reads = 0 where id = 1"));
    }
    expect(await preview("card", tokens.card, null)).toMatchObject({ business: DISPLAY });
  });

  // --- review M1: the preview's not-found rule equals each page's own answer, case by case ---------------------------------

  const FEATURES = '{"quotes": true, "orders": true, "booking_page": true, "business_card": true}';
  const PAGE_SQL: Record<Kind, string> = {
    form: "select public.intake_form($1) as r",
    quote: "select public.quote_public($1) as r",
    order: "select public.order_public($1, null) as r",
    booking: "select public.booking_page_public($1, null, null) as r",
    booking_manage: "select public.booking_manage_public($1, null, null) as r",
    card: "select public.business_card_public($1, null) as r",
  };
  type Seen = "not_found" | "shows";
  /** the page function's own answer: P0002, null, {inactive} and {unavailable} show no business */
  const pageAnswer = async (kind: Kind, token: string): Promise<Seen> => {
    try {
      const r = await asService(async (q) => (await q<{ r: Preview | null }>(PAGE_SQL[kind], [token])).rows[0].r);
      if (r === null || r.inactive === true || r.unavailable === true) return "not_found";
      if (r.rate_limited === true) throw new Error(`${kind}: the page was rate limited, the test is not valid`);
      return "shows";
    } catch (e) {
      if ((e as { code?: string }).code === "P0002") return "not_found";
      throw e;
    }
  };
  const previewAnswer = async (kind: Kind, token: string): Promise<Seen> => {
    const p = await preview(kind, token);
    if (p.refused) throw new Error(`${kind}: the preview was rate limited, the test is not valid`);
    return p.not_found === true ? "not_found" : "shows";
  };
  /** both answers agree, and are the expected one */
  const agree = async (label: string, kind: Kind, token: string, expected: Seen) => {
    const page = await pageAnswer(kind, token);
    const pv = await previewAnswer(kind, token);
    expect({ label, page, preview: pv }).toEqual({ label, page: expected, preview: expected });
  };
  const replica = (sql: string, params: unknown[]) =>
    asAdmin(async (q) => {
      // past the triggers: the case is set up directly, then put back
      await q("set local session_replication_role = replica");
      await q(sql, params);
    });

  it("agrees with every page's own answer, case by case (review M1)", async () => {
    await asAdmin((q) => q("update app.link_preview_reads set minute = now() - interval '1 hour', reads = 0 where id = 1"));
    for (const kind of Object.keys(tokens) as Kind[]) await agree(`${kind}: as it is`, kind, tokens[kind], "shows");

    // a deleted customer, on a quote and on an order
    await replica("update public.quotes set customer_deleted_at = now() where id = $1", [quoteId]);
    await agree("quote: customer deleted", "quote", tokens.quote, "not_found");
    await replica("update public.quotes set customer_deleted_at = null where id = $1", [quoteId]);
    await replica("update public.orders set customer_deleted_at = now() where id = $1", [orderId]);
    await agree("order: customer deleted", "order", tokens.order, "not_found");
    await replica("update public.orders set customer_deleted_at = null where id = $1", [orderId]);

    // a draft quote and order
    const quoteStatus = await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quoteId])).s);
    await replica("update public.quotes set status = 'draft' where id = $1", [quoteId]);
    await agree("quote: draft", "quote", tokens.quote, "not_found");
    await replica("update public.quotes set status = $2 where id = $1", [quoteId, quoteStatus]);
    // a draft has no number (orders_numbered)
    const was = await asAdmin(async (q) => one<{ s: string; n: string }>(q, "select status as s, number::text as n from public.orders where id = $1", [orderId]));
    await replica("update public.orders set status = 'draft', number = null where id = $1", [orderId]);
    await agree("order: draft", "order", tokens.order, "not_found");
    await replica("update public.orders set status = $2, number = $3::bigint where id = $1", [orderId, was.s, was.n]);
    await agree("quote: back", "quote", tokens.quote, "shows");
    await agree("order: back", "order", tokens.order, "shows");

    // the rep of the card and the booking page suspended, then made a viewer
    for (const [label, change, back] of [
      ["suspended", "status = 'suspended'", "status = 'active'"],
      // a viewer holds a view seat (memberships_viewer_seat)
      ["a viewer", "role = 'viewer', seat_type = 'view'", "role = 'member', seat_type = 'full'"],
    ] as const) {
      await replica(`update public.memberships set ${change} where organization_id = $1 and user_id = $2`, [org, rep.id]);
      await agree(`card: rep ${label}`, "card", tokens.card, "not_found");
      await agree(`booking: rep ${label}`, "booking", tokens.booking, "not_found");
      await replica(`update public.memberships set ${back} where organization_id = $1 and user_id = $2`, [org, rep.id]);
    }
    await agree("card: rep back", "card", tokens.card, "shows");

    // the booking rep without working hours (neither their own nor the business's)
    await asAdmin((q) => q("update public.org_calendar_settings set working_hours = null where organization_id = $1", [org]));
    await agree("booking: no working hours", "booking", tokens.booking, "not_found");
    await asAdmin((q) => q("update public.org_calendar_settings set working_hours = $2 where organization_id = $1", [org, JSON.stringify(ALL_WEEK)]));

    // an inactive meeting type closes the booking page, not the personal link of a meeting already booked
    await asAdmin((q) => q("update public.meeting_types set is_active = false where id = $1", [typeId]));
    await agree("booking: meeting type inactive", "booking", tokens.booking, "not_found");
    await agree("booking_manage: meeting type inactive", "booking_manage", tokens.booking_manage, "shows");
    await asAdmin((q) => q("update public.meeting_types set is_active = true where id = $1", [typeId]));
    await agree("booking: back", "booking", tokens.booking, "shows");

    // a card's form and a site widget's form are not web forms
    const cardFormToken = await asAdmin(async (q) => (await one<{ t: string }>(q, "select token as t from public.forms where business_card_id = $1", [cardId])).t);
    await agree("form: a card's form token", "form", cardFormToken, "not_found");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, FEATURES.replace("}", ', "site_widget": true}')]));
    const widgetFormToken = await asAdmin(async (q) => {
      const w = (await one<{ id: string }>(q, "insert into public.site_widgets (organization_id, name) values ($1, 'האתר') returning id", [org])).id;
      return (await one<{ t: string }>(q, "select token as t from public.forms where site_widget_id = $1", [w])).t;
    });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, FEATURES]));
    await agree("form: a widget's form token", "form", widgetFormToken, "not_found");

    // a quote whose shown version (the newest sent one) lost its customer, while the linked quote did not
    const version = await asUser(owner.id, async (q) => {
      const v = (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, quoteId])).v;
      await q("select public.quote_send($1, $2)", [org, v]);
      return v;
    });
    await agree("quote: a newer sent version", "quote", tokens.quote, "shows");
    await replica("update public.quotes set customer_deleted_at = now() where id = $1", [version]);
    await agree("quote: the shown version's customer deleted", "quote", tokens.quote, "not_found");
    await replica("update public.quotes set customer_deleted_at = null where id = $1", [version]);

    // the personal link of a meeting that was purged
    const second = await asService(async (q) =>
      (
        await one<{ r: Preview }>(q, "select public.booking_submit($1, $2, $3, null) as r", [
          tokens.booking,
          at(dayAhead(6), "11:00"),
          JSON.stringify({ full_name: "לקוח שני", phone: "0501110002" }),
        ])
      ).r,
    );
    expect(second.status).toBe("booked");
    const manageToken = second.manage_token as string;
    await agree("booking_manage: a second booking", "booking_manage", manageToken, "shows");
    await asAdmin((q) =>
      q(
        `delete from public.meetings m using app.booking_manage_links l
          where l.token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') and m.organization_id = l.organization_id and m.id = l.meeting_id`,
        [manageToken],
      ),
    );
    await agree("booking_manage: meeting purged", "booking_manage", manageToken, "not_found");
  });

  // Each page function's body as reviewed with this preview rule (the pattern of test 120's REVIEWED_BODY_MD5). A redefinition
  // of one of them changes its md5 and fails here: check that public.link_preview_public still answers not found exactly when
  // that page shows no business (the matrix above), then update the value.
  const REVIEWED_PAGE_BODY_MD5: Record<string, string> = {
    "public.intake_form(text)": "8b5e831bae31f9e3ac0219716823bfdf",
    "public.quote_public(text)": "ab198e8177aa451db1d3c63b696bef16",
    "public.order_public(text,text)": "022b8411b93934e5055331575511b7f8",
    "public.booking_page_public(text,date,text)": "7ce1280bdcd77f4b22212665c9ce9481",
    "public.booking_manage_public(text,date,text)": "8b489cfee0bed9f5ea592d22df63a70a",
    "public.business_card_public(text,text)": "3ec340a7db5b5d5cf50f79bd49f8a1d4",
  };

  it("the page functions are the ones its rule was checked against (review M1)", async () => {
    const bodies = await asAdmin(async (q) => {
      const out: Record<string, string> = {};
      for (const fn of Object.keys(REVIEWED_PAGE_BODY_MD5)) {
        out[fn] = (await one<{ h: string }>(q, "select md5(p.prosrc) as h from pg_proc p where p.oid = $1::regprocedure", [fn])).h;
      }
      return out;
    });
    expect(bodies).toEqual(REVIEWED_PAGE_BODY_MD5);
  });
});
