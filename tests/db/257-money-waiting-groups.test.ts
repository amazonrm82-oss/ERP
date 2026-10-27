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
  net_agorot: number;
  total_agorot: number;
  owner_id: string | null;
};
type DebtRow = {
  id: string;
  balance: number;
  days_overdue: number;
  owner_id: string | null;
  doc_type: string;
  deal_contact_id: string | null;
};
type RenewalRow = {
  id: string;
  amount_agorot: number | null;
  renewal_date: string;
};
type Money = {
  today: string;
  vat: { mode: "included" | "none" | "unknown"; rate_bp: number | null };
  to_close: Line;
  stuck: Line;
  overdue: Line;
  deals: Array<{ id: string; stuck: boolean; overdue: boolean }>;
  quotes: Group<QuoteRow> | null;
  debts: Group<DebtRow> | null;
  renewals: Group<RenewalRow>;
};
type Cleanup = { stuck: Line; overdue: Line; deals: Array<{ id: string; stuck: boolean; overdue: boolean; amount_agorot: number }> };

// a before-VAT amount with VAT, half up in agorot (app.money_with_vat)
const withVat = (amount: number, rate: number | null) => (rate ? amount + Math.round((amount * rate) / 10000) : amount);

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

    // review: m1's stuck deal with an open quote sent by the owner (whose view hides the deal), and a quote on a lost deal
    ids.dP = await deal(m1, "תקועה עם הצעה של אחר", { amount_agorot: 70000 });
    await makeStuck(ids.dP);
    ids.qP = await quote(owner, ids.dP, 12000);
    ids.dL = await deal(m1, "עסקה שאבדה", { amount_agorot: 1000 });
    ids.qL = await quote(m1, ids.dL, 8000);
    await asAdmin((q) =>
      q("update public.deals d set stage_id = s.id from public.stages s where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'lost'", [ids.dL]),
    );

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
    // an invoice on a deal with no contact: the reminder goes to the deal's contact
    ids.dDebt = await deal(m1, "עסקה עם חשבונית", { amount_agorot: 6000, contact_id: c1 });
    ids.invDeal = await asUser(
      owner.id,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, deal_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, 'tax_invoice', 'MW-DEAL', $3::date - 30, 6000, $3::date - 3) returning id",
            [org, ids.dDebt, today],
          )
        ).id,
    );
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

  it("quotes: open sent quotes, one per chain, with VAT; declined, expired and on a lost deal are left out; a won deal's stays", async () => {
    const m = await money(owner);
    expect(m.vat.mode).toBe("included");
    expect(m.vat.rate_bp).toBeGreaterThan(0);
    expect(m.quotes).not.toBeNull();
    expect(sorted(m.quotes!.rows)).toEqual([ids.qA, ids.qV2, ids.qOver, ids.qR, ids.qP].sort());
    expect(m.quotes!.rows.map((r) => r.id)).not.toContain(ids.qL);
    expect(m.quotes!.count).toBe(5);
    // the value counted is the stored total with VAT
    for (const row of m.quotes!.rows) expect(row.amount_agorot).toBe(row.total_agorot);
    expect(m.quotes!.amount).toBe(m.quotes!.rows.reduce((sum, r) => sum + r.total_agorot, 0));
    const a = m.quotes!.rows.find((r) => r.id === ids.qA)!;
    expect(a.net_agorot).toBe(10000);
    expect(a.total_agorot).toBe(withVat(10000, m.vat.rate_bp));
  });

  it("each deal once: a deal with an open quote leaves stuck and overdue; amounts are summed per deal with VAT", async () => {
    const [m, c] = [await money(owner), await cleanup(owner)];
    const rate = m.vat.rate_bp;
    expect(c.deals.map((d) => d.id)).toEqual(expect.arrayContaining([ids.dQ, ids.dP, ids.dS, ids.dOverQ, ids.dOver, ids.rStuck]));
    const hidden = new Set([ids.dQ, ids.dP, ids.dOverQ]);
    const kept = c.deals.filter((d) => !hidden.has(d.id));
    const sum = (rows: typeof kept) => rows.reduce((total, d) => total + withVat(d.amount_agorot ?? 0, rate), 0);
    expect(m.stuck).toEqual({ deals: c.stuck.deals - 2, amount: sum(kept.filter((d) => d.stuck)) });
    expect(m.overdue).toEqual({ deals: c.overdue.deals - 1, amount: sum(kept.filter((d) => !d.stuck && d.overdue)) });
    expect(m.to_close).toEqual({ deals: m.stuck.deals + m.overdue.deals, amount: m.stuck.amount + m.overdue.amount });
    const listed = m.deals.map((d) => d.id);
    for (const id of hidden) expect(listed).not.toContain(id);
    expect(listed).toEqual(expect.arrayContaining([ids.dS, ids.dOver, ids.rStuck]));
    expect((m.deals.find((d) => d.id === ids.dS) as unknown as { amount_agorot: number }).amount_agorot).toBe(withVat(50000, rate));
  });

  it("a quote hides its deal only in a view that counts the quote (lead's decision)", async () => {
    // m1 owns the stuck deal, the owner sent the open quote on it
    const mine = await money(owner, m1.id);
    expect(mine.deals.find((d) => d.id === ids.dP)).toMatchObject({ stuck: true });
    expect(mine.quotes!.rows.map((r) => r.id)).not.toContain(ids.qP);
    const theirs = await money(owner, owner.id);
    expect(theirs.quotes!.rows.map((r) => r.id)).toContain(ids.qP);
    const all = await money(owner);
    expect(all.deals.map((d) => d.id)).not.toContain(ids.dP);
    expect(all.quotes!.rows.filter((r) => r.id === ids.qP)).toHaveLength(1);
  });

  it("renewals: open or won recurring deals renewing today through 30 days ahead, one period each, not counted twice", async () => {
    const m = await money(owner);
    // rStuck is in stuck, rQuote in quotes, rFollowed has a renewal deal of its own; rFar and rPast are outside the window
    expect(sorted(m.renewals.rows)).toEqual([ids.rWon, ids.rEdge].sort());
    expect(m.renewals).toMatchObject({ count: 2, amount: withVat(5000, m.vat.rate_bp) + withVat(2500, m.vat.rate_bp) });
    expect(m.renewals.rows.find((r) => r.id === ids.rWon)!.amount_agorot).toBe(withVat(5000, m.vat.rate_bp));
  });

  it("debts: overdue balances only, a billed proforma not counted twice, a positive opening balance counts", async () => {
    const m = await money(owner);
    expect(m.debts).not.toBeNull();
    expect(sorted(m.debts!.rows)).toEqual([ids.inv1, ids.inv4, ids.invDeal, ids.opening].sort());
    const by = new Map(m.debts!.rows.map((r) => [r.id, r]));
    expect(by.get(ids.inv1)).toMatchObject({ balance: 6000, days_overdue: 1 });
    // the proforma's 5,000 counts on the invoice that bills it
    expect(by.get(ids.inv4)).toMatchObject({ balance: 15000, days_overdue: 2 });
    expect(by.get(ids.opening)).toMatchObject({
      balance: 7000,
      doc_type: "opening_balance",
      owner_id: m2.id,
    });
    // the invoice on a deal names no contact: the deal's contact is there for the reminder
    expect(by.get(ids.invDeal)).toMatchObject({ balance: 6000, deal_contact_id: c1 });
    expect(m.debts).toMatchObject({ count: 4, amount: 34000 });
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
    // debts only for people who may record payments (owner, answer (4) ב)
    expect(await money(viewer)).toMatchObject({ quotes: all.quotes, debts: null, renewals: all.renewals });
    await setVisibility("own");
    try {
      const m = await money(m1);
      // qP: the owner's quote on m1's deal follows the deal
      expect(sorted(m.quotes!.rows)).toEqual([ids.qA, ids.qR, ids.qP].sort());
      expect(m.debts).toBeNull();
      expect(sorted(m.renewals.rows)).toEqual([ids.rWon]);
      const v = await money(viewer);
      expect(v.quotes).toMatchObject({ count: 0, amount: 0, rows: [] });
      expect(v.debts).toBeNull();
      expect(v.renewals).toMatchObject({ count: 0, amount: 0, rows: [] });
    } finally {
      await setVisibility("org");
    }
  });

  it("debts only for people who may record payments: a member gets them with the record_payments permission", async () => {
    expect((await money(m1)).debts).toBeNull();
    await setOverrides({ quotes: true, documents: true, payments: true, granular_permissions: true });
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, m1.id]));
    try {
      const m = await money(m1);
      expect(m.debts).not.toBeNull();
      expect(sorted(m.debts!.rows)).toEqual(sorted((await money(owner)).debts!.rows));
      expect((await money(m2)).debts).toBeNull();
    } finally {
      await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{}')", [org, m1.id]));
      await setOverrides({ quotes: true, documents: true, payments: true });
    }
  });

  it("the VAT mode: a business that charges VAT converts, an exempt one shows amounts as they are, an unset status before VAT", async () => {
    const setStatus = (status: string | null) =>
      asUser(owner.id, (q) => q("update public.org_document_settings set vat_status = $2 where organization_id = $1", [org, status]));
    const charging = await money(owner);
    const rate = charging.vat.rate_bp!;
    try {
      await setStatus("exempt");
      const exempt = await money(owner);
      expect(exempt.vat).toEqual({ mode: "none", rate_bp: 0 });
      expect((exempt.deals.find((d) => d.id === ids.dS) as unknown as { amount_agorot: number }).amount_agorot).toBe(50000);
      expect(exempt.renewals.rows.find((r) => r.id === ids.rWon)!.amount_agorot).toBe(5000);
      // a quote keeps the total stored when it was sent
      expect(exempt.quotes!.rows.find((r) => r.id === ids.qA)!.amount_agorot).toBe(withVat(10000, rate));

      await setStatus(null);
      const unknown = await money(owner);
      expect(unknown.vat).toEqual({ mode: "unknown", rate_bp: null });
      expect((unknown.deals.find((d) => d.id === ids.dS) as unknown as { amount_agorot: number }).amount_agorot).toBe(50000);
      expect(unknown.renewals.rows.find((r) => r.id === ids.rWon)!.amount_agorot).toBe(5000);
      // before VAT, as the rest: the quote's net
      expect(unknown.quotes!.rows.find((r) => r.id === ids.qA)!.amount_agorot).toBe(10000);
      // debts are documents' balances, with VAT whatever the mode
      expect(unknown.debts!.amount).toBe(charging.debts!.amount);
    } finally {
      await setStatus("licensed");
    }
    expect(charging.vat).toEqual({ mode: "included", rate_bp: rate });
    expect(charging.renewals.rows.find((r) => r.id === ids.rWon)!.amount_agorot).toBe(withVat(5000, rate));
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
      expect(m.stuck.deals).toBe(c.stuck.deals);
      expect(m.overdue.deals).toBe(c.overdue.deals);
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

// Review finding 1: the debts group narrows to documents that can still have a balance before money_allocation_state
// (whose cost grows with documents x allocations), so thousands of paid overdue invoices stay fast.
describe("money waiting: many paid overdue invoices (MNY-01 review)", () => {
  let owner: { id: string; email: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("mw-bulk-owner");
    org = await createOrg(owner.id, "עסק החשבוניות");
    const contact = await asUser(
      owner.id,
      async (q) =>
        (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, owner.id]))
          .rows[0].id,
    );
    // fixture rows in bulk: triggers set aside (as server data), every invoice due 10 days ago
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date, status)
         select $1, $2, 'tax_invoice', 'B-' || g, current_date - 40, 1000, current_date - 10, 'active' from generate_series(1, 3005) g`,
        [org, contact],
      );
      await q(
        `insert into public.payments (organization_id, contact_id, amount_agorot, method, status)
         select $1, $2, 1000, 'transfer', 'confirmed' from generate_series(1, 3000)`,
        [org, contact],
      );
      await q(
        `insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
         select $1, p.id, d.id, 1000
           from (select id, row_number() over (order by id) as n from public.payments where organization_id = $1) p
           join (select id, row_number() over (order by id) as n from public.accounting_documents where organization_id = $1) d on d.n = p.n`,
        [org],
      );
    });
  });

  it("3,000 paid and 5 open overdue invoices: the 5 counted, well within the statement timeout", async () => {
    const started = Date.now();
    const m = await asUser(owner.id, async (q) => (await q<{ r: Money }>("select public.report_money_waiting($1) as r", [org])).rows[0].r);
    const took = Date.now() - started;
    expect(m.debts).toMatchObject({ count: 5, amount: 5000 });
    expect(took).toBeLessThan(2000);
  });
});
