import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { customerStatusRule } from "@/features/customer-status/status";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Case = { name: string; last: string | null; today: string; dormant: number; former: number; status: string | null };
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "../unit/fixtures/customer-status.json"), "utf8")) as { cases: Case[] };

type Summary = Record<string, unknown>;
const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

/**
 * CON-11: a contact's or company's status (active, dormant, former) by its last won deal, and the sum of its won deals.
 * Computed when read under the caller's RLS; when the caller does not read every won deal of the customer the answer is
 * partial (no status, no value), BAL-01's rule.
 */
describe("customer status and value (CON-11)", () => {
  it("app.customer_status_rule answers the shared fixture exactly as customerStatusRule()", async () => {
    await asAdmin(async (q) => {
      for (const c of fixture.cases) {
        const r = await one<{ s: string | null }>(q, "select app.customer_status_rule($1::date, $2::date, $3, $4) as s", [c.last, c.today, c.dormant, c.former]);
        expect(r.s, c.name).toBe(c.status);
        expect(customerStatusRule(c.last, c.today, c.dormant, c.former), c.name).toBe(c.status);
      }
    });
  });

  describe("the summary and the computed fields", () => {
    let owner: U, member: U, viewer: U, outsider: U;
    let org: string, pipelineId: string, openStage: string, wonStage: string, lostStage: string;
    let company: string, contactA: string, contactB: string, loner: string, nobody: string;

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const deal = (u: U, fields: { stage: string; contact?: string | null; company?: string | null; amount?: number | null; closedDaysAgo?: number; owner?: string }) =>
      asUser(u.id, async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, amount_agorot, owner_id, closed_at)
             values ($1, 'עסקה', $2, $3, $4, $5, $6, $7, $8) returning id`,
            [org, pipelineId, fields.stage, fields.contact ?? null, fields.company ?? null, fields.amount ?? null, fields.owner ?? u.id,
              fields.closedDaysAgo === undefined ? null : daysAgo(fields.closedDaysAgo)],
          )
        ).id,
      );
    const summary = (u: U, contact: string | null, company: string | null) =>
      asUser(u.id, async (q) => (await one<{ s: Summary }>(q, "select public.customer_summary($1, $2, $3) as s", [org, contact, company])).s);
    const fields = (u: U, table: "contacts" | "companies", id: string) =>
      asUser(u.id, async (q) =>
        one<{ status: string | null; value: string | null }>(
          q,
          `select public.customer_status(t) as status, public.customer_value(t)::text as value from public.${table} t where t.organization_id = $1 and t.id = $2`,
          [org, id],
        ),
      );

    beforeAll(async () => {
      owner = await createUser("con11-owner");
      org = await createOrg(owner.id, "עסק הלקוחות");
      member = await addMember(org, owner.id, "member", "con11-member");
      viewer = await addMember(org, owner.id, "viewer", "con11-viewer");
      outsider = await createUser("con11-outsider");
      await createOrg(outsider.id, "עסק אחר");
      await asAdmin((q) =>
        q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [
          org,
          JSON.stringify({ payments: true, documents: true, balances: true }),
        ]),
      );
      const pipe = await defaultPipeline(org);
      pipelineId = pipe.pipelineId;
      openStage = pipe.stages.find((s) => s.kind === "open")!.id;
      wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
      lostStage = pipe.stages.find((s) => s.kind === "lost")!.id;
      await asUser(owner.id, async (q) => {
        company = (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה') returning id", [org])).id;
        contactA = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'אבי', $2) returning id", [org, company])).id;
        contactB = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'בתיה', $2) returning id", [org, company])).id;
        loner = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לבד', $2) returning id", [org, member.id])).id;
        nobody = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לא קנה') returning id", [org])).id;
      });
      // contact A: two won deals (one without a company), one open, one lost, one won in the bin
      await deal(owner, { stage: wonStage, contact: contactA, company, amount: 100_000, closedDaysAgo: 400 });
      await deal(owner, { stage: wonStage, contact: contactA, amount: 50_000, closedDaysAgo: 250 });
      await deal(owner, { stage: openStage, contact: contactA, amount: 999_999 });
      await deal(owner, { stage: lostStage, contact: contactA, amount: 999_999, closedDaysAgo: 5 });
      const binned = await deal(owner, { stage: wonStage, contact: contactA, amount: 999_999, closedDaysAgo: 1 });
      await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where organization_id = $1 and id = $2", [org, binned]));
      // contact B: a recent won deal of the company, without an amount
      await deal(owner, { stage: wonStage, contact: contactB, company, closedDaysAgo: 10 });
      // the loner: a member's own customer, and one of its won deals is the owner's
      await deal(member, { stage: wonStage, contact: loner, amount: 20_000, closedDaysAgo: 30 });
      await deal(owner, { stage: wonStage, contact: loner, amount: 30_000, closedDaysAgo: 700 });
    });

    it("a contact: status by its last won deal, value of its won deals only", async () => {
      const s = await summary(owner, contactA, null);
      expect(s).toMatchObject({ allowed: true, partial: false, customer: true, status: "dormant", deals: 2, deals_without_amount: 0, dormant_months: 6, former_months: 18 });
      expect(Number(s.value_agorot)).toBe(150_000);
      expect(String(s.first_purchase_on) < String(s.last_purchase_on)).toBe(true);
      expect(await fields(owner, "contacts", contactA)).toEqual({ status: "dormant", value: "150000" });
    });

    it("a company: its own deals and the company-less deals of its contacts", async () => {
      const s = await summary(owner, null, company);
      // A's two won deals (one with the company, one without) and B's
      expect(s).toMatchObject({ customer: true, status: "active", deals: 3, deals_without_amount: 1 });
      expect(Number(s.value_agorot)).toBe(150_000);
      expect(await fields(owner, "companies", company)).toEqual({ status: "active", value: "150000" });
    });

    it("no won deal = not a customer", async () => {
      expect(await summary(owner, nobody, null)).toMatchObject({ allowed: true, partial: false, customer: false });
      expect(await fields(owner, "contacts", nobody)).toEqual({ status: null, value: null });
    });

    it("the business's thresholds move the status", async () => {
      await asUser(owner.id, (q) => q("insert into public.customer_status_settings (organization_id, dormant_months, former_months) values ($1, 3, 12)", [org]));
      try {
        expect(await summary(owner, contactA, null)).toMatchObject({ status: "dormant", dormant_months: 3, former_months: 12 });
        expect((await fields(owner, "contacts", loner)).status).toBe("active");
        await asUser(owner.id, (q) => q("update public.customer_status_settings set dormant_months = 1, former_months = 2 where organization_id = $1", [org]));
        expect((await fields(owner, "contacts", contactA)).status).toBe("former");
        // the order of the thresholds is the table's rule
        expect((await pgError(asUser(owner.id, (q) => q("update public.customer_status_settings set former_months = 1 where organization_id = $1", [org])))).code).toBe("23514");
      } finally {
        await asUser(owner.id, (q) => q("update public.customer_status_settings set dormant_months = 6, former_months = 18 where organization_id = $1", [org]));
      }
    });

    it("partial when the caller does not read every won deal: no status, no value", async () => {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      try {
        expect(await summary(member, loner, null)).toEqual({ allowed: true, partial: true });
        expect(await fields(member, "contacts", loner)).toEqual({ status: null, value: null });
        // the owner reads everything
        expect(await summary(owner, loner, null)).toMatchObject({ partial: false, status: "active", deals: 2 });
      } finally {
        await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      }
      // with the whole business visible the member and the viewer read it in full
      expect(await summary(member, loner, null)).toMatchObject({ partial: false, deals: 2 });
      expect(await summary(viewer, contactA, null)).toMatchObject({ partial: false, status: "dormant" });
    });

    it("an outsider learns nothing; a summary names exactly one customer", async () => {
      expect(await summary(outsider, contactA, null)).toEqual({ allowed: false });
      expect(await asUser(outsider.id, (q) => q("select app.customer_purchase_count($1, $2, null) as n", [org, contactA]).then((r) => r.rows[0]))).toEqual({ n: null });
      for (const args of [[null, null], [contactA, company]]) {
        const e = await pgError(asUser(owner.id, (q) => q("select public.customer_summary($1, $2, $3)", [org, ...args])));
        expect(e).toMatchObject({ code: "22023", hint: "customer_status:subject" });
      }
      // the count is not callable from the API's other roles
      const anon = await asAdmin(async (q) =>
        (await one<{ a: boolean; s: boolean }>(q, "select has_function_privilege('anon', 'app.customer_purchase_count(uuid, uuid, uuid)', 'execute') as a, has_function_privilege('service_role', 'app.customer_purchase_count(uuid, uuid, uuid)', 'execute') as s")),
      );
      expect(anon).toEqual({ a: false, s: false });
    });

    describe("payments are purchases too (owner (58) ב)", () => {
      const isoDay = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      const pay = (fields: { contact?: string | null; deal?: string | null; daysAgo: number; amount?: number }) =>
        asUser(owner.id, async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.payments (organization_id, contact_id, deal_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, 'cash') returning id",
              [org, fields.contact ?? null, fields.deal ?? null, fields.amount ?? 7_000, isoDay(fields.daysAgo)],
            )
          ).id,
        );
      const newContact = (name: string) =>
        asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).id);

      it("a payment on a won deal is counted once: the value stays the deal's amount", async () => {
        const c = await newContact("שילם על עסקה");
        const d = await deal(owner, { stage: wonStage, contact: c, amount: 40_000, closedDaysAgo: 300 });
        await pay({ contact: c, deal: d, daysAgo: 300, amount: 40_000 });
        const s = await summary(owner, c, null);
        expect(s).toMatchObject({ customer: true, status: "dormant", deals: 1, payments: 1 });
        expect(Number(s.value_agorot)).toBe(40_000);
      });

      it("a payment with no deal moves the last purchase date, never the value", async () => {
        const c = await newContact("שילם בלי עסקה");
        await deal(owner, { stage: wonStage, contact: c, amount: 25_000, closedDaysAgo: 400 });
        expect((await summary(owner, c, null)).status).toBe("dormant");
        await pay({ contact: c, daysAgo: 10, amount: 99_999 });
        const s = await summary(owner, c, null);
        expect(s).toMatchObject({ status: "active", deals: 1, payments: 1 });
        expect(Number(s.value_agorot)).toBe(25_000);
        expect(s.last_purchase_on).toBe(isoDay(10));
        expect(await fields(owner, "contacts", c)).toEqual({ status: "active", value: "25000" });
        // a payment alone makes a customer, of value 0
        const only = await newContact("רק תשלום");
        await pay({ contact: only, daysAgo: 20 });
        expect(await summary(owner, only, null)).toMatchObject({ customer: true, status: "active", deals: 0, payments: 1, value_agorot: 0 });
        // a company: a payment of its contact with no deal
        const co = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברת תשלומים') returning id", [org])).id);
        const worker = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'עובד', $2) returning id", [org, co])).id,
        );
        await pay({ contact: worker, daysAgo: 5 });
        expect(await summary(owner, null, co)).toMatchObject({ customer: true, status: "active", payments: 1 });
      });

      it("a cancelled, failed or refunded payment is ignored", async () => {
        const c = await newContact("תשלומים שלא נחשבים");
        await deal(owner, { stage: wonStage, contact: c, amount: 10_000, closedDaysAgo: 400 });
        const cancelled = await pay({ contact: c, daysAgo: 3 });
        const failed = await pay({ contact: c, daysAgo: 3 });
        const refunded = await pay({ contact: c, daysAgo: 3 });
        await asUser(owner.id, async (q) => {
          await q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]);
          await q("update public.payments set status = 'failed' where id = $1", [failed]);
          await q("update public.payments set status = 'refunded' where id = $1", [refunded]);
        });
        const s = await summary(owner, c, null);
        expect(s).toMatchObject({ status: "dormant", deals: 1, payments: 0 });
        expect(Number(s.value_agorot)).toBe(10_000);
      });

      it("an opening balance is never a purchase", async () => {
        const c = await newContact("יתרת פתיחה");
        await asUser(owner.id, (q) => q("select public.opening_balance_set($1, $2, null, 50000, $3)", [org, c, isoDay(2)]));
        expect(await summary(owner, c, null)).toMatchObject({ customer: false });
        await asUser(owner.id, (q) => q("select public.opening_balance_set($1, $2, null, -20000, $3)", [org, c, isoDay(1)]));
        expect(await summary(owner, c, null)).toMatchObject({ customer: false });
      });

      it("a payment the caller does not read makes the view partial", async () => {
        const c = await asUser(member.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'של החבר', $2) returning id", [org, member.id])).id,
        );
        await deal(member, { stage: wonStage, contact: c, amount: 1_000, closedDaysAgo: 20 });
        // a payment on the owner's deal of this contact
        const ownersDeal = await deal(owner, { stage: openStage, contact: c, amount: 1_000 });
        await pay({ deal: ownersDeal, daysAgo: 2 });
        await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
        try {
          expect(await summary(member, c, null)).toEqual({ allowed: true, partial: true });
        } finally {
          await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
        }
        expect(await summary(owner, c, null)).toMatchObject({ partial: false, deals: 1, payments: 1, status: "active" });
      });
    });

    describe("the kept facts (review: lists read them, owners and admins only)", () => {
      const kept = (id: string) =>
        asAdmin(async (q) =>
          (await q<{ purchases: number; deals: number; payments: number; value_agorot: string; last_purchase_on: string | null }>(
            "select purchases, deals, payments, value_agorot::text, last_purchase_on::text from app.customer_purchase_facts where customer_id = $1",
            [id],
          )).rows[0] ?? null,
        );
      const newContactKept = (name: string) =>
        asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).id);
      const live = (contact: string | null, company: string | null) =>
        asAdmin(async (q) =>
          (await one<{ n: string; last: string | null }>(q, "select count(*)::text as n, max(day)::text as last from app.customer_purchases($1, $2, $3)", [org, contact, company])),
        );

      it("are deferred constraint triggers, and the table is not in the API", async () => {
        const t = await asAdmin(async (q) =>
          (await q<{ tgname: string; d: boolean }>(
            "select tgname, (tgconstraint <> 0 and tgdeferrable and tginitdeferred) as d from pg_trigger where tgname in ('deals_customer_facts', 'payments_customer_facts', 'contacts_customer_facts') order by tgname",
          )).rows,
        );
        expect(t).toEqual([
          { tgname: "contacts_customer_facts", d: true },
          { tgname: "deals_customer_facts", d: true },
          { tgname: "payments_customer_facts", d: true },
        ]);
        const grants = await asAdmin((q) =>
          one<{ a: boolean; s: boolean }>(
            q,
            "select has_table_privilege('authenticated', 'app.customer_purchase_facts', 'select') as a, has_table_privilege('service_role', 'app.customer_purchase_facts', 'select') as s",
          ),
        );
        expect(grants).toEqual({ a: false, s: false });
      });

      it("follow every change at commit: a won deal, its bin, a payment and its status, a contact's company", async () => {
        const co = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה נשמרת') returning id", [org])).id);
        const c = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'נשמר') returning id", [org])).id,
        );
        expect(await kept(c)).toBeNull();
        const d = await deal(owner, { stage: wonStage, contact: c, amount: 3_000, closedDaysAgo: 100 });
        expect(await kept(c)).toMatchObject({ purchases: 1, deals: 1, payments: 0, value_agorot: "3000" });
        const p = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 500, current_date - 3, 'cash') returning id", [org, c])).id,
        );
        expect(await kept(c)).toMatchObject({ purchases: 2, payments: 1, value_agorot: "3000" });
        // the contact moves into the company: its company-less deal and deal-less payment now count for the company too
        await asUser(owner.id, (q) => q("update public.contacts set company_id = $2 where id = $1", [c, co]));
        expect(await kept(co)).toMatchObject({ purchases: 2, deals: 1, payments: 1, value_agorot: "3000" });
        await asUser(owner.id, (q) => q("update public.payments set status = 'failed' where id = $1", [p]));
        expect(await kept(c)).toMatchObject({ purchases: 1, payments: 0 });
        expect(await kept(co)).toMatchObject({ purchases: 1, payments: 0 });
        await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [d]));
        expect(await kept(c)).toMatchObject({ purchases: 0, value_agorot: "0", last_purchase_on: null });
        // and they always equal the live rule read in full
        for (const [ct, cp, id] of [[c, null, c], [null, co, co], [contactA, null, contactA], [null, company, company]] as const) {
          const l = await live(ct, cp);
          const k = await kept(id);
          expect({ n: String(k?.purchases ?? 0), last: k?.last_purchase_on ?? null }).toEqual({ n: l.n, last: l.last });
        }
        // the fields read the kept facts for owners and admins only, never for anyone else (the whole business visible)
        expect((await fields(owner, "contacts", contactA)).status).toBe("dormant");
        for (const u of [member, viewer]) expect(await fields(u, "contacts", contactA)).toEqual({ status: null, value: null });
      });

      it("the list fields are reached only on rows the caller reads: no public function returns contacts or companies", async () => {
        const fns = await asAdmin(async (q) =>
          (await q<{ f: string }>(
            `select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.prorettype in ('public.contacts'::regtype, 'public.companies'::regtype)
                     or pg_get_function_result(p.oid) ~* '(^|[^a-z_])(public\\.)?(contacts|companies)([^a-z_]|$)')`,
          )).rows.map((r) => r.f),
        );
        expect(fns).toEqual([]);
        // and each reader checks an active owner or admin itself
        for (const fn of ["customer_kept_status", "customer_kept_value", "customer_kept_last"]) {
          const body = await asAdmin(async (q) =>
            (await one<{ d: string }>(q, `select pg_get_functiondef('app.${fn}(uuid, uuid, uuid)'::regprocedure) as d`)).d,
          );
          expect(body, fn).toMatch(/m\.user_id = \(select auth\.uid\(\)\) and m\.status = 'active'\s+and m\.role in \('owner', 'admin'\)/);
        }
      });

      it("follow what BEFORE triggers derive: a bounced cheque and its way back, a recurring deal's amount and billing kind", async () => {
        const c = await newContactKept("שיק וחוזר");
        const cheque = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(
            q,
            `insert into public.payments (organization_id, contact_id, amount_agorot, method, paid_on, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status)
             values ($1, $2, 2500, 'cheque', current_date - 2, '777', '12', '601', current_date + 30, 'in_hand') returning id`,
            [org, c],
          )).id,
        );
        expect(await kept(c)).toMatchObject({ purchases: 1, payments: 1 });
        // bounced: payments_cheque derives status = failed; no column of the trigger is named in the statement
        await asUser(owner.id, (q) => q("update public.payments set cheque_status = 'bounced' where id = $1", [cheque]));
        expect(await kept(c)).toMatchObject({ purchases: 0, payments: 0 });
        await asUser(owner.id, (q) => q("update public.payments set cheque_status = 'in_hand', cheque_unbounce_reason = 'הופקד שוב' where id = $1", [cheque]));
        expect(await kept(c)).toMatchObject({ purchases: 1, payments: 1 });
        // a won monthly deal whose value follows its recurring amount (amount_auto)
        const d = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(
            q,
            `insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, amount_agorot, billing_kind, recurring_amount_agorot, recurring_start_date, closed_at)
             values ($1, 'מנוי', $2, $3, $4, null, 'monthly', 1000, current_date, now() - interval '3 days') returning id`,
            [org, pipelineId, wonStage, c],
          )).id,
        );
        expect(await kept(c)).toMatchObject({ deals: 1, value_agorot: "12000" });
        await asUser(owner.id, (q) => q("update public.deals set recurring_amount_agorot = 2000 where id = $1", [d]));
        expect(await kept(c)).toMatchObject({ value_agorot: "24000" });
        await asUser(owner.id, (q) => q("update public.deals set billing_kind = 'yearly' where id = $1", [d]));
        expect(await kept(c)).toMatchObject({ value_agorot: "2000" });
      });

      it("a merged contact's old company loses its purchases", async () => {
        const a = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה א') returning id", [org])).id);
        const b = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה ב') returning id", [org])).id);
        const dup = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'כפול', $2) returning id", [org, a])).id,
        );
        const keep = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'נשאר', $2) returning id", [org, b])).id,
        );
        await deal(owner, { stage: wonStage, contact: dup, amount: 4_000, closedDaysAgo: 30 });
        await asUser(owner.id, (q) => q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 100, current_date - 1, 'cash')", [org, dup]));
        expect(await kept(a)).toMatchObject({ purchases: 2 });
        await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
        expect(await kept(a)).toMatchObject({ purchases: 0, value_agorot: "0" });
        expect(await kept(b)).toMatchObject({ purchases: 2, value_agorot: "4000" });
        expect(await kept(keep)).toMatchObject({ purchases: 2 });
      });

      it("a payment on a deal in the bin counts for no customer, the contact nor the company", async () => {
        const co = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברת סל') returning id", [org])).id);
        const c = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'סל', $2) returning id", [org, co])).id,
        );
        const other = await newContactKept("משלם אחר");
        const d = await deal(owner, { stage: openStage, contact: c, company: co, amount: 1_000 });
        await asUser(owner.id, (q) => q("insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, 300, current_date - 1, 'cash')", [org, d, other]));
        expect(await kept(c)).toMatchObject({ purchases: 1 });
        expect(await kept(co)).toMatchObject({ purchases: 1 });
        expect(await kept(other)).toMatchObject({ purchases: 1 });
        await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [d]));
        for (const id of [c, co, other]) expect(await kept(id)).toMatchObject({ purchases: 0 });
        expect(await summary(owner, other, null)).toMatchObject({ customer: false });
        await asUser(owner.id, (q) => q("update public.deals set deleted_at = null where id = $1", [d]));
        expect(await kept(other)).toMatchObject({ purchases: 1 });
      });

      it("accepted: a company-less deal the caller reads whose contact it does not read makes the company's card partial", async () => {
        const co = await asUser(member.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה של החבר', $2) returning id", [org, member.id])).id,
        );
        const hidden = await asUser(owner.id, async (q) =>
          (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, 'מוסתר', $2, $3) returning id", [org, co, owner.id])).id,
        );
        await deal(member, { stage: wonStage, contact: hidden, amount: 2_000, closedDaysAgo: 5 });
        await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
        try {
          // the member reads the deal but not its contact, so the company's company-less deals cannot be gathered: partial
          expect(await asUser(member.id, (q) => count(q, "select 1 from public.deals where contact_id = $1", [hidden]))).toBe(1);
          expect(await summary(member, null, co)).toEqual({ allowed: true, partial: true });
        } finally {
          await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
        }
      });
    });

    describe("dormant customers: the list field and the automation (RET-01)", () => {
      const runScan = () =>
        asAdmin(async (q) => {
          await q("select set_config('app.date_trigger_hour', '0', true)");
          return (await one<{ n: number }>(q, "select app.run_dormant_automations() as n")).n;
        });
      // a rule whose start point (021140, owner (64) ג) lies far back, so the scan takes every dormant customer
      const rule = async (entity: "contact" | "company", title: string) => {
        const id = await asUser(owner.id, async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'לקוח רדום', $2, 'customer_dormant', $3) returning id",
              [org, entity, JSON.stringify([{ type: "create_task", title, due_in_days: 1 }])],
            )
          ).id,
        );
        await asAdmin((q) => q("update public.automations set dormant_from = '2000-01-01' where id = $1", [id]));
        return id;
      };
      const runsOf = (auto: string) =>
        asAdmin(async (q) => (await q<{ entity_id: string; run_key: string }>("select entity_id, run_key from public.automation_runs where automation_id = $1 order by run_key", [auto])).rows);

      it("the last purchase field reads like the card", async () => {
        const r = await asUser(owner.id, (q) =>
          one<{ d: string | null }>(q, "select public.customer_last_purchase(c)::text as d from public.contacts c where c.id = $1", [contactA]),
        );
        expect(r.d).toBe((await summary(owner, contactA, null)).last_purchase_on);
        const dormantIds = await asUser(owner.id, async (q) =>
          (await q<{ id: string }>("select c.id from public.contacts c where c.organization_id = $1 and public.customer_status(c) = 'dormant'", [org])).rows.map((x) => x.id),
        );
        expect(dormantIds).toContain(contactA);
        expect(dormantIds).not.toContain(loner);
      });

      it("the dormant list: owners and admins only, from the kept facts, longest without a purchase first", async () => {
        const list = (u: U, kind: string) =>
          asUser(u.id, async (q) => (await one<{ r: { allowed: boolean; rows?: Array<{ id: string; last_purchase_on: string }>; more?: boolean } }>(
            q, "select public.dormant_customers($1, $2, 200) as r", [org, kind])).r);
        const r = await list(owner, "contact");
        expect(r.allowed).toBe(true);
        expect(r.rows!.map((x) => x.id)).toContain(contactA);
        expect(r.rows!.map((x) => x.id)).not.toContain(loner);
        const days = r.rows!.map((x) => x.last_purchase_on);
        expect([...days].sort()).toEqual(days);
        for (const u of [member, viewer]) expect(await list(u, "contact")).toEqual({ allowed: false });
        expect(await asUser(outsider.id, async (q) => (await one<{ r: unknown }>(q, "select public.dormant_customers($1, 'contact') as r", [org])).r)).toEqual({ allowed: false });
        expect((await pgError(asUser(owner.id, (q) => q("select public.dormant_customers($1, 'lead')", [org])))).hint).toBe("customer_status:kind");
      });

      it("runs once per customer and dormancy start, never for an active or former customer", async () => {
        const auto = await rule("contact", "לחזור ללקוח רדום");
        try {
          await runScan();
          const runs = await runsOf(auto);
          const forA = runs.filter((r) => r.entity_id === contactA);
          expect(forA).toHaveLength(1);
          const s = await summary(owner, contactA, null);
          expect(forA[0].run_key).toBe(`dormant:${contactA}:${s.last_purchase_on}`);
          // active (the loner) and not-customers never run
          expect(runs.some((r) => r.entity_id === loner || r.entity_id === nobody)).toBe(false);
          // the task was made
          expect(await asAdmin((q) => count(q, "select 1 from public.tasks where organization_id = $1 and contact_id = $2 and title = 'לחזור ללקוח רדום'", [org, contactA]))).toBe(1);
          // a second pass adds nothing
          await runScan();
          expect((await runsOf(auto)).filter((r) => r.entity_id === contactA)).toHaveLength(1);
          // a former customer never runs
          const old = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'ישן מאוד') returning id", [org])).id);
          await deal(owner, { stage: wonStage, contact: old, amount: 1, closedDaysAgo: 800 });
          await runScan();
          expect((await runsOf(auto)).some((r) => r.entity_id === old)).toBe(false);
        } finally {
          await asUser(owner.id, (q) => q("update public.automations set is_active = false where id = $1", [auto]));
        }
      });

      it("a change of the dormant months never runs the rule again for the same quiet spell", async () => {
        const c = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'סף משתנה') returning id", [org])).id);
        await deal(owner, { stage: wonStage, contact: c, amount: 1_000, closedDaysAgo: 250 });
        const auto = await rule("contact", "לחזור אחרי שינוי סף");
        try {
          await runScan();
          expect((await runsOf(auto)).filter((r) => r.entity_id === c)).toHaveLength(1);
          await asUser(owner.id, (q) => q("insert into public.customer_status_settings (organization_id, dormant_months, former_months) values ($1, 7, 18) on conflict do nothing", [org]));
          await asUser(owner.id, (q) => q("update public.customer_status_settings set dormant_months = 7 where organization_id = $1", [org]));
          await runScan();
          expect((await runsOf(auto)).filter((r) => r.entity_id === c)).toHaveLength(1);
        } finally {
          await asUser(owner.id, (q) => q("update public.customer_status_settings set dormant_months = 6, former_months = 18 where organization_id = $1", [org]));
          await asUser(owner.id, (q) => q("update public.automations set is_active = false where id = $1", [auto]));
        }
      });

      it("companies too; the retry check holds only while no purchase came since", async () => {
        const co = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה רדומה') returning id", [org])).id);
        await deal(owner, { stage: wonStage, company: co, amount: 5_000, closedDaysAgo: 250 });
        const auto = await rule("company", "לחזור לחברה רדומה");
        try {
          await runScan();
          const runs = (await runsOf(auto)).filter((r) => r.entity_id === co);
          expect(runs).toHaveLength(1);
          const facts = await asAdmin((q) =>
            one<{ f: { last_purchase_on: string; dormant_on: string } }>(q, "select app.automation_run_facts('customer_dormant', '{}', 'company', $1, $2, $3) as f", [org, co, runs[0].run_key]),
          );
          const sum = await summary(owner, null, co);
          expect(facts.f).toEqual({ last_purchase_on: sum.last_purchase_on, dormant_on: sum.dormant_on });
          expect(runs[0].run_key).toBe(`dormant:${co}:${sum.last_purchase_on}`);
          const holds = () =>
            asAdmin(async (q) =>
              (await one<{ h: boolean }>(
                q,
                "select app.automation_event_still_holds('customer_dormant', '{}', 'company', $1, $2, (select to_jsonb(c) from public.companies c where c.id = $2), $3) as h",
                [org, co, JSON.stringify(facts.f)],
              )).h,
            );
          expect(await holds()).toBe(true);
          await deal(owner, { stage: wonStage, company: co, amount: 5_000, closedDaysAgo: 1 });
          expect(await holds()).toBe(false);
          // the type never starts from an event
          const em = await asAdmin((q) =>
            one<{ d: string }>(q, "select pg_get_functiondef('app.automation_event_matches(public.automations, public.outbox_events, jsonb)'::regprocedure) as d"),
          );
          expect(em.d).toMatch(/when 'customer_dormant' then false/);
        } finally {
          await asUser(owner.id, (q) => q("update public.automations set is_active = false where id = $1", [auto]));
        }
      });
    });
  });
});
