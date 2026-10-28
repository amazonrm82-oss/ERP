import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCollection } from "../../src/features/collection/collection";
import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

const staffIds: string[] = [];
afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

// The read rules collection_documents' owner/admin shortcut relies on (it skips BAL-03's partial count for owners and admins,
// who read every row under these rules). Changing any of them means judging the shortcut in 021098 again.
const EXPECTED_READ_RULES: Record<string, string> = {
  accounting_documents: `CASE
    WHEN (deal_id IS NOT NULL) THEN (EXISTS ( SELECT 1 FROM public.deals d WHERE ((d.organization_id = accounting_documents.organization_id) AND (d.id = accounting_documents.deal_id))))
    WHEN (contact_id IS NOT NULL) THEN (EXISTS ( SELECT 1 FROM public.contacts c WHERE ((c.organization_id = accounting_documents.organization_id) AND (c.id = accounting_documents.contact_id))))
    WHEN (company_id IS NOT NULL) THEN (EXISTS ( SELECT 1 FROM public.companies co WHERE ((co.organization_id = accounting_documents.organization_id) AND (co.id = accounting_documents.company_id))))
    ELSE COALESCE((app.role_in(organization_id) = ANY (ARRAY['owner'::public.membership_role, 'admin'::public.membership_role, 'manager'::public.membership_role])), false)
  END`,
  payments: `CASE
    WHEN (deal_id IS NOT NULL) THEN (EXISTS ( SELECT 1 FROM public.deals d WHERE ((d.organization_id = payments.organization_id) AND (d.id = payments.deal_id))))
    WHEN (contact_id IS NOT NULL) THEN (EXISTS ( SELECT 1 FROM public.contacts c WHERE ((c.organization_id = payments.organization_id) AND (c.id = payments.contact_id))))
    ELSE COALESCE((app.role_in(organization_id) = ANY (ARRAY['owner'::public.membership_role, 'admin'::public.membership_role, 'manager'::public.membership_role])), false)
  END`,
  deals: `(app.can_read_record(organization_id, owner_id, team_id) OR ((organization_id, id) IN ( SELECT r.organization_id, r.id FROM app.deputy_readable('deal'::text) r(organization_id, id))))`,
  contacts: `(app.can_read_record(organization_id, owner_id, team_id) OR ((organization_id, id) IN ( SELECT r.organization_id, r.id FROM app.deputy_readable('contact'::text) r(organization_id, id))))`,
  companies: `(app.can_read_record(organization_id, owner_id, team_id) OR ((organization_id, id) IN ( SELECT r.organization_id, r.id FROM app.deputy_readable('company'::text) r(organization_id, id))))`,
};

type U = { id: string; email: string };

/**
 * COL-01: the collection screen. public.collection_documents lists the open debt documents (BAL-02's debt, BAL-03's age
 * buckets, report_debt_aging's customer and rep), with the totals, and filters by rep, customer, overdue and bucket. BAL-01's
 * rights and BAL-03's business-wide partial rule; plan keys collection, documents and payments.
 */
describe("collection screen (COL-01)", () => {
  let owner: U, manager: U, member: U, keyHolder: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  // the documents of the contact the key holder owns (test 1)
  let keyHolderDocs: string[] = [];
  const FEATURES = { documents: true, payments: true, balances: true, collection: true, granular_permissions: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const company = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const contact = (name: string, companyId: string | null = null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (name: string, contactId: string | null, companyId: string | null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, name, pipelineId, stageId, contactId, companyId, ownerId],
        )
      ).id,
    );
  const doc = (amount: number, due: string | null, on: { deal?: string | null; contact?: string | null }, type = "tax_invoice") =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
          [org, on.deal ?? null, on.contact ?? null, type, `CL-${++n}`, day(-200), amount, due],
        )
      ).id,
    );
  type Opts = { owner?: string | null; overdue?: boolean; bucket?: string | null; kind?: string | null; id?: string | null };
  const raw = (u: U, o: Opts = {}) =>
    run(u, async (q) =>
      (
        await one<{ r: unknown }>(q, "select public.collection_documents($1, $2, $3, $4, $5, $6) as r", [
          org,
          o.owner ?? null,
          o.overdue ?? false,
          o.bucket ?? null,
          o.kind ?? null,
          o.id ?? null,
        ])
      ).r,
    );
  const full = async (u: U, o: Opts = {}) => {
    const r = parseCollection(await raw(u, o));
    if (!r.allowed || r.partial) throw new Error("expected the full screen");
    return r;
  };

  beforeAll(async () => {
    owner = await createUser("cl-owner");
    org = await createOrg(owner.id, "עסק הגבייה");
    manager = await addMember(org, owner.id, "manager", "cl-manager");
    member = await addMember(org, owner.id, "member", "cl-member");
    keyHolder = await addMember(org, owner.id, "member", "cl-key");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));
  });

  it("lists open documents with age, customer and rep; totals equal the aging report; filters", async () => {
    const co = await company("חברת הגבייה");
    const inCo = await contact("דנה", co);
    const alone = await contact("יואב", null, keyHolder.id);
    const coDeal = await deal("עסקת חברה", null, co);
    const late = await doc(5000, day(-10), { contact: inCo });
    const veryLate = await doc(7000, day(-100), { deal: coDeal });
    const notYet = await doc(3000, day(4), { contact: alone });
    const noDue = await doc(800, null, { contact: alone });
    // paid in full: not listed
    const paid = await doc(1000, day(-40), { contact: alone });
    await run(owner, async (q) => {
      const p = await one<{ id: string }>(
        q,
        "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 1000, $3, 'cash') returning id",
        [org, alone, day(-5)],
      );
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 1000)", [org, p.id, paid]);
    });
    // a receipt is never a debt
    await doc(999, null, { contact: alone }, "receipt");

    keyHolderDocs = [notYet, noDue];
    const r = await full(owner);
    const ids = r.documents.map((d) => d.id);
    expect(ids).toEqual([veryLate, late, notYet, noDue]);
    const byId = new Map(r.documents.map((d) => [d.id, d]));
    expect(byId.get(veryLate)).toMatchObject({ bucket: "d91_plus", days_late: 100, balance: 7000, customer_kind: "company", customer_id: co, customer_name: "חברת הגבייה", owner_id: owner.id, held: false });
    expect(byId.get(late)).toMatchObject({ bucket: "d1_30", days_late: 10, customer_kind: "company", customer_id: co });
    expect(byId.get(notYet)).toMatchObject({ bucket: "current", days_late: -4, customer_kind: "contact", customer_name: "יואב", owner_id: keyHolder.id });
    expect(byId.get(noDue)).toMatchObject({ bucket: "current", days_late: null });
    expect(r.totals).toMatchObject({ total: 15800, overdue: 12000, documents: 4, overdue_documents: 2, current: 3800, d1_30: 5000, d91_plus: 7000 });
    expect(r.shown).toEqual({ total: 15800, documents: 4 });
    expect(r.more).toBe(false);

    // the same totals as BAL-03's report (one rule)
    const aging = await run(owner, async (q) => (await one<{ r: { totals: Record<string, number> } }>(q, "select public.report_debt_aging($1) as r", [org])).r);
    for (const k of ["current", "d1_30", "d31_60", "d61_90", "d91_plus", "total", "overdue", "documents"]) {
      expect(Number(r.totals[k as keyof typeof r.totals])).toBe(Number(aging.totals[k]));
    }

    // overdue only; a bucket; a customer; a rep
    expect((await full(owner, { overdue: true })).documents.map((d) => d.id)).toEqual([veryLate, late]);
    const overdue = await full(owner, { overdue: true });
    expect(overdue.shown).toEqual({ total: 12000, documents: 2 });
    expect(overdue.totals.total).toBe(15800);
    expect((await full(owner, { bucket: "d1_30" })).documents.map((d) => d.id)).toEqual([late]);
    expect((await full(owner, { kind: "company", id: co })).documents.map((d) => d.id)).toEqual([veryLate, late]);
    const mine = await full(owner, { owner: keyHolder.id });
    expect(mine.documents.map((d) => d.id)).toEqual([notYet, noDue]);
    expect(mine.totals.total).toBe(3800);

    // COL-05: a hold on the customer's company marks its documents
    await run(owner, (q) => q("insert into public.customer_holds (organization_id, company_id, reason) values ($1, $2, 'חוב ישן')", [org, co]));
    const held = await full(owner);
    expect(held.documents.filter((d) => d.held).map((d) => d.id).sort()).toEqual([late, veryLate].sort());
  });

  it("refuses an unknown bucket or a half customer", async () => {
    expect(await pgError(raw(owner, { bucket: "d1_99" }))).toMatchObject({ code: "22023" });
    expect(await pgError(raw(owner, { kind: "company" }))).toMatchObject({ code: "22023" });
    expect(await pgError(raw(owner, { kind: "lead", id: owner.id }))).toMatchObject({ code: "22023" });
  });

  it("rights: BAL-01's rule, the partial list without totals (COL-01 (3) ב) and the plan keys", async () => {
    expect(await raw(member)).toEqual({ allowed: false });
    expect((await raw(keyHolder)) as { allowed: boolean }).toMatchObject({ allowed: true, partial: false });
    expect((await raw(manager)) as { allowed: boolean }).toMatchObject({ allowed: true, partial: false });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // owner's answer (3) ב: the documents the key holder reads, with their amounts, and no total of any kind
      const partial = parseCollection(await raw(keyHolder));
      if (!partial.allowed || !partial.partial) throw new Error("expected the partial list");
      expect(partial.totals).toBeNull();
      expect(partial.shown).toBeNull();
      expect(partial.documents.map((d) => d.id)).toEqual(keyHolderDocs);
      expect(partial.documents.map((d) => d.balance)).toEqual([3000, 800]);
      // the filters still narrow it, and still no totals
      const overdueOnly = parseCollection(await raw(keyHolder, { overdue: true }));
      expect(overdueOnly).toMatchObject({ allowed: true, partial: true, totals: null, shown: null, documents: [] });
      // a manager who reads nothing sees an empty partial list
      expect(parseCollection(await raw(manager))).toMatchObject({ allowed: true, partial: true, totals: null, documents: [] });
      expect(await raw(owner)).toMatchObject({ allowed: true, partial: false });
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    for (const key of ["collection", "documents", "payments"]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, [key]: false })]));
      try {
        expect(await raw(owner)).toEqual({ allowed: false });
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
    }
  });

  it("the read rules the owner/admin shortcut relies on are unchanged (judge the shortcut again before changing this)", async () => {
    // exactly one permissive select policy on each table, and no FOR ALL or restrictive one that could narrow reading
    const policies = await asAdmin(async (q) =>
      (
        await q<{ t: string; name: string; cmd: string; permissive: boolean }>(
          `select c.relname as t, p.polname as name, p.polcmd::text as cmd, p.polpermissive as permissive
             from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname in ('accounting_documents', 'payments', 'deals', 'contacts', 'companies')
              and (p.polcmd in ('r', '*') or not p.polpermissive)
            order by 1, 2`,
        )
      ).rows,
    );
    expect(policies).toEqual([
      { t: "accounting_documents", name: "accounting_documents_select", cmd: "r", permissive: true },
      { t: "companies", name: "companies_select", cmd: "r", permissive: true },
      { t: "contacts", name: "contacts_select", cmd: "r", permissive: true },
      { t: "deals", name: "deals_select", cmd: "r", permissive: true },
      { t: "payments", name: "payments_select", cmd: "r", permissive: true },
    ]);
    // each real rule equals the expected text, both rendered by this server in the same session (as test 254 does), so the
    // comparison does not depend on how a PostgreSQL version prints an expression
    const rendered = await asAdmin(async (q) => {
      await q("set local search_path = public");
      const out: Record<string, { real: string; expected: string }> = {};
      for (const [table, rule] of Object.entries(EXPECTED_READ_RULES)) {
        await q(`create temp table ${table} (like public.${table}) on commit drop`);
        await q(`create policy expected_read on pg_temp.${table} for select using (${rule})`);
        out[table] = (
          await q<{ real: string; expected: string }>(
            `select md5(pg_get_expr(r.polqual, r.polrelid)) as real, md5(pg_get_expr(e.polqual, e.polrelid)) as expected
               from pg_policy r, pg_policy e
              where r.polrelid = $1::regclass and r.polname = $2 and e.polrelid = $3::regclass and e.polname = 'expected_read'`,
            [`public.${table}`, `${table}_select`, `pg_temp.${table}`],
          )
        ).rows[0];
      }
      return out;
    });
    for (const [table, { real, expected }] of Object.entries(rendered)) expect(real, table).toBe(expected);
  });

  it("a platform support session reads as a viewer: nothing", async () => {
    const support = await createUser("cl-support");
    staffIds.push(support.id);
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]));
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
    const answer = await asMfaUser(support.id, async (q) => (await one<{ r: unknown }>(q, "select public.collection_documents($1) as r", [org])).r);
    expect(answer).toEqual({ allowed: false });
  });

  it("another business sees nothing", async () => {
    const stranger = await createUser("cl-stranger");
    await createOrg(stranger.id, "עסק זר");
    expect(await raw(stranger)).toEqual({ allowed: false });
  });

  it("is security invoker and closed to anon", async () => {
    const fns = await asAdmin(
      async (q) =>
        (
          await q<{ definer: boolean; anon: boolean; authed: boolean }>(
            `select p.prosecdef as definer, has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authed
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'collection_documents'`,
          )
        ).rows,
    );
    expect(fns).toEqual([{ definer: false, anon: false, authed: true }]);
  });
});
