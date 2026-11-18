import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// LNK-04 (wave 3 use (2)): the webhook's one function, pinned by md5(pg_get_functiondef) without carriage returns. A change
// needs a fresh independent review (ids only; only a pending link is paid; once per provider event).
const REVIEWED_MD5: Record<string, string> = {
  // review of the LNK branch: a source with neither deal nor contact takes no link (9); the paid amount, currency, instalments
  // and the provider payment id judged (1, 5); unknown links logged (6)
  "app.payment_links_check": "f8044a62a3c357da7aece73b50ff09ba",
  "app.payment_webhook_limit": "00742714563cbbb947de3f014750d75f",
  // LNK-04b (owner (422) א): rechecked that 021318 keeps 021316's body and adds only the closed-business owner notice after a
  // recorded payment, in its own block (errors swallowed, 40P01/40001/55P03 raised again); the notice helper is pinned too
  "public.payment_link_webhook": "5b7b85671537097e050bb98fcaaa7595",
  "app.payment_link_owner_notice": "ce78f25a1d4496e8d52710aee90e478f",
};

/**
 * LNK-04: a signed paid event of the provider records one confirmed payment on the link's source, allocates it to an open
 * document, and marks the link paid; once per provider event; never a link that is not pending.
 */
describe("payment link webhook (LNK-04)", () => {
  let owner: U;
  let org: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, payment_links: true, quotes: true, orders: true };
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const contact = () =>
    asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, owner.id])).id);
  const link = (column: string, id: string, amount: number) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.payment_links (organization_id, ${column}, amount_agorot, max_installments, expires_on, provider)
           values ($1, $2, $3, 3, (now() at time zone 'Asia/Jerusalem')::date + 7, 'fake') returning id`,
          [org, id, amount],
        )
      ).id,
    );
  const invoice = (contactId: string, amount: number) =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4) returning id", [org, contactId, `WH-${++n}`, amount])).id,
    );
  const hook = (event: Record<string, unknown>, provider = "fake") =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_webhook($1, $2) as r", [provider, JSON.stringify(event)])).r);
  const paid = (linkId: string, amount: number, extra: Record<string, unknown> = {}) => ({
    event_id: `ev_${randomUUID()}`,
    provider_link_id: `fake_${linkId}`,
    status: "paid",
    paid_agorot: amount,
    currency: "ILS",
    provider_payment_id: `fake_payment_${randomUUID().slice(0, 8)}`,
    installments: 2,
    ...extra,
  });
  const linkRow = (id: string) =>
    asAdmin((q) => one<{ status: string; payment_id: string | null; provider_payment_id: string | null }>(q, "select status, payment_id, provider_payment_id from public.payment_links where id = $1", [id]));
  const paymentRow = (id: string) =>
    asAdmin((q) =>
      one<Record<string, unknown>>(
        q,
        "select contact_id, amount_agorot::int as amount, method, installments, status, created_by, is_advance, advance_quote_id, order_id from public.payments where id = $1",
        [id],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("lnkw-owner");
    org = await createOrg(owner.id, "עסק ה-webhook");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]));
    await asAdmin((q) => q("insert into app.settings (key, value) values ('payment_links_fake', 'on') on conflict (key) do update set value = excluded.value"));
  });

  it("a paid event records one confirmed credit payment on the contact and marks the link paid", async () => {
    const c = await contact();
    const l = await link("contact_id", c, 7000);
    const event = paid(l, 7000);
    expect(await hook(event)).toEqual({ status: "recorded" });
    const row = await linkRow(l);
    expect(row).toMatchObject({ status: "paid", provider_payment_id: event.provider_payment_id });
    expect(await paymentRow(row.payment_id as string)).toMatchObject({ contact_id: c, amount: 7000, method: "credit", installments: 2, status: "confirmed", created_by: null, is_advance: false });
    // the same event again: nothing more
    expect(await hook(event)).toEqual({ status: "duplicate" });
    // the same payment in a new event: nothing more
    expect(await hook({ ...event, event_id: `ev_${randomUUID()}` })).toEqual({ status: "duplicate" });
    expect(await asAdmin((q) => count(q, "select 1 from public.payments where organization_id = $1 and contact_id = $2", [org, c]))).toBe(1);
  });

  it("an open document's payment is allocated to it up to its balance", async () => {
    const c = await contact();
    const d = await invoice(c, 5000);
    const l = await link("accounting_document_id", d, 5000);
    expect(await hook(paid(l, 5000))).toEqual({ status: "recorded" });
    const balance = await asAdmin(async (q) => Number((await one<{ b: string }>(q, "select app.document_balance($1, $2)::text as b", [org, d])).b));
    expect(balance).toBe(0);
  });

  it("a quote's payment is an advance for the quote; an order's carries the order", async () => {
    const c = await contact();
    const q = await asUser(owner.id, async (x) => {
      const id = (await one<{ id: string }>(x, "insert into public.quotes (organization_id, title, contact_id, valid_until) values ($1, 'הצעה', $2, current_date + 14) returning id", [org, c])).id;
      await x("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [org, id]);
      await x("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const lq = await link("quote_id", q, 3000);
    await hook(paid(lq, 3000));
    expect(await paymentRow((await linkRow(lq)).payment_id as string)).toMatchObject({ contact_id: c, is_advance: true, advance_quote_id: q });

    const o = await asUser(owner.id, async (x) => {
      const id = (await one<{ id: string }>(x, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id;
      await x("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [org, id]);
      await x("select public.order_confirm($1, $2)", [org, id]);
      return id;
    });
    const lo = await link("order_id", o, 11800);
    await hook(paid(lo, 11800));
    expect(await paymentRow((await linkRow(lo)).payment_id as string)).toMatchObject({ contact_id: c, order_id: o });
  });

  it("a link that is not pending is never paid: the owners are told to check at the provider", async () => {
    const c = await contact();
    const l = await link("contact_id", c, 500);
    await asUser(owner.id, (q) => q("update public.payment_links set status = 'cancelled' where id = $1", [l]));
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'שולם קישור תשלום שכבר לא היה פתוח'", [org]));
    expect(await hook(paid(l, 500))).toEqual({ status: "ignored" });
    expect((await linkRow(l)).status).toBe("cancelled");
    expect(await asAdmin((q) => count(q, "select 1 from public.payments where organization_id = $1 and contact_id = $2", [org, c]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'שולם קישור תשלום שכבר לא היה פתוח'", [org]))).toBe(before + 1);
  });

  it("other statuses, unknown links and malformed events change nothing", async () => {
    const c = await contact();
    const l = await link("contact_id", c, 500);
    expect(await hook({ ...paid(l, 500), status: "failed" })).toEqual({ status: "ignored" });
    expect((await linkRow(l)).status).toBe("pending");
    // review 6: a paid event for an unknown link writes one log line
    const unknown = paid(randomUUID(), 500);
    expect(await hook(unknown)).toEqual({ status: "ignored" });
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'payment_link.webhook_unknown' and details ->> 'event_id' = $1", [unknown.event_id]))).toBe(1);
    expect(await hook({ ...paid(l, 500), event_id: "bad id with spaces" })).toEqual({ status: "invalid" });
    expect(await hook({ ...paid(l, 500), paid_agorot: "lots" })).toEqual({ status: "invalid" });
    expect(await hook({ ...paid(l, 500), installments: 99 })).toEqual({ status: "invalid" });
    // review 1, 5: a paid event names its amount, currency and the provider's payment
    for (const key of ["paid_agorot", "currency", "provider_payment_id"]) {
      const e: Record<string, unknown> = paid(l, 500);
      delete e[key];
      expect(await hook(e), key).toEqual({ status: "invalid" });
    }
    // a provider not accepted here is ignored
    expect(await hook(paid(l, 500), "cardcom")).toEqual({ status: "ignored" });
    await asAdmin((q) => q("update app.settings set value = 'off' where key = 'payment_links_fake'"));
    try {
      expect(await hook(paid(l, 500))).toEqual({ status: "ignored" });
    } finally {
      await asAdmin((q) => q("update app.settings set value = 'on' where key = 'payment_links_fake'"));
    }
    expect((await linkRow(l)).status).toBe("pending");
  });

  it("review 1: another amount, currency or more instalments than the link allows records nothing and tells the owners", async () => {
    const c = await contact();
    const l = await link("contact_id", c, 500);
    const told = () => asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'תשלום בקישור לא תאם את הקישור'", [org]));
    const before = await told();
    for (const e of [paid(l, 499), paid(l, 500, { currency: "USD" }), paid(l, 500, { installments: 4 })]) {
      expect(await hook(e)).toEqual({ status: "ignored" });
      expect((await asAdmin((q) => one<{ o: string }>(q, "select outcome as o from app.payment_webhook_events where event_id = $1", [e.event_id]))).o).toBe("amount_mismatch");
    }
    expect(await told()).toBe(before + 3);
    expect((await linkRow(l)).status).toBe("pending");
    expect(await asAdmin((q) => count(q, "select 1 from public.payments where organization_id = $1 and contact_id = $2", [org, c]))).toBe(0);
  });

  it("review 9: a source with neither a deal nor a contact takes no link", async () => {
    const company = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה') returning id", [org])).id);
    const order = await asUser(owner.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, company_id) values ($1, $2) returning id", [org, company])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [org, id]);
      await q("select public.order_confirm($1, $2)", [org, id]);
      return id;
    });
    expect((await pgError(link("order_id", order, 100))).hint).toBe("payment_link:no_customer");
  });

  it("is the service role's only; a person or a visitor cannot call it; the provider payment id is the server's", async () => {
    for (const run of [(fn: (q: Query) => Promise<unknown>) => asUser(owner.id, fn), asAnon]) {
      expect((await pgError(run((q) => q("select public.payment_link_webhook('fake', '{}')")))).code).toBe("42501");
    }
    const l = await link("contact_id", await contact(), 500);
    expect((await pgError(asUser(owner.id, (q) => q("update public.payment_links set provider_payment_id = 'x' where id = $1", [l])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select 1 from app.payment_webhook_events")))).code).toBe("42501");
  });

  it("over the minute's limit the provider is asked to send again", async () => {
    const l = await link("contact_id", await contact(), 500);
    await asAdmin((q) => q("update app.payment_webhook_minutes set hits = app.payment_webhook_limit() where minute = date_trunc('minute', now())"));
    await asAdmin((q) =>
      q("insert into app.payment_webhook_minutes (slot, minute, hits) values (extract(minute from date_trunc('minute', now()))::smallint, date_trunc('minute', now()), app.payment_webhook_limit()) on conflict (slot) do update set minute = excluded.minute, hits = excluded.hits"),
    );
    expect(await hook(paid(l, 500))).toEqual({ status: "busy" });
    await asAdmin((q) => q("update app.payment_webhook_minutes set hits = 0"));
    expect((await linkRow(l)).status).toBe("pending");
  });

  it("the webhook's functions are the reviewed ones", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string }>(
            `select n.nspname || '.' || p.proname as name, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname || '.' || p.proname) = any ($1) order by 1`,
            [Object.keys(REVIEWED_MD5)],
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
  });
});

/**
 * LNK-04b (owner (422) א): a payment through a link is recorded even when the business is closed (suspended, cancelled,
 * read-only, or waiting for its deletion), and the active owners get one notice; a writable business gets none.
 */
describe("payment link webhook in a closed business (LNK-04b)", () => {
  const TITLE = "התקבל תשלום בקישור בזמן שהעסק סגור";
  const FEATURES = { payments: true, payment_links: true };
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  beforeAll(async () => {
    await asAdmin((q) => q("insert into app.settings (key, value) values ('payment_links_fake', 'on') on conflict (key) do update set value = excluded.value"));
  });

  // a business with an owner and an admin, a contact and a pending link made while it was writable
  const setup = async (label: string) => {
    const owner = await createUser(`lnkc-owner-${label}`);
    const org = await createOrg(owner.id, `עסק סגור ${label}`);
    const admin = await addMember(org, owner.id, "admin", `lnkc-admin-${label}`);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    const contact = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זהבה', $2) returning id", [org, owner.id])).id);
    const link = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.payment_links (organization_id, contact_id, amount_agorot, max_installments, expires_on, provider)
           values ($1, $2, 4200, 1, (now() at time zone 'Asia/Jerusalem')::date + 7, 'fake') returning id`,
          [org, contact],
        )
      ).id,
    );
    return { owner, admin, org, contact, link };
  };
  const pay = (link: string) =>
    asService(async (q) =>
      (
        await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_webhook('fake', $1) as r", [
          JSON.stringify({
            event_id: `ev_${randomUUID()}`,
            provider_link_id: `fake_${link}`,
            status: "paid",
            paid_agorot: 4200,
            currency: "ILS",
            provider_payment_id: `fake_payment_${randomUUID().slice(0, 8)}`,
            installments: 1,
          }),
        ])
      ).r,
    );
  const notices = (org: string) =>
    asAdmin(
      async (q) =>
        (await q<{ user_id: string; type: string; body: string }>("select user_id, type, body from public.notifications where organization_id = $1 and title = $2", [org, TITLE])).rows,
    );
  const payments = (org: string, contact: string) =>
    asAdmin((q) => count(q, "select 1 from public.payments where organization_id = $1 and contact_id = $2 and status = 'confirmed' and amount_agorot = 4200", [org, contact]));

  const closers: Record<string, (org: string, owner: string) => Promise<unknown>> = {
    suspended: (org) => asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org])),
    cancelled: (org) => asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org])),
    read_only: (org) => asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org])),
    deletion_pending: (org, owner) =>
      asAdmin((q) =>
        q(
          `insert into app.org_deletions (organization_id, requested_by, requested_at, confirmed_at, scheduled_for)
           values ($1, $2, now(), now(), now() + interval '30 days')`,
          [org, owner],
        ),
      ),
  };

  for (const [state, close] of Object.entries(closers)) {
    it(`${state}: the payment is recorded and only the owner gets one notice, with the link's title and no amount`, async () => {
      const s = await setup(state);
      await close(s.org, s.owner.id);
      expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.org_writable($1) as w", [s.org])).w)).toBe(false);
      expect(await pay(s.link)).toEqual({ status: "recorded" });
      expect(await payments(s.org, s.contact)).toBe(1);
      expect((await asAdmin((q) => one<{ status: string }>(q, "select status from public.payment_links where id = $1", [s.link]))).status).toBe("paid");
      const rows = await notices(s.org);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: s.owner.id, type: "system" });
      expect(rows[0].body).not.toMatch(/42|זהבה/);
      expect(rows.some((r) => r.user_id === s.admin.id)).toBe(false);
    });
  }

  it("a writable business gets no such notice", async () => {
    const s = await setup("open");
    expect(await pay(s.link)).toEqual({ status: "recorded" });
    expect(await payments(s.org, s.contact)).toBe(1);
    expect(await notices(s.org)).toHaveLength(0);
  });

  it("the notice helper is no role's to call", async () => {
    const s = await setup("grants");
    for (const run of [(fn: (q: Query) => Promise<unknown>) => asUser(s.owner.id, fn), asAnon, asService]) {
      expect((await pgError(run((q) => q("select app.payment_link_owner_notice($1, 'x', 'y')", [s.org])))).code).toBe("42501");
    }
    // the error above may come from schema app's usage alone: the function's own ACL holds the owner only
    const acl = await asAdmin(async (q) => (await one<{ a: string }>(q, "select coalesce(p.proacl::text, '') as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'payment_link_owner_notice'")).a);
    expect(acl).toBe("{postgres=X/postgres}");
  });
});
