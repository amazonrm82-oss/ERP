import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commitmentEnd, monthlyAmount, nextCycleDate } from "../../src/features/recurring-billing/schedule";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * SUB-01..SUB-05: a customer's recurring billing (lines from the catalog, cycle, start, billing day, end, commitment), its
 * statuses (pause, resume, cancel with a reason, failed by the server only), the price change from the next cycle with its
 * history, the job that makes each due cycle with a task for the rep (method A, no document provider), the document link of
 * a cycle, one click from a won deal, the report, and what merge, erasure, sample data and import undo know.
 */
describe("recurring billing (SUB-01..SUB-05)", () => {
  let owner: U, member: U, manager: U;
  let org: string;
  let contact: string;
  let zone: string;
  const FEATURES = { recurring_billing: true, products: true, documents: true, payments: true, discounts: true, orders: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: zone });
  const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const billing = (u: U, values: Record<string, unknown> = {}) =>
    run(u, async (q) => {
      const v = { contact_id: contact, name: "ריטיינר חודשי", cycle: "monthly", start_date: today(), billing_day: 5, ...values };
      return (
        await one<{ id: string }>(
          q,
          "insert into public.recurring_billings (organization_id, contact_id, company_id, name, cycle, start_date, billing_day, end_date, commitment_months) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
          [org, v.contact_id, (v as Record<string, unknown>).company_id ?? null, v.name, v.cycle, v.start_date, v.billing_day, (v as Record<string, unknown>).end_date ?? null, (v as Record<string, unknown>).commitment_months ?? 0],
        )
      ).id;
    });
  const read = (id: string) =>
    asAdmin(async (q) => one<{ status: string; next_cycle_on: string | null; amount_agorot: string; cancel_reason: string | null }>(
      q,
      "select status, to_char(next_cycle_on, 'YYYY-MM-DD') as next_cycle_on, amount_agorot, cancel_reason from public.recurring_billings where id = $1",
      [id],
    ));
  const events = (id: string) =>
    asAdmin(async (q) => (await q<{ kind: string }>("select kind from public.recurring_billing_events where billing_id = $1 order by created_at, kind", [id])).rows.map((r) => r.kind));
  // the job's server write of the next cycle date (only the job and the line recompute set it)
  const dueToday = (id: string) =>
    asAdmin(async (q) => {
      await q("select set_config('app.recurring_billing_server', $1, true)", [org]);
      await q("update public.recurring_billings set next_cycle_on = $2 where id = $1", [id, today()]);
    });

  beforeAll(async () => {
    // a zone where the business's day has passed 08:00 and is not near midnight, so the job runs today
    const zones = ["Asia/Jerusalem", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Auckland"];
    zone = zones.find((z) => {
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", hour12: false }).format(new Date()));
      return hour >= 9 && hour <= 22;
    })!;
    owner = await createUser("rb-owner");
    org = await createOrg(owner.id, "עסק המנויים");
    member = await addMember(org, owner.id, "member", "rb-member");
    manager = await addMember(org, owner.id, "manager", "rb-manager");
    await asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]);
      await q("update public.organizations set timezone = $2 where id = $1", [org, zone]);
    });
    contact = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'מנוי', $2) returning id", [org, member.id])).id);
  });

  it("the plan key is on from pro up only, and a business without it cannot make one", async () => {
    const plans = await asAdmin(async (q) =>
      Object.fromEntries((await q<{ key: string; f: boolean | null }>("select key, (features ->> 'recurring_billing')::boolean as f from public.plans")).rows.map((r) => [r.key, r.f])),
    );
    expect(plans).toMatchObject({ personal: false, basic: false, pro: true, business: true });
    expect(await asAdmin(async (q) => (await one<{ d: boolean }>(q, "select (app.plan_key_defaults() -> 'features' ->> 'recurring_billing')::boolean as d")).d)).toBe(false);
    const other = await createUser("rb-other");
    const otherOrg = await createOrg(other.id, "עסק בלי");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"recurring_billing\": false}' where organization_id = $1", [otherOrg]));
    const c = await asUser(other.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'x') returning id", [otherOrg])).id);
    const err = await pgError(
      asUser(other.id, (q) => q("insert into public.recurring_billings (organization_id, contact_id, name, cycle, start_date, billing_day) values ($1, $2, 'x', 'monthly', current_date, 1)", [otherOrg, c])),
    );
    expect(err.hint).toBe("feature:recurring_billing");
  });

  it("the schedule mirrors nextCycleDate()", async () => {
    const cases: [string, string, number, string][] = [
      ["2026-01-15", "monthly", 10, "2026-01-15"],
      ["2026-01-15", "monthly", 20, "2026-01-01"],
      ["2026-01-15", "quarterly", 20, "2026-03-01"],
      ["2026-01-15", "quarterly", 10, "2026-01-20"],
      ["2026-11-30", "yearly", 28, "2027-02-01"],
      ["2026-02-28", "monthly", 28, "2026-12-29"],
      ["2025-12-31", "yearly", 1, "2026-01-01"],
      // owner (354) ב: 0 = the month's last day, February in a leap year and not, months of 30 and 31
      ["2026-01-31", "monthly", 0, "2026-02-01"],
      ["2028-01-15", "monthly", 0, "2028-02-01"],
      ["2027-12-10", "monthly", 0, "2028-02-29"],
      ["2026-01-01", "monthly", 0, "2026-04-15"],
      ["2026-01-05", "quarterly", 0, "2026-02-01"],
      ["2024-02-29", "yearly", 0, "2025-01-01"],
      ["2023-02-28", "yearly", 0, "2024-01-01"],
    ];
    for (const [start, cycle, day, from] of cases) {
      const sql = await asAdmin(async (q) =>
        (await one<{ d: string }>(q, "select to_char(app.recurring_next_cycle($1, $2, $3, $4), 'YYYY-MM-DD') as d", [start, cycle, day, from])).d,
      );
      expect(sql, `${start} ${cycle} ${day} ${from}`).toBe(nextCycleDate(start, cycle as "monthly", day, from));
    }
    for (const [amount, cycle] of [[1000, "monthly"], [1000, "quarterly"], [1001, "quarterly"], [1006, "yearly"]] as const) {
      const sql = await asAdmin(async (q) => Number((await one<{ m: string }>(q, "select app.recurring_monthly_amount($1, $2) as m", [amount, cycle])).m));
      expect(sql).toBe(monthlyAmount(amount, cycle));
    }
  });

  it("is made by those who record payments, on a customer they read, with the next cycle set by the server", async () => {
    expect((await pgError(billing(member))).code).toBe("42501");
    const id = await billing(manager, { start_date: addDays(today(), -40), billing_day: 1 });
    const row = await read(id);
    expect(row.status).toBe("active");
    expect(row.next_cycle_on).toBe(nextCycleDate(addDays(today(), -40), "monthly", 1, today()));
    // the member reads it (the contact is theirs), but does not change it
    expect(await run(member, (q) => count(q, "select 1 from public.recurring_billings where id = $1", [id]))).toBe(1);
    expect(await run(member, async (q) => (await q("update public.recurring_billings set name = 'x' where id = $1", [id])).rowCount)).toBe(0);
    // the server's columns are not the person's
    expect((await pgError(run(owner, (q) => q("update public.recurring_billings set next_cycle_on = current_date where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("update public.recurring_billings set cycle = 'yearly' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("delete from public.recurring_billings where id = $1", [id])))).code).toBe("42501");
    expect(await events(id)).toEqual(["created"]);
  });

  it("lines price the cycle; a change after a cycle is recorded and applies from the next cycle", async () => {
    const id = await billing(owner);
    const product = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat) values ($1, 'שעת ייעוץ', 20000, 'taxable', false) returning id", [org])).id,
    );
    await run(owner, (q) =>
      q("insert into public.recurring_billing_lines (organization_id, billing_id, product_id, description, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'שעת ייעוץ', 3, 20000, 'product')", [org, id, product]),
    );
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'דמי ניהול', 5000)", [org, id]));
    expect(Number((await read(id)).amount_agorot)).toBe(65000);
    // a list price must name its list
    expect(
      (await pgError(run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, product_id, description, price_source) values ($1, $2, $3, 'x', 'price_list')", [org, id, product])))).hint,
    ).toBe("recurring_billing_lines:price_list");
    await dueToday(id);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.run_recurring_billings($1) as n", [[org]])).n)).toBeGreaterThanOrEqual(1);
    const cycles = await asAdmin(async (q) => (await q<{ net_agorot: string; task_id: string | null; cycle_on: string }>("select net_agorot, task_id, to_char(cycle_on, 'YYYY-MM-DD') as cycle_on from public.recurring_billing_cycles where billing_id = $1", [id])).rows);
    expect(cycles).toHaveLength(1);
    expect(Number(cycles[0].net_agorot)).toBe(65000);
    expect(cycles[0].cycle_on).toBe(today());
    // the cycle's task goes to the rep: the contact's owner
    const task = await asAdmin(async (q) => one<{ owner_id: string; contact_id: string; status: string; title: string }>(q, "select owner_id, contact_id, status, title from public.tasks where id = $1", [cycles[0].task_id]));
    expect(task).toMatchObject({ owner_id: member.id, contact_id: contact, status: "open" });
    expect(task.title).toContain("חיוב חוזר: ריטיינר חודשי");
    // the next cycle moved on; running again makes nothing new
    expect((await read(id)).next_cycle_on).toBe(nextCycleDate(today(), "monthly", 5, addDays(today(), 1)));
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1", [id]))).toBe(1);

    // the price changes: the made cycle keeps its amount, the change is recorded
    await run(owner, (q) => q("update public.recurring_billing_lines set unit_price_agorot = 6000 where billing_id = $1 and product_id is null", [id]));
    expect(Number((await read(id)).amount_agorot)).toBe(66000);
    expect(Number(await asAdmin(async (q) => (await one<{ n: string }>(q, "select net_agorot as n from public.recurring_billing_cycles where billing_id = $1", [id])).n))).toBe(65000);
    const change = await asAdmin(async (q) =>
      one<{ old_amount_agorot: string; new_amount_agorot: string }>(q, "select old_amount_agorot, new_amount_agorot from public.recurring_billing_events where billing_id = $1 and kind = 'price_changed'", [id]),
    );
    expect([Number(change.old_amount_agorot), Number(change.new_amount_agorot)]).toEqual([65000, 66000]);

    // a recorded receipt of the customer is linked to the cycle, which closes its task
    const receipt = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'RB-1', 76440) returning id", [org, contact])).id,
    );
    const otherContact = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'אחר') returning id", [org])).id);
    const otherReceipt = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'RB-2', 100) returning id", [org, otherContact])).id,
    );
    expect((await pgError(run(owner, (q) => q("update public.recurring_billing_cycles set accounting_document_id = $2 where billing_id = $1", [id, otherReceipt])))).hint).toBe("recurring_cycle:document");
    expect((await pgError(run(owner, (q) => q("update public.recurring_billing_cycles set status = 'documented' where billing_id = $1", [id])))).hint).toBe("recurring_cycle:status");
    await run(owner, (q) => q("update public.recurring_billing_cycles set accounting_document_id = $2 where billing_id = $1", [id, receipt]));
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.recurring_billing_cycles where billing_id = $1", [id])).s)).toBe("documented");
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.tasks where id = $1", [cycles[0].task_id])).s)).toBe("done");
    // the member cannot touch a cycle
    expect(await run(member, async (q) => (await q("update public.recurring_billing_cycles set status = 'skipped' where billing_id = $1", [id])).rowCount)).toBe(0);
  });

  it("pauses and resumes, cancels with a reason, is marked failed by the server only, and a cancelled one is frozen", async () => {
    const id = await billing(owner);
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [id]));
    expect((await read(id)).status).toBe("paused");
    await dueToday(id);
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1", [id]))).toBe(0);
    await run(owner, (q) => q("update public.recurring_billings set status = 'active' where id = $1", [id]));
    expect((await read(id)).next_cycle_on).toBe(nextCycleDate(today(), "monthly", 5, today()));
    expect((await pgError(run(owner, (q) => q("update public.recurring_billings set status = 'failed' where id = $1", [id])))).hint).toBe("recurring_billing:status");
    expect((await pgError(run(owner, (q) => q("update public.recurring_billings set status = 'cancelled' where id = $1", [id])))).hint).toBe("recurring_billing:cancel_reason");
    await run(owner, (q) => q("update public.recurring_billings set status = 'cancelled', cancel_reason = 'הלקוח עבר לספק אחר' where id = $1", [id]));
    expect(await read(id)).toMatchObject({ status: "cancelled", next_cycle_on: null });
    expect((await pgError(run(owner, (q) => q("update public.recurring_billings set name = 'שוב' where id = $1", [id])))).hint).toBe("recurring_billing:cancelled");
    expect((await pgError(run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'x', 1)", [org, id])))).hint).toBe("recurring_billing:cancelled");
    expect(await events(id)).toEqual(expect.arrayContaining(["created", "paused", "resumed", "cancelled"]));
  });

  it("an end date stops the cycles", async () => {
    const id = await billing(owner, { start_date: addDays(today(), -10), billing_day: 1, end_date: addDays(today(), 1) });
    const next = nextCycleDate(addDays(today(), -10), "monthly", 1, today());
    expect((await read(id)).next_cycle_on).toBe(next !== null && next <= addDays(today(), 1) ? next : null);
  });

  it("one click from a won deal copies its lines of the deal's period", async () => {
    const deal = await run(owner, async (q) => {
      const pipe = await one<{ p: string; won: string; open: string }>(
        q,
        "select p.id as p, (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'won' limit 1) as won, (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'open' order by s.position limit 1) as open from public.pipelines p where p.organization_id = $1 and p.is_default",
        [org],
      );
      const d = await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'שירות שנתי', $2, $3, $4) returning id", [org, pipe.p, pipe.open, contact]);
      await q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, billing) values ($1, $2, 'תחזוקה', 10000, 'monthly')", [org, d.id]);
      await q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, billing) values ($1, $2, 'הקמה', 50000, 'one_time')", [org, d.id]);
      return { id: d.id, won: pipe.won };
    });
    expect((await pgError(run(owner, (q) => q("select public.recurring_billing_from_deal($1, $2)", [org, deal.id])))).hint).toBe("recurring_billing:deal_not_won");
    await run(owner, (q) => q("update public.deals set stage_id = $2 where id = $1", [deal.id, deal.won]));
    const made = await run(owner, async (q) => (await one<{ r: { id: string; copied: number; other_period: number } }>(q, "select public.recurring_billing_from_deal($1, $2) as r", [org, deal.id])).r);
    expect(made).toMatchObject({ copied: 1, other_period: 1 });
    expect(Number((await read(made.id)).amount_agorot)).toBe(10000);
    expect((await pgError(run(owner, (q) => q("select public.recurring_billing_from_deal($1, $2)", [org, deal.id])))).hint).toBe("recurring_billing:deal_exists");
    expect((await pgError(run(member, (q) => q("select public.recurring_billing_from_deal($1, $2)", [org, deal.id])))).code).toBe("42501");
  });

  it("the report counts MRR of the live billings, new customers and next month", async () => {
    const r = await run(owner, async (q) =>
      (await one<{ r: { allowed: boolean; totals: { mrr: number; active_billings: number }; by_month: { month: string; new_customers: number }[] } }>(
        q,
        "select public.report_recurring_billing($1, $2, $3) as r",
        [org, addDays(today(), -60), today()],
      )).r,
    );
    expect(r.allowed).toBe(true);
    expect((r as unknown as { partial: boolean }).partial).toBe(false);
    // owner (357) ג: with VAT never below before VAT; (356) ב: a manager by role opens it, a member does not
    expect((r.totals as unknown as { mrr_with_vat: number }).mrr_with_vat).toBeGreaterThanOrEqual(r.totals.mrr);
    expect(await run(manager, async (q) => (await one<{ r: { allowed: boolean; partial: boolean } }>(q, "select public.report_recurring_billing($1, $2, $3) as r", [org, today(), today()])).r)).toMatchObject({ allowed: true, partial: false });
    await run(manager, (q) => q("select public.log_export($1, 'report', 'recurring_billing', 3)", [org]));
    const live = await asAdmin(async (q) =>
      Number((await one<{ m: string }>(q, "select coalesce(sum(app.recurring_monthly_amount(amount_agorot, cycle)), 0) as m from public.recurring_billings where organization_id = $1 and status = 'active' and (end_date is null or end_date >= $2)", [org, today()])).m),
    );
    expect(r.totals.mrr).toBe(live);
    expect(r.by_month.reduce((s, m) => s + m.new_customers, 0)).toBe(1);
    expect(await run(member, async (q) => (await one<{ r: { allowed: boolean } }>(q, "select public.report_recurring_billing($1, $2, $3) as r", [org, today(), today()])).r.allowed)).toBe(false);
    // review M3: a manager who does not read every billing (own visibility; the owner's contact with no team) gets counts
    // without totals
    const ownersOwn = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'של הבעלים', $2) returning id", [org, owner.id])).id);
    await asAdmin((q) => q("update public.contacts set team_id = null where id = $1", [ownersOwn]));
    await billing(owner, { contact_id: ownersOwn });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const m = await run(manager, async (q) => (await one<{ r: { allowed: boolean; partial: boolean; totals: unknown; by_month: { new_mrr: number | null }[] } }>(q, "select public.report_recurring_billing($1, $2, $3) as r", [org, addDays(today(), -60), today()])).r);
      expect(m).toMatchObject({ allowed: true, partial: true, totals: null });
      expect(m.by_month.every((x) => x.new_mrr === null)).toBe(true);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    await run(owner, (q) => q("select public.log_export($1, 'report', 'recurring_billing', 3)", [org]));
    expect((await pgError(run(member, (q) => q("select public.log_export($1, 'report', 'recurring_billing', 3)", [org])))).code).toBe("42501");
  });

  it("takes the business's VAT mode when the insert names none (review M1)", async () => {
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, prices_include_vat) values ($1, true) on conflict (organization_id) do update set prices_include_vat = true", [org]),
    );
    const id = await billing(owner);
    expect(await asAdmin(async (q) => (await one<{ v: boolean }>(q, "select prices_include_vat as v from public.recurring_billings where id = $1", [id])).v)).toBe(true);
    await asAdmin((q) => q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org]));
    const net = await billing(owner);
    expect(await asAdmin(async (q) => (await one<{ v: boolean }>(q, "select prices_include_vat as v from public.recurring_billings where id = $1", [net])).v)).toBe(false);
  });

  it("a deal must be of the billing's own customer and readable by the person; one answer for every refusal (review M2)", async () => {
    const pipe = await asAdmin(async (q) =>
      one<{ p: string; s: string }>(q, "select p.id as p, (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'open' order by s.position limit 1) as s from public.pipelines p where p.organization_id = $1 and p.is_default", [org]),
    );
    const company = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברת מנויים') returning id", [org])).id);
    const worker = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'עובד', $2) returning id", [org, company])).id);
    const other = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [org])).id);
    const deal = (contactId: string | null, companyId: string | null) =>
      run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5, $6) returning id", [org, pipe.p, pipe.s, contactId, companyId, owner.id])).id,
      );
    const withDeal = (u: U, d: string, customer: { contact_id?: string | null; company_id?: string | null }) =>
      run(u, (q) =>
        q("insert into public.recurring_billings (organization_id, contact_id, company_id, deal_id, name, cycle, start_date, billing_day) values ($1, $2, $3, $4, 'x', 'monthly', current_date, 1)", [org, customer.contact_id ?? null, customer.company_id ?? null, d]),
      );
    const otherDeal = await deal(other, null);
    const companyDeal = await deal(null, company);
    const workerDeal = await deal(worker, company);
    // another contact's deal, a company's deal for a contact of another company, and a deal with no customer: refused
    expect((await pgError(withDeal(owner, otherDeal, { contact_id: contact }))).hint).toBe("recurring_billing:deal");
    expect((await pgError(withDeal(owner, companyDeal, { contact_id: contact }))).hint).toBe("recurring_billing:deal");
    expect((await pgError(withDeal(owner, await deal(null, null), { contact_id: contact }))).hint).toBe("recurring_billing:deal");
    // a company billing on a contact's deal of another company, and the contact's deal for the company billing (deal's company set)
    expect((await pgError(withDeal(owner, otherDeal, { company_id: company }))).hint).toBe("recurring_billing:deal");
    await withDeal(owner, workerDeal, { company_id: company });
    // a contact's billing on a deal with no contact of the contact's company; a deal of that contact
    await withDeal(owner, companyDeal, { contact_id: worker });
    await withDeal(owner, await deal(worker, null), { contact_id: worker });
    // a deal the manager cannot read (own visibility, the owner's) answers like one that does not exist
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const ownContact = await run(manager, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'של מנהל', $2) returning id", [org, manager.id])).id);
      // the owner's deal of the manager's own contact: the manager does not read it
      const hidden = await deal(ownContact, null);
      expect(await run(manager, (q) => count(q, "select 1 from public.deals where id = $1", [hidden]))).toBe(0);
      expect((await pgError(withDeal(manager, hidden, { contact_id: ownContact }))).hint).toBe("recurring_billing:deal");
      expect((await pgError(withDeal(manager, "00000000-0000-4000-8000-000000000001", { contact_id: ownContact }))).hint).toBe("recurring_billing:deal");
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a gap makes no backlog, a billing with no lines makes no cycle, and failures clear (review L1-L3)", async () => {
    const id = await billing(owner, { start_date: addDays(today(), -100), billing_day: 1 });
    // no lines: nothing made, one event
    await dueToday(id);
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    await dueToday(id);
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1", [id]))).toBe(0);
    expect((await events(id)).filter((k) => k === "no_lines")).toHaveLength(1);
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'ריטיינר', 1000)", [org, id]));
    // a cycle date three months ago: one event counts the missed dates, the billing goes on from today
    await asAdmin(async (q) => {
      await q("select set_config('app.recurring_billing_server', $1, true)", [org]);
      await q("update public.recurring_billings set next_cycle_on = $2 where id = $1", [id, nextCycleDate(addDays(today(), -100), "monthly", 1, addDays(today(), -95))]);
      await q("insert into app.recurring_billing_failures (organization_id, billing_id, cycle_on, failures) values ($1, $2, current_date - 400, 2)", [org, id]);
    });
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    const skipped = await asAdmin(async (q) => (await q<{ n: number }>("select skipped_cycles as n from public.recurring_billing_events where billing_id = $1 and kind = 'cycles_skipped'", [id])).rows);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].n).toBeGreaterThanOrEqual(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1 and cycle_on < $2", [id, today()]))).toBe(0);
    expect((await read(id)).next_cycle_on! >= today()).toBe(true);
    // a resume clears the failure count
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [id]));
    await run(owner, (q) => q("update public.recurring_billings set status = 'active' where id = $1", [id]));
    expect(await asAdmin((q) => count(q, "select 1 from app.recurring_billing_failures where billing_id = $1 and failures > 0", [id]))).toBe(0);
  });

  it("one document per cycle, of the billing's own customer; back to waiting reopens the task (review L4)", async () => {
    const id = await billing(owner);
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, id]));
    await dueToday(id);
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    const cycle = await asAdmin(async (q) => one<{ id: string; task_id: string }>(q, "select id, task_id from public.recurring_billing_cycles where billing_id = $1", [id]));
    const doc = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', $3, 1000) returning id", [org, contact, `RB-L4-${id.slice(0, 6)}`])).id,
    );
    const used = await asAdmin(async (q) => (await one<{ id: string | null }>(q, "select accounting_document_id as id from public.recurring_billing_cycles where accounting_document_id is not null and organization_id = $1 limit 1", [org])).id);
    if (used) expect((await pgError(run(owner, (q) => q("update public.recurring_billing_cycles set accounting_document_id = $2 where id = $1", [cycle.id, used])))).hint).toBe("recurring_cycle:document_used");
    await run(owner, (q) => q("update public.recurring_billing_cycles set status = 'skipped' where id = $1", [cycle.id]));
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.tasks where id = $1", [cycle.task_id])).s)).toBe("done");
    await run(owner, (q) => q("update public.recurring_billing_cycles set status = 'due' where id = $1", [cycle.id]));
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.tasks where id = $1", [cycle.task_id])).s)).toBe("open");
    await run(owner, (q) => q("update public.recurring_billing_cycles set accounting_document_id = $2 where id = $1", [cycle.id, doc]));
  });

  it("without the key a recorder only pauses or cancels (review L7)", async () => {
    const id = await billing(owner);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"recurring_billing\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(run(owner, (q) => q("update public.recurring_billings set name = 'שם חדש' where id = $1", [id])))).hint).toBe("feature:recurring_billing");
      await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [id]));
      expect((await pgError(run(owner, (q) => q("update public.recurring_billings set status = 'active' where id = $1", [id])))).hint).toBe("feature:recurring_billing");
      await run(owner, (q) => q("update public.recurring_billings set status = 'cancelled', cancel_reason = 'החבילה ירדה' where id = $1", [id]));
      expect((await read(id)).status).toBe("cancelled");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
  });

  it("each due cycle makes a draft order for the rep while the orders module is on (owner (352) ב)", async () => {
    const id = await billing(owner);
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, quantity, unit_price_agorot) values ($1, $2, 'ריטיינר חודשי', 2, 30000)", [org, id]));
    // module off: a task only
    await dueToday(id);
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin(async (q) => (await one<{ o: string | null }>(q, "select order_id as o from public.recurring_billing_cycles where billing_id = $1", [id])).o)).toBeNull();
    // module on: a draft order of the cycle's lines, owned by the rep, linked to the cycle
    await run(owner, (q) => q("insert into public.org_modules (organization_id, orders_enabled) values ($1, true) on conflict (organization_id) do update set orders_enabled = true", [org]));
    try {
      await asAdmin(async (q) => {
        await q("select set_config('app.recurring_billing_server', $1, true)", [org]);
        await q("update public.recurring_billing_cycles set cycle_on = cycle_on - 40, period_end = period_end - 40 where billing_id = $1", [id]);
        await q("update public.recurring_billings set next_cycle_on = $2 where id = $1", [id, today()]);
      });
      await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
      const cycle = await asAdmin(async (q) => one<{ order_id: string; task_id: string }>(q, "select order_id, task_id from public.recurring_billing_cycles where billing_id = $1 and cycle_on = $2", [id, today()]));
      expect(cycle.order_id).toBeTruthy();
      const order = await asAdmin(async (q) =>
        one<{ status: string; contact_id: string; owner_id: string; source: string; lines: number; total: string }>(
          q,
          "select o.status, o.contact_id, o.owner_id, o.source, (select count(*)::int from public.order_lines l where l.order_id = o.id) as lines, o.subtotal_agorot as total from public.orders o where o.id = $1",
          [cycle.order_id],
        ),
      );
      expect(order).toMatchObject({ status: "draft", contact_id: contact, owner_id: member.id, source: "manual", lines: 1 });
      expect(Number(order.total)).toBe(60000);
      // the rep reads the draft order (it follows the contact)
      expect(await run(member, (q) => count(q, "select 1 from public.orders where id = $1", [cycle.order_id]))).toBe(1);
    } finally {
      await run(owner, (q) => q("update public.org_modules set orders_enabled = false where organization_id = $1", [org]));
    }
  });

  it("a resume asks whether to make up the missed cycles, from the first missed date, and the choice is recorded (owner (353) ג)", async () => {
    const start = addDays(today(), -100);
    const first = nextCycleDate(start, "monthly", 1, start)!;
    const makeUp = await billing(owner, { start_date: start, billing_day: 1 });
    const goOn = await billing(owner, { start_date: start, billing_day: 1 });
    for (const id of [makeUp, goOn]) {
      await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, id]));
      // as if made 100 days ago and paused before its first cycle (the pause keeps that first missed date)
      await asAdmin(async (q) => {
        // triggers off: app.touch_row keeps created_at for every writer
        await q("set local session_replication_role = replica");
        await q("update public.recurring_billings set created_at = now() - interval '100 days', next_cycle_on = $2 where id = $1", [id, first]);
      });
      await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [id]));
    }
    expect(await run(owner, async (q) => (await one<{ r: boolean }>(q, "select public.recurring_billing_resume($1, $2, true) as r", [org, makeUp])).r)).toBe(true);
    expect(await run(owner, async (q) => (await one<{ r: boolean }>(q, "select public.recurring_billing_resume($1, $2, false) as r", [org, goOn])).r)).toBe(true);
    expect((await read(makeUp)).next_cycle_on).toBe(first);
    expect((await read(goOn)).next_cycle_on).toBe(nextCycleDate(start, "monthly", 1, today()));
    // a schedule change waits for the make-up (delta review L-a)
    expect((await pgError(run(owner, (q) => q("update public.recurring_billings set billing_day = 5 where id = $1", [makeUp])))).hint).toBe("recurring_billing:make_up_pending");
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    // every billing date from the first missed one up to today is made for the one that makes up
    let expected = 0;
    for (let d: string | null = first; d !== null && d <= today(); d = nextCycleDate(start, "monthly", 1, addDays(d, 1))) expected++;
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1", [makeUp]))).toBe(expected);
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1 and cycle_on < $2", [goOn, today()]))).toBe(0);
    expect(await asAdmin(async (q) => (await one<{ m: boolean }>(q, "select make_up as m from public.recurring_billing_events where billing_id = $1 and kind = 'resumed'", [makeUp])).m)).toBe(true);
    expect(await asAdmin(async (q) => (await one<{ m: boolean }>(q, "select make_up as m from public.recurring_billing_events where billing_id = $1 and kind = 'resumed'", [goOn])).m)).toBe(false);
    expect(await asAdmin(async (q) => (await one<{ u: string | null }>(q, "select make_up_until as u from public.recurring_billings where id = $1", [makeUp])).u)).toBeNull();
    // once done, the schedule may change again, and the event shows the new next date
    await run(owner, (q) => q("update public.recurring_billings set billing_day = 5 where id = $1", [makeUp]));
    const changed = await asAdmin(async (q) => (await one<{ e: string }>(q, "select to_char(effective_on, 'YYYY-MM-DD') as e from public.recurring_billing_events where billing_id = $1 and kind = 'day_changed'", [makeUp])).e);
    expect(changed).toBe((await read(makeUp)).next_cycle_on);
    // the member does not resume
    expect(await run(member, async (q) => (await one<{ r: boolean }>(q, "select public.recurring_billing_resume($1, $2, false) as r", [org, makeUp])).r)).toBe(false);
  });

  it("a back-dated billing made today makes up nothing before the day it was made, and at most 24 cycles (delta review MED-1)", async () => {
    const backDated = await billing(owner, { start_date: addDays(today(), -400), billing_day: 1 });
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, backDated]));
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [backDated]));
    await run(owner, (q) => q("select public.recurring_billing_resume($1, $2, true)", [org, backDated]));
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1 and cycle_on < $2", [backDated, today()]))).toBe(0);
    // a monthly billing made 3 years ago and paused since its first cycle: only the last 24 are made
    const old = await billing(owner, { start_date: addDays(today(), -1100), billing_day: 1 });
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, old]));
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.recurring_billings set created_at = now() - interval '1100 days', next_cycle_on = $2 where id = $1", [old, nextCycleDate(addDays(today(), -1100), "monthly", 1, addDays(today(), -1100))]);
    });
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [old]));
    await run(owner, (q) => q("select public.recurring_billing_resume($1, $2, true)", [org, old]));
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1", [old]))).toBe(24);
  });

  it("a cycle that failed is tried again, not skipped as a gap (delta review L-b)", async () => {
    const id = await billing(owner);
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, id]));
    const yesterday = addDays(today(), -1);
    await asAdmin(async (q) => {
      await q("select set_config('app.recurring_billing_server', $1, true)", [org]);
      await q("update public.recurring_billings set next_cycle_on = $2 where id = $1", [id, yesterday]);
      await q("insert into app.recurring_billing_failures (organization_id, billing_id, cycle_on, failures, last_attempt_at) values ($1, $2, $3, 1, now() - interval '1 day')", [org, id, yesterday]);
    });
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1 and cycle_on = $2", [id, yesterday]))).toBe(1);
    expect(await events(id)).not.toContain("cycles_skipped");
  });

  it("a failed gap-skip and a retry after a gap never make the missed cycles (delta review 2, MED 1)", async () => {
    const start = addDays(today(), -100);
    // the billing day is today's, so the skip-to-today cycle is due now (the last day: 0; the 29th or 30th of a longer
    // month cannot be a billing day, and then part (a) has no cycle to fail)
    const dom = Number(today().slice(8, 10));
    const lastDay = addDays(today(), 1).slice(8, 10) === "01";
    const bday = dom <= 28 ? dom : lastDay ? 0 : 1;
    const old = nextCycleDate(start, "monthly", bday, start)!;
    // (a) a gap whose skip-to-today cycle fails: the failure is kept under the date tried, the next run skips the gap again
    const gap = await billing(owner, { start_date: start, billing_day: bday });
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, gap]));
    await asAdmin(async (q) => {
      await q("select set_config('app.recurring_billing_server', $1, true)", [org]);
      await q("update public.recurring_billings set next_cycle_on = $2 where id = $1", [gap, old]);
    });
    const tried = nextCycleDate(start, "monthly", bday, today())!;
    const failOnce = async () =>
      asAdmin(async (q) => {
        // a cycle insert of this billing fails for this one transaction only (the trigger is gone when it ends)
        await q(`create function pg_temp.rb_fail() returns trigger language plpgsql as $f$ begin if new.billing_id = '${gap}' then raise exception 'boom'; end if; return new; end $f$`);
        await q("create trigger rb_fail before insert on public.recurring_billing_cycles for each row execute function pg_temp.rb_fail()");
        await q("select app.run_recurring_billings($1)", [[org]]);
        await q("drop trigger rb_fail on public.recurring_billing_cycles");
      });
    if (tried <= today()) {
      await failOnce();
      const failures = await asAdmin(async (q) => (await q<{ d: string; n: number }>("select to_char(cycle_on, 'YYYY-MM-DD') as d, failures as n from app.recurring_billing_failures where billing_id = $1", [gap])).rows);
      expect(failures).toEqual([{ d: tried, n: 1 }]);
      expect((await read(gap)).next_cycle_on).toBe(old);
    }
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.recurring_billing_cycles where billing_id = $1 and cycle_on < $2", [gap, today()]))).toBe(0);
    expect(await events(gap)).toContain("cycles_skipped");
    expect((await read(gap)).next_cycle_on! >= today()).toBe(true);

    // (b) an old cycle that failed, then a gap (the business could not write): only that one cycle is tried again
    const retry = await billing(owner, { start_date: start, billing_day: bday });
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, retry]));
    await asAdmin(async (q) => {
      await q("select set_config('app.recurring_billing_server', $1, true)", [org]);
      await q("update public.recurring_billings set next_cycle_on = $2 where id = $1", [retry, old]);
      await q("insert into app.recurring_billing_failures (organization_id, billing_id, cycle_on, failures, last_attempt_at) values ($1, $2, $3, 1, now() - interval '90 days')", [org, retry, old]);
    });
    await asAdmin((q) => q("select app.run_recurring_billings($1)", [[org]]));
    const made = await asAdmin(async (q) => (await q<{ d: string }>("select to_char(cycle_on, 'YYYY-MM-DD') as d from public.recurring_billing_cycles where billing_id = $1 and cycle_on < $2", [retry, today()])).rows.map((r) => r.d));
    expect(made).toEqual([old]);
    expect(await events(retry)).toContain("cycles_skipped");
    expect((await read(retry)).next_cycle_on! >= today()).toBe(true);
  });

  it("a make-up resume with nothing missed, or no next cycle, leaves no schedule lock; a pause ends a pending make-up (delta review 2, MED 2 and L)", async () => {
    const mark = (id: string) =>
      asAdmin(async (q) => (await one<{ u: string | null }>(q, "select to_char(make_up_until, 'YYYY-MM-DD') as u from public.recurring_billings where id = $1", [id])).u);
    // (a) nothing missed: the next cycle is after today
    const day = (Number(today().slice(8, 10)) % 28) + 1;
    const ahead = await billing(owner, { billing_day: day });
    expect((await read(ahead)).next_cycle_on! > today()).toBe(true);
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [ahead]));
    await run(owner, (q) => q("select public.recurring_billing_resume($1, $2, true)", [org, ahead]));
    expect(await mark(ahead)).toBeNull();
    // the person's choice is still recorded on the resume
    expect(await asAdmin(async (q) => (await one<{ m: boolean }>(q, "select make_up as m from public.recurring_billing_events where billing_id = $1 and kind = 'resumed'", [ahead])).m)).toBe(true);
    await run(owner, (q) => q("update public.recurring_billings set billing_day = $2 where id = $1", [ahead, day === 28 ? 27 : day + 1]));

    // (b) the end date leaves no next cycle: a billing made 100 days ago whose first cycle falls after its end date
    const start = addDays(today(), -100);
    const end = addDays(start, 5);
    let d = 1;
    while (nextCycleDate(start, "monthly", d, start)! <= end) d++;
    const ended = await billing(owner, { start_date: start, billing_day: d, end_date: end });
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, ended]));
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.recurring_billings set created_at = now() - interval '100 days', next_cycle_on = $2 where id = $1", [ended, nextCycleDate(start, "monthly", d, start)]);
    });
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [ended]));
    await run(owner, (q) => q("select public.recurring_billing_resume($1, $2, true)", [org, ended]));
    expect((await read(ended)).next_cycle_on).toBeNull();
    expect(await mark(ended)).toBeNull();
    await run(owner, (q) => q("update public.recurring_billings set billing_day = $2 where id = $1", [ended, d === 28 ? 27 : d + 1]));

    // (c) a make-up still waiting ends with a pause, so the schedule can change again
    const waiting = await billing(owner, { start_date: start, billing_day: 1 });
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.recurring_billings set created_at = now() - interval '100 days', next_cycle_on = $2 where id = $1", [waiting, nextCycleDate(start, "monthly", 1, start)]);
    });
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [waiting]));
    await run(owner, (q) => q("select public.recurring_billing_resume($1, $2, true)", [org, waiting]));
    expect(await mark(waiting)).not.toBeNull();
    await run(owner, (q) => q("update public.recurring_billings set status = 'paused' where id = $1", [waiting]));
    expect(await mark(waiting)).toBeNull();
    await run(owner, (q) => q("update public.recurring_billings set billing_day = 5 where id = $1", [waiting]));
  });

  it("a cancel inside the commitment is allowed and recorded with its reason (owner (355) א)", async () => {
    const id = await billing(owner, { commitment_months: 12 });
    await run(owner, (q) => q("update public.recurring_billings set status = 'cancelled', cancel_reason = 'עבר דירה' where id = $1", [id]));
    const event = await asAdmin(async (q) =>
      one<{ reason: string; in_commitment: boolean; effective_on: string }>(q, "select reason, in_commitment, to_char(effective_on, 'YYYY-MM-DD') as effective_on from public.recurring_billing_events where billing_id = $1 and kind = 'cancelled'", [id]),
    );
    expect(event).toMatchObject({ reason: "עבר דירה", in_commitment: true, effective_on: commitmentEnd(today(), 12) });
    const free = await billing(owner);
    await run(owner, (q) => q("update public.recurring_billings set status = 'cancelled', cancel_reason = 'סיום' where id = $1", [free]));
    expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select in_commitment as c from public.recurring_billing_events where billing_id = $1 and kind = 'cancelled'", [free])).c)).toBe(false);
  });

  it("a merge moves the duplicate's billings; sample data and import undo count them as work", async () => {
    const dup = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'כפול') returning id", [org])).id);
    const keep = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'נשאר') returning id", [org])).id);
    const id = await billing(owner, { contact_id: dup });
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect(await asAdmin(async (q) => (await one<{ c: string }>(q, "select contact_id as c from public.recurring_billings where id = $1", [id])).c)).toBe(keep);
    expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 day', null) as w", [org, keep])).w)).toBe(true);
    expect(
      await asAdmin(async (q) => (await one<{ u: boolean }>(q, "select app.sample_untouched($1, 'contact', $2, app.sample_row($1, 'contact', $2)) as u", [org, keep])).u),
    ).toBe(false);
    // review L5: a deal merge moves the billing to the kept deal
    const pipe = await asAdmin(async (q) =>
      one<{ p: string; s: string }>(q, "select p.id as p, (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'open' order by s.position limit 1) as s from public.pipelines p where p.organization_id = $1 and p.is_default", [org]),
    );
    const [keptDeal, dupDeal] = await run(owner, async (q) => [
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'נשארת', $2, $3, $4) returning id", [org, pipe.p, pipe.s, keep])).id,
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'כפולה', $2, $3, $4) returning id", [org, pipe.p, pipe.s, keep])).id,
    ]);
    const onDeal = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.recurring_billings (organization_id, contact_id, deal_id, name, cycle, start_date, billing_day) values ($1, $2, $3, 'מהעסקה', 'monthly', current_date, 1) returning id", [org, keep, dupDeal])).id,
    );
    // deals have no merge of their own yet (app.merge_columns knows lead, contact, company): the `merged` entry such a merge
    // would write, on the kept deal, moves the billing
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, metadata, deal_id) values ($1, 'system', 'מוזג', jsonb_build_object('merged_id', $3::text), $2)", [org, keptDeal, dupDeal]),
    );
    expect(await asAdmin(async (q) => (await one<{ d: string }>(q, "select deal_id as d from public.recurring_billings where id = $1", [onDeal])).d)).toBe(keptDeal);
    // delta review L-d: merged into a deal of another customer, the billing loses the link and says so
    const stranger = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'אחר') returning id", [org])).id);
    const strangerDeal = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'של אחר', $2, $3, $4) returning id", [org, pipe.p, pipe.s, stranger])).id,
    );
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, metadata, deal_id) values ($1, 'system', 'מוזג', jsonb_build_object('merged_id', $3::text), $2)", [org, strangerDeal, keptDeal]),
    );
    expect(await asAdmin(async (q) => (await one<{ d: string | null }>(q, "select deal_id as d from public.recurring_billings where id = $1", [onDeal])).d)).toBeNull();
    expect(await events(onDeal)).toContain("deal_unlinked");
  });

  it("a contact's erasure erases the entries of its billings and their lines", async () => {
    const gone = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'יוסי') returning id", [org])).id);
    const id = await billing(owner, { contact_id: gone, name: "המנוי של יוסי" });
    await run(owner, (q) => q("insert into public.recurring_billing_lines (organization_id, billing_id, description, unit_price_agorot) values ($1, $2, 'שיעור פרטי ליוסי', 1000)", [org, id]));
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [gone]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [gone]));
    const live = () =>
      asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type in ('recurring_billings', 'recurring_billing_lines') and changes::text like '%יוסי%'", [org]));
    expect(await live()).toBeGreaterThan(0);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, gone]));
    expect(await live()).toBe(0);
  });
});
