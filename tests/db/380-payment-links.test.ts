import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * LNK-02 (first part of payment links; owner (270) (1) א: behind a fake provider): a link for an amount from a quote, an
 * order, an open document or a contact. Whoever records payments makes it, in a writable business with `payments` and
 * `payment_links`, for at most what is open; reading follows the source; never deleted, a pending link is cancelled; a link
 * past its last day expires; a merge moves a contact's links. LNK-03: no card details anywhere.
 */
describe("payment links (LNK-02)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U;
  let org: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, payment_links: true, quotes: true, orders: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (u: U = owner, name = "לקוח") =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])).id);
  const link = (u: U, column: string, id: string, amount: number, days = 7, installments = 1) =>
    run(u, async (q) =>
      one<{ id: string; status: string; title: string; provider_link_id: string; expires_at: string; created_by: string }>(
        q,
        `insert into public.payment_links (organization_id, ${column}, amount_agorot, max_installments, expires_on, provider)
         values ($1, $2, $3, $4, (now() at time zone 'Asia/Jerusalem')::date + $5::int, 'fake')
         returning id, status, title, provider_link_id, expires_at::text, created_by`,
        [org, id, amount, installments, days],
      ),
    );
  const hint = async (p: Promise<unknown>) => {
    const e = await pgError(p);
    return e.hint ?? e.code;
  };
  const sentQuote = async (contactId: string, price = 10000, validDays = 14) =>
    run(owner, async (q) => {
      const id = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id, valid_until) values ($1, 'הצעה', $2, current_date + $3::int) returning id", [
          org,
          contactId,
          validDays,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, $3, 1)", [org, id, price]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
  const numberedOrder = async (contactId: string) =>
    run(owner, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contactId])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [org, id]);
      await q("select public.order_confirm($1, $2)", [org, id]);
      return id;
    });
  const invoice = (contactId: string, amount: number, type = "tax_invoice") =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5) returning id", [
          org,
          contactId,
          type,
          `LNK-${++n}`,
          amount,
        ])
      ).id,
    );

  beforeAll(async () => {
    owner = await createUser("lnk-owner");
    org = await createOrg(owner.id, "עסק קישורי התשלום");
    admin = await addMember(org, owner.id, "admin", "lnk-admin");
    manager = await addMember(org, owner.id, "manager", "lnk-manager");
    member = await addMember(org, owner.id, "member", "lnk-member");
    viewer = await addMember(org, owner.id, "viewer", "lnk-viewer");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("a free amount on a contact: the server fills title, status, provider id and the end of the last day", async () => {
    const c = await contact();
    const l = await link(owner, "contact_id", c, 25000, 3, 6);
    expect(l).toMatchObject({ status: "pending", title: "תשלום", provider_link_id: `fake_${l.id}`, created_by: owner.id });
    const row = await asAdmin(async (q) =>
      one<{ ok: boolean; hosted: string | null; cur: string }>(
        q,
        "select expires_at = ((expires_on + 1)::timestamp at time zone 'Asia/Jerusalem') as ok, hosted_url as hosted, currency as cur from public.payment_links where id = $1",
        [l.id],
      ),
    );
    expect(row).toEqual({ ok: true, hosted: null, cur: "ILS" });
    // audited
    const audit = await asAdmin(async (q) => (await q("select 1 from public.audit_log where entity_type = 'payment_links' and entity_id = $1", [l.id])).rowCount);
    expect(audit).toBeGreaterThan(0);
  });

  it("whoever records payments makes it; members, viewers and outsiders cannot", async () => {
    const c = await contact();
    for (const u of [admin, manager]) expect((await link(u, "contact_id", c, 100)).status).toBe("pending");
    for (const u of [member, viewer]) expect((await pgError(link(u, "contact_id", c, 100))).code, u.email).toBe("42501");
    // the personal key record_payments lets a member make one
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, member.id]));
    expect((await link(member, "contact_id", c, 100)).status).toBe("pending");
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{}')", [org, member.id]));
    const stranger = await createUser("lnk-stranger");
    await createOrg(stranger.id, "עסק זר");
    expect((await pgError(link(stranger, "contact_id", c, 100))).code).toBe("42501");
  });

  it("a deposit on a quote: open quotes only, at most the total with VAT", async () => {
    const c = await contact();
    const q = await sentQuote(c, 10000);
    const total = await asAdmin(async (x) => Number((await one<{ t: string }>(x, "select total_agorot::text as t from public.quotes where id = $1", [q])).t));
    expect(total).toBe(11800);
    expect(await hint(link(owner, "quote_id", q, total + 1))).toBe("payment_link:over");
    const l = await link(owner, "quote_id", q, 3000);
    expect(l.title).toMatch(/^מקדמה להצעת מחיר/);
    // a draft quote is not open for payment
    const draft = await run(owner, async (x) => (await one<{ id: string }>(x, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'טיוטה', $2) returning id", [org, c])).id);
    expect(await hint(link(owner, "quote_id", draft, 100))).toBe("payment_link:source_state");
    // past its validity: refused
    const old = await sentQuote(c, 10000, 1);
    await asAdmin(async (x) => {
      await x("set local session_replication_role = replica");
      await x("update public.quotes set quote_date = current_date - 5, valid_until = current_date - 2 where id = $1", [old]);
    });
    expect(await hint(link(owner, "quote_id", old, 100))).toBe("payment_link:source_state");
  });

  it("an order: numbered and not cancelled; a document: an open debt, at most its balance", async () => {
    const c = await contact();
    const o = await numberedOrder(c);
    expect((await link(owner, "order_id", o, 11800)).title).toMatch(/^תשלום להזמנה/);
    expect(await hint(link(owner, "order_id", o, 11801))).toBe("payment_link:over");
    const draft = await run(owner, async (x) => (await one<{ id: string }>(x, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
    expect(await hint(link(owner, "order_id", draft, 100))).toBe("payment_link:source_state");

    const d = await invoice(c, 5000);
    await run(owner, async (x) => {
      const p = (await one<{ id: string }>(x, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 2000, 'cash') returning id", [org, c])).id;
      await x("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 2000)", [org, p, d]);
    });
    expect(await hint(link(owner, "accounting_document_id", d, 3001))).toBe("payment_link:over");
    expect((await link(owner, "accounting_document_id", d, 3000)).title).toBe("תשלום לחשבונית מס LNK-" + n);
    // a receipt is not a debt
    const r = await invoice(c, 5000, "receipt");
    expect(await hint(link(owner, "accounting_document_id", r, 100))).toBe("payment_link:source_state");
  });

  it("the last day is today up to 90 days; exactly one source; at most 20 pending per source", async () => {
    const c = await contact();
    expect(await hint(link(owner, "contact_id", c, 100, -1))).toBe("payment_link:expires");
    expect(await hint(link(owner, "contact_id", c, 100, 91))).toBe("payment_link:expires");
    expect((await link(owner, "contact_id", c, 100, 90)).status).toBe("pending");
    expect((await link(owner, "contact_id", c, 100, 0)).status).toBe("pending");
    const q = await sentQuote(c);
    const both = await pgError(
      run(owner, (x) =>
        x("insert into public.payment_links (organization_id, contact_id, quote_id, amount_agorot, expires_on, provider) values ($1, $2, $3, 1, current_date + 1, 'fake')", [org, c, q]),
      ),
    );
    expect(["23514", "P0001"]).toContain(both.code);
    // a provider outside the closed list
    expect((await pgError(run(owner, (x) => x("insert into public.payment_links (organization_id, contact_id, amount_agorot, expires_on, provider) values ($1, $2, 1, current_date + 1, 'cardcom')", [org, c])))).code).toBe("23514");
    const c2 = await contact();
    for (let i = 0; i < 20; i++) await link(owner, "contact_id", c2, 100);
    expect(await hint(link(owner, "contact_id", c2, 100))).toBe("payment_link:max");
  });

  it("without the plan keys nothing is made", async () => {
    const c = await contact();
    for (const key of ["payment_links", "payments"]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, [key]: false })]));
      expect(await hint(link(owner, "contact_id", c, 100)), key).toBe(`feature:${key}`);
    }
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, quotes: true })]));
    const q = await sentQuote(c);
    await asAdmin((x) => x("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, quotes: false })]));
    expect(await hint(link(owner, "quote_id", q, 100))).toBe("feature:quotes");
    await asAdmin((x) => x("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
  });

  it("a read-only business makes no link", async () => {
    const c = await contact();
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(link(owner, "contact_id", c, 100))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("reading follows the source: a member who does not read the contact does not see its links", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const c = await contact(owner);
      const l = await link(owner, "contact_id", c, 100);
      const seen = (u: U) => run(u, async (q) => (await q("select 1 from public.payment_links where id = $1", [l.id])).rowCount);
      expect(await seen(admin)).toBe(1);
      expect(await seen(member)).toBe(0);
      expect(await asUser(member.id, async (q) => (await q("update public.payment_links set status = 'cancelled' where id = $1", [l.id])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a person only cancels a pending link; it is never deleted and never changes otherwise", async () => {
    const c = await contact();
    const l = await link(owner, "contact_id", c, 500);
    // the member reads it but may not cancel (no write right)
    expect(await run(member, async (q) => (await q("update public.payment_links set status = 'cancelled' where id = $1", [l.id])).rowCount)).toBe(0);
    expect((await pgError(run(owner, (q) => q("update public.payment_links set amount_agorot = 1 where id = $1", [l.id])))).code).toBe("42501");
    expect(await hint(run(owner, (q) => q("update public.payment_links set status = 'paid' where id = $1", [l.id])))).toBe("payment_link:frozen");
    expect((await run(manager, (q) => q("update public.payment_links set status = 'cancelled' where id = $1 returning id", [l.id]))).rowCount).toBe(1);
    const row = await asAdmin(async (q) => one<{ status: string; by: string; at: string | null }>(q, "select status, cancelled_by as by, cancelled_at::text as at from public.payment_links where id = $1", [l.id]));
    expect(row.status).toBe("cancelled");
    expect(row.by).toBe(manager.id);
    expect(row.at).not.toBeNull();
    expect(await hint(run(owner, (q) => q("update public.payment_links set status = 'pending' where id = $1", [l.id])))).toBe("payment_link:closed");
    expect((await pgError(run(owner, (q) => q("delete from public.payment_links where id = $1", [l.id])))).code).toBe("42501");
  });

  it("a pending link past its last day expires by the job; a finished one stays", async () => {
    const c = await contact();
    const due = await link(owner, "contact_id", c, 100);
    const later = await link(owner, "contact_id", c, 100);
    // set the last day back without the row trigger (no writer may change it): the job then finds it due
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.payment_links set expires_at = now() - interval '1 minute' where id = $1", [due.id]);
    });
    expect(await asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.expire_payment_links() as n")).n))).toBeGreaterThanOrEqual(1);
    const states = await asAdmin(async (q) => (await q<{ id: string; status: string }>("select id, status from public.payment_links where id = any($1)", [[due.id, later.id]])).rows);
    expect(Object.fromEntries(states.map((s) => [s.id, s.status]))).toEqual({ [due.id]: "expired", [later.id]: "pending" });
    // the server never moves a finished link
    expect(
      await hint(
        asAdmin(async (q) => {
          await q("select set_config('app.payment_link_server', 'on', true)");
          await q("update public.payment_links set status = 'paid' where id = $1", [due.id]);
        }),
      ),
    ).toBe("payment_link:closed");
  });

  it("a contact merge moves the duplicate's free links; a purge takes them", async () => {
    const keep = await contact(owner, "דנה");
    const dup = await contact(owner, "דנה");
    const l = await link(owner, "contact_id", dup, 700);
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    const moved = await asAdmin(async (q) => one<{ contact_id: string; status: string }>(q, "select contact_id, status from public.payment_links where id = $1", [l.id]));
    expect(moved).toEqual({ contact_id: keep, status: "pending" });
    await asAdmin((q) => q("delete from public.contacts where id = $1", [keep]));
    expect(await asAdmin(async (q) => (await q("select 1 from public.payment_links where id = $1", [l.id])).rowCount)).toBe(0);
  });

  it("a link is real work: a sample contact with one is kept, and an imported contact with one is worked on", async () => {
    const c = await contact();
    const before = await asAdmin(async (q) => one<{ s: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 day', null) as s", [org, c]));
    expect(before.s).toBe(false);
    await link(owner, "contact_id", c, 100);
    const after = await asAdmin(async (q) => one<{ s: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 day', null) as s", [org, c]));
    expect(after.s).toBe(true);
    const snap = await asAdmin(async (q) => one<{ r: unknown }>(q, "select app.sample_row($1, 'contact', $2) as r", [org, c]));
    const untouched = await asAdmin(async (q) => one<{ u: boolean }>(q, "select app.sample_untouched($1, 'contact', $2, $3::jsonb) as u", [org, c, JSON.stringify(snap.r)]));
    expect(untouched.u).toBe(false);
  });

  it("no client grant reaches the server's columns; no card field exists", async () => {
    const cols = await asAdmin(async (q) =>
      (
        await q<{ c: string; p: string }>(
          "select column_name as c, privilege_type as p from information_schema.column_privileges where table_schema = 'public' and table_name = 'payment_links' and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE') order by 2, 1",
        )
      ).rows.map((r) => `${r.p}:${r.c}`),
    );
    expect(cols).toEqual([
      "INSERT:accounting_document_id",
      "INSERT:amount_agorot",
      "INSERT:contact_id",
      "INSERT:currency",
      "INSERT:expires_on",
      "INSERT:max_installments",
      "INSERT:order_id",
      "INSERT:organization_id",
      "INSERT:provider",
      "INSERT:quote_id",
      "UPDATE:status",
    ]);
    const all = await asAdmin(async (q) => (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'payment_links'")).rows.map((r) => r.c));
    expect(all.filter((c) => /card|cvv|cvc|pan|security/.test(c))).toEqual([]);
    // anon has nothing
    expect(await asAdmin(async (q) => (await q("select 1 from information_schema.role_table_grants where table_name = 'payment_links' and grantee = 'anon'")).rowCount)).toBe(0);
  });
});
