import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { deals: number; amount: number };
type Group<R> = { count: number; amount: number; rows: R[] };
type QuoteRow = {
  id: string;
  deal_id: string | null;
  amount_agorot: number;
  total_agorot: number;
  owner_id: string | null;
};
type DebtRow = {
  id: string;
  balance: number;
  days_overdue: number;
  owner_id: string | null;
  doc_type: string;
};
type RenewalRow = {
  id: string;
  amount_agorot: number | null;
  renewal_date: string;
};
type Money = {
  today: string;
  to_close: Line;
  stuck: Line;
  overdue: Line;
  deals: Array<{ id: string; stuck: boolean; overdue: boolean }>;
  quotes: Group<QuoteRow> | null;
  debts: Group<DebtRow> | null;
  renewals: Group<RenewalRow>;
};
type Cleanup = { stuck: Line; overdue: Line; deals: Array<{ id: string }> };

/**
 * MNY-01, the three groups whose modules exist: quotes sent and not answered (one per chain, open, by the business's
 * date), overdue debts (balance by money_allocation_state, a billed proforma not counted twice) and renewals in the next
 * 30 days. Every record counts once across the groups; RLS decides what each person counts; the plan flags hide a group.
 */
describe("money waiting: quotes, debts and renewals (MNY-01)", () => {
  let owner: U, m1: U, m2: U, viewer: U, outsider: U;
  let org: string;
  let pipeline: string, firstOpen: string, wonStage: string;
  let c1: string, c2: string;
  let today: string;
  let n = 0;
  const ids: Record<string, string> = {};

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const money = (u: U, owner: string | null = null) =>
    asUser(u.id, async (q) => (await one<{ r: Money }>(q, "select public.report_money_waiting($1, $2) as r", [org, owner])).r);
  const cleanup = (u: U) => asUser(u.id, async (q) => (await one<{ r: Cleanup }>(q, "select public.report_pipeline_cleanup($1) as r", [org])).r);
  const day = (offset: number) =>
    asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char($1::date + $2::int, 'YYYY-MM-DD') as d", [today, offset])).d);
  const orgToday = () =>
    asAdmin(
      async (q) =>
        (
          await one<{ d: string }>(q, "select to_char((now() at time zone o.timezone)::date, 'YYYY-MM-DD') as d from public.organizations o where o.id = $1", [
            org,
          ])
        ).d,
    );

  const deal = (u: U, name: string, extra: Record<string, unknown> = {}, stage = firstOpen) =>
    asUser(u.id, async (q) => {
      const cols = ["organization_id", "name", "owner_id", "pipeline_id", "stage_id", ...Object.keys(extra)];
      const vals = [org, name, u.id, pipeline, stage, ...Object.values(extra)];
      return (
        await one<{ id: string }>(q, `insert into public.deals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals)
      ).id;
    });
  const makeStuck = (dealId: string) => asAdmin((q) => q("update public.deals set stage_entered_at = now() - interval '30 days' where id = $1", [dealId]));
  const quote = async (u: U, dealId: string, price: number, validUntil: string | null = null) =>
    asUser(u.id, async (q) => {
      const id = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, $2, $3, $4) returning id", [
          org,
          `הצעה ${++n}`,
          dealId,
          validUntil,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', $3)", [org, id, price]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
  const doc = (type: string, amount: number, on: { contact: string; due: string; proforma?: string }) =>
    asUser(
      owner.id,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, proforma_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, $4, $5, $6::date - 60, $7, $8) returning id",
            [org, on.contact, on.proforma ?? null, type, `MW-${++n}`, today, amount, on.due],
          )
        ).id,
    );
  const payTo = (documentId: string, contactId: string, amount: number) =>
    asUser(owner.id, async (q) => {
      const pay = (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, $3, 'transfer') returning id",
          [org, contactId, amount],
        )
      ).id;
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [
        org,
        pay,
        documentId,
        amount,
      ]);
    });
  const setOverrides = (value: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(value)]));
  const setVisibility = (v: "org" | "own") => asUser(owner.id, (q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, v]));
  const sorted = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  beforeAll(async () => {
    owner = await createUser("mw-owner");
    outsider = await createUser("mw-outsider");
    org = await createOrg(owner.id, "עסק הכסף");
    await createOrg(outsider.id, "עסק אחר");
    m1 = await addMember(org, owner.id, "member", "mw-m1");
    m2 = await addMember(org, owner.id, "member", "mw-m2");
    viewer = await addMember(org, owner.id, "viewer", "mw-viewer");
    await setOverrides({ quotes: true, documents: true, payments: true });
    await asUser(owner.id, (q) =>
      q(
        "insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'",
        [org],
      ),
    );
    await asAdmin(async (q) => {
      pipeline = (await one<{ id: string }>(q, "select id from public.pipelines where organization_id = $1 and is_default", [org])).id;
      firstOpen = (await one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [pipeline]))
        .id;
      wonStage = (await one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [pipeline])).id;
      await q("update public.stages set rot_days = null where id = $1", [firstOpen]);
    });
    today = await orgToday();
    c1 = await asUser(
      m1.id,
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, m1.id]))
          .id,
    );
    c2 = await asUser(
      m2.id,
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'יוסי', $2) returning id", [org, m2.id]))
          .id,
    );

    // deals and quotes
    ids.dQ = await deal(m1, "תקועה עם הצעה", { amount_agorot: 100000 });
    await makeStuck(ids.dQ);
    ids.qA = await quote(m1, ids.dQ, 10000);
    ids.dS = await deal(m1, "תקועה", { amount_agorot: 50000 });
    await makeStuck(ids.dS);
    ids.dChain = await deal(m2, "גרסאות", { amount_agorot: 20000 });
    ids.qV1 = await quote(m2, ids.dChain, 20000);
    ids.qV2 = await asUser(m2.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, ids.qV1])).v);
    await asUser(m2.id, (q) => q("select public.quote_send($1, $2)", [org, ids.qV2]));
    ids.dExp = await deal(m2, "הצעה שפגה", { amount_agorot: 1000 });
    ids.qExp = await quote(m2, ids.dExp, 7000);
    // sent a while ago, valid until yesterday (the expiry job has not run yet)
    // (the server keeps a sent quote's dates; triggers are set aside for this one fixture row)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set quote_date = $2::date - 10, valid_until = $2::date - 1 where id = $1", [ids.qExp, today]);
    });
    ids.dOverQ = await deal(m2, "באיחור עם הצעה", {
      amount_agorot: 40000,
      expected_close_date: await day(-3),
    });
    ids.qOver = await quote(m2, ids.dOverQ, 40000, today);
    ids.dOver = await deal(m2, "באיחור", {
      amount_agorot: 3000,
      expected_close_date: await day(-3),
    });
    ids.dDeclined = await deal(m1, "הצעה שנדחתה", { amount_agorot: 1000 });
    ids.qDeclined = await quote(m1, ids.dDeclined, 6000);
    await asAdmin((q) => q("update public.quotes set status = 'rejected' where id = $1", [ids.qDeclined]));

    // recurring deals
    const recurring = async (u: U, name: string, kind: string, amount: number, renewIn: number, stage = wonStage) =>
      deal(
        u,
        name,
        {
          billing_kind: kind,
          recurring_amount_agorot: amount,
          recurring_start_date: await day(-200),
          renewal_date: await day(renewIn),
        },
        stage,
      );
    ids.rWon = await recurring(m1, "מנוי", "monthly", 5000, 10);
    ids.rStuck = await recurring(m1, "מנוי תקוע", "yearly", 9000, 5, firstOpen);
    await makeStuck(ids.rStuck);
    ids.rQuote = await recurring(m1, "מנוי עם הצעה", "yearly", 8000, 20);
    ids.qR = await quote(m1, ids.rQuote, 30000);
    ids.rFar = await recurring(m1, "מנוי רחוק", "yearly", 1000, 40);
    ids.rPast = await recurring(m1, "מנוי שעבר", "yearly", 1000, -1);
    ids.rFollowed = await recurring(m1, "מנוי שחודש", "yearly", 1000, 3);
    await deal(m1, "חידוש", { previous_deal_id: ids.rFollowed });
    ids.rEdge = await recurring(m2, "מנוי בקצה", "monthly", 2500, 30);

    // documents
    ids.inv1 = await doc("tax_invoice", 10000, {
      contact: c1,
      due: await day(-1),
    });
    await payTo(ids.inv1, c1, 4000);
    ids.invToday = await doc("tax_invoice", 9000, { contact: c1, due: today });
    ids.invPaid = await doc("tax_invoice", 3000, {
      contact: c1,
      due: await day(-5),
    });
    await payTo(ids.invPaid, c1, 3000);
    ids.pro = await doc("proforma", 20000, { contact: c1, due: await day(-7) });
    await payTo(ids.pro, c1, 5000);
    ids.inv4 = await doc("tax_invoice", 20000, {
      contact: c1,
      due: await day(-2),
      proforma: ids.pro,
    });
    ids.cancelled = await doc("tax_invoice", 4000, {
      contact: c1,
      due: await day(-4),
    });
    await asUser(owner.id, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [ids.cancelled]));
    ids.opening = await asUser(
      owner.id,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, doc_date, amount_agorot, due_date) values ($1, $2, 'opening_balance', $3::date - 90, 7000, $3::date - 30) returning id",
            [org, c2, today],
          )
        ).id,
    );
  });

  it("quotes: open sent quotes, one per chain, net before VAT; declined and expired are left out", async () => {
    const m = await money(owner);
    expect(m.quotes).not.toBeNull();
    expect(sorted(m.quotes!.rows)).toEqual([ids.qA, ids.qV2, ids.qOver, ids.qR].sort());
    expect(m.quotes!.count).toBe(4);
    expect(m.quotes!.amount).toBe(10000 + 20000 + 40000 + 30000);
    const a = m.quotes!.rows.find((r) => r.id === ids.qA)!;
    expect(a.amount_agorot).toBe(10000);
    // the VAT is on the row for the screen, not in the sum
    expect(a.total_agorot).toBeGreaterThan(a.amount_agorot);
  });

  it("each deal once: a deal with an open quote leaves stuck and overdue, and the cleanup itself is unchanged", async () => {
    const [m, c] = [await money(owner), await cleanup(owner)];
    expect(c.deals.map((d) => d.id)).toEqual(expect.arrayContaining([ids.dQ, ids.dS, ids.dOverQ, ids.dOver, ids.rStuck]));
    expect(m.stuck).toEqual({
      deals: c.stuck.deals - 1,
      amount: c.stuck.amount - 100000,
    });
    expect(m.overdue).toEqual({
      deals: c.overdue.deals - 1,
      amount: c.overdue.amount - 40000,
    });
    expect(m.to_close).toEqual({
      deals: m.stuck.deals + m.overdue.deals,
      amount: m.stuck.amount + m.overdue.amount,
    });
    const listed = m.deals.map((d) => d.id);
    expect(listed).not.toContain(ids.dQ);
    expect(listed).not.toContain(ids.dOverQ);
    expect(listed).toEqual(expect.arrayContaining([ids.dS, ids.dOver, ids.rStuck]));
  });

  it("renewals: open or won recurring deals renewing today through 30 days ahead, one period each, not counted twice", async () => {
    const m = await money(owner);
    // rStuck is in stuck, rQuote in quotes, rFollowed has a renewal deal of its own; rFar and rPast are outside the window
    expect(sorted(m.renewals.rows)).toEqual([ids.rWon, ids.rEdge].sort());
    expect(m.renewals).toMatchObject({ count: 2, amount: 7500 });
    expect(m.renewals.rows.find((r) => r.id === ids.rWon)!.amount_agorot).toBe(5000);
  });

  it("debts: overdue balances only, a billed proforma not counted twice, a positive opening balance counts", async () => {
    const m = await money(owner);
    expect(m.debts).not.toBeNull();
    expect(sorted(m.debts!.rows)).toEqual([ids.inv1, ids.inv4, ids.opening].sort());
    const by = new Map(m.debts!.rows.map((r) => [r.id, r]));
    expect(by.get(ids.inv1)).toMatchObject({ balance: 6000, days_overdue: 1 });
    // the proforma's 5,000 counts on the invoice that bills it
    expect(by.get(ids.inv4)).toMatchObject({ balance: 15000, days_overdue: 2 });
    expect(by.get(ids.opening)).toMatchObject({
      balance: 7000,
      doc_type: "opening_balance",
      owner_id: m2.id,
    });
    expect(m.debts).toMatchObject({ count: 3, amount: 28000 });
  });

  it("with an owner: that person's quotes, debts and renewals", async () => {
    const m = await money(owner, m2.id);
    expect(sorted(m.quotes!.rows)).toEqual([ids.qV2, ids.qOver].sort());
    expect(sorted(m.debts!.rows)).toEqual([ids.opening]);
    expect(sorted(m.renewals.rows)).toEqual([ids.rEdge]);
    // the quote still hides its deal in that person's overdue list
    expect(m.deals.map((d) => d.id)).not.toContain(ids.dOverQ);
  });

  it("RLS decides: under 'own' a member counts only their records, a viewer none; a viewer sees all under 'org'", async () => {
    const all = await money(owner);
    expect(await money(viewer)).toMatchObject({
      quotes: all.quotes,
      debts: all.debts,
      renewals: all.renewals,
    });
    await setVisibility("own");
    try {
      const m = await money(m1);
      expect(sorted(m.quotes!.rows)).toEqual([ids.qA, ids.qR].sort());
      expect(sorted(m.debts!.rows)).toEqual([ids.inv1, ids.inv4].sort());
      expect(sorted(m.renewals.rows)).toEqual([ids.rWon]);
      const v = await money(viewer);
      expect(v.quotes).toMatchObject({ count: 0, amount: 0, rows: [] });
      expect(v.debts).toMatchObject({ count: 0, amount: 0, rows: [] });
      expect(v.renewals).toMatchObject({ count: 0, amount: 0, rows: [] });
    } finally {
      await setVisibility("org");
    }
  });

  it("another business gets nothing, and anon may not call it", async () => {
    expect(await asUser(outsider.id, async (q) => (await one<{ r: unknown }>(q, "select public.report_money_waiting($1) as r", [org])).r)).toBeNull();
    expect((await pgError(asAnon((q) => q("select public.report_money_waiting($1)", [org])))).code).toBe("42501");
  });

  it("the plan flags hide a group: without quotes the deal is back in stuck; without documents or payments no debts", async () => {
    await setOverrides({ quotes: false, documents: true, payments: true });
    try {
      const [m, c] = [await money(owner), await cleanup(owner)];
      expect(m.quotes).toBeNull();
      expect(m.stuck).toEqual(c.stuck);
      expect(m.overdue).toEqual(c.overdue);
      expect(m.deals.map((d) => d.id)).toContain(ids.dQ);
      // the renewal with a quote is a renewal again
      expect(m.renewals.rows.map((r) => r.id)).toContain(ids.rQuote);
    } finally {
      await setOverrides({ quotes: true, documents: true, payments: true });
    }
    for (const off of [
      { documents: false, payments: true },
      { documents: true, payments: false },
    ]) {
      await setOverrides({ quotes: true, ...off });
      try {
        expect((await money(owner)).debts).toBeNull();
      } finally {
        await setOverrides({ quotes: true, documents: true, payments: true });
      }
    }
  });

  it("the business's own date decides each group at midnight", async () => {
    // two zones 25 hours apart: their dates always differ, the eastern one is later
    const zones = { east: "Pacific/Kiritimati", west: "Pacific/Pago_Pago" };
    const setZone = (z: string) => asUser(owner.id, (q) => q("update public.organizations set timezone = $2 where id = $1", [org, z]));
    try {
      await setZone(zones.west);
      const west = await orgToday();
      await setZone(zones.east);
      const east = await orgToday();
      expect(east > west).toBe(true);

      await setZone(zones.west);
      const zDeal = await deal(m2, "גבול", { amount_agorot: 1000 });
      const zQuote = await quote(m2, zDeal, 1100, west);
      const zDebt = await doc("tax_invoice", 1200, { contact: c2, due: west });
      const zRenewToday = await deal(
        m2,
        "חידוש היום",
        {
          billing_kind: "yearly",
          recurring_amount_agorot: 1300,
          recurring_start_date: "2025-01-01",
          renewal_date: west,
        },
        wonStage,
      );
      const zRenewEnd = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char($1::date + 30, 'YYYY-MM-DD') as d", [east])).d).then((end) =>
        deal(
          m2,
          "חידוש בסוף",
          {
            billing_kind: "yearly",
            recurring_amount_agorot: 1400,
            recurring_start_date: "2025-01-01",
            renewal_date: end,
          },
          wonStage,
        ),
      );

      // west: the quote is valid today, the invoice is due today (not late), the renewal is today, the far one is past 30 days
      let m = await money(owner);
      expect(m.quotes!.rows.map((r) => r.id)).toContain(zQuote);
      expect(m.debts!.rows.map((r) => r.id)).not.toContain(zDebt);
      expect(m.renewals.rows.map((r) => r.id)).toContain(zRenewToday);
      expect(m.renewals.rows.map((r) => r.id)).not.toContain(zRenewEnd);

      // east: a day later, the quote has lapsed, the invoice is late, the first renewal is past, the second is in the window
      await setZone(zones.east);
      m = await money(owner);
      expect(m.quotes!.rows.map((r) => r.id)).not.toContain(zQuote);
      expect(m.debts!.rows.map((r) => r.id)).toContain(zDebt);
      expect(m.renewals.rows.map((r) => r.id)).not.toContain(zRenewToday);
      expect(m.renewals.rows.map((r) => r.id)).toContain(zRenewEnd);
    } finally {
      await setZone("Asia/Jerusalem");
    }
  });

  it("stays security invoker with its signature and grants", async () => {
    const fn = await asAdmin(async (q) =>
      one<{ definer: boolean; args: string; auth: boolean; anon: boolean }>(
        q,
        `select p.prosecdef as definer, pg_get_function_identity_arguments(p.oid) as args,
                has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('anon', p.oid, 'execute') as anon
           from pg_proc p where p.oid = 'public.report_money_waiting(uuid, uuid)'::regprocedure`,
      ),
    );
    expect(fn).toEqual({
      definer: false,
      args: "p_org uuid, p_owner uuid",
      auth: true,
      anon: false,
    });
  });
});
