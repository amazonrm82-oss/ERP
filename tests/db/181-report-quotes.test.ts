import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Report = ReturnType<typeof parseReportData<"report_quotes">>;

/**
 * QUO-17: public.report_quotes(org, from, to, owner) is security invoker. Quotes sent in [from, to) by sent_at, each version
 * chain once (its newest sent version); acceptance rate = accepted / (accepted + rejected), null below 5; hours from sending to
 * acceptance (quote_decisions for owners/admins, the "accepted" timeline entry otherwise); open value = sent or viewed quotes
 * not past their validity, now.
 */
describe("the quotes report (QUO-17)", () => {
  let owner: U, member: U, rep: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
  const from = hours(-24 * 7);
  const to = hours(24);

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // a sent quote of `by` worth 500 ILS before VAT (590 with it)
  const sentQuote = (by: U, orgId = org) =>
    asUser(by.id, async (q) => {
      const pipe = orgId === org ? { pipelineId, stageId } : await defaultPipeline(orgId).then((p) => ({ pipelineId: p.pipelineId, stageId: p.stages[0].id }));
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          orgId,
          pipe.pipelineId,
          pipe.stageId,
          by.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [orgId, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [orgId, quote]);
      await q("select public.quote_send($1, $2)", [orgId, quote]);
      return quote;
    });
  const setStatus = (quote: string, status: string) => asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [quote, status]));
  // move a quote's sending back in time, past the triggers (a sent quote's columns are frozen)
  const sentAt = (quote: string, at: string) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set sent_at = $2 where id = $1", [quote, at]);
    });
  const report = (u: U, ownerId: string | null = null, orgId = org): Promise<Report> =>
    asUser(u.id, async (q) =>
      parseReportData("report_quotes", (await one<{ r: unknown }>(q, "select public.report_quotes($1, $2, $3, $4) as r", [orgId, from, to, ownerId])).r),
    );

  beforeAll(async () => {
    owner = await createUser("rq-owner");
    org = await createOrg(owner.id, "עסק הדוח");
    member = await addMember(org, owner.id, "member", "rq-member");
    rep = await addMember(org, owner.id, "member", "rq-rep");
    outsider = await createUser("rq-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    for (const [who, o] of [
      [owner, org],
      [outsider, otherOrg],
    ] as const) {
      await asUser(who.id, (q) =>
        q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [o]),
      );
    }
  });

  it("counts the period's quotes by status, the rate from 5 decided, and the open value now", async () => {
    const empty = await report(owner);
    expect(empty.totals).toMatchObject({ sent: 0, acceptance_rate: null, avg_hours_to_accept: null, open_count: 0, open_amount: 0 });
    expect(empty.by_owner).toEqual([]);

    // 4 accepted and 1 declined by the member, one waiting, one viewed, one cancelled
    const accepted = [await sentQuote(member), await sentQuote(member), await sentQuote(member), await sentQuote(member)];
    const declined = await sentQuote(member);
    const waiting = await sentQuote(member);
    const viewed = await sentQuote(member);
    const cancelled = await sentQuote(member);
    for (const id of accepted) await setStatus(id, "accepted");
    await setStatus(declined, "rejected");
    await setStatus(viewed, "viewed");
    await setStatus(cancelled, "cancelled");
    // a quote sent before the period: not in the period's counts, but open now
    const older = await sentQuote(member);
    await sentAt(older, hours(-24 * 30));
    // an open quote past its validity is not open
    const lapsed = await sentQuote(member);
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set valid_until = current_date - 3, quote_date = current_date - 30 where id = $1", [lapsed]);
    });

    const r = await report(owner);
    expect(r.totals).toMatchObject({ sent: 9, accepted: 4, rejected: 1, waiting: 2, viewed: 1, cancelled: 1, expired: 0 });
    expect(r.totals.acceptance_rate).toBe(80);
    expect(r.totals.accepted_amount).toBe(4 * 59000);
    // waiting + viewed + older; the lapsed one is left out
    expect(r.totals.open_count).toBe(3);
    expect(r.totals.open_amount).toBe(3 * 59000);
    expect(r.rate_min).toBe(5);
    expect(r.by_owner).toEqual([expect.objectContaining({ owner_id: member.id, sent: 9, accepted: 4, rejected: 1, acceptance_rate: 80, open_count: 3 })]);
    // one fewer decided: no rate
    await sentAt(declined, hours(-24 * 30));
    expect((await report(owner)).totals.acceptance_rate).toBeNull();
    void waiting;
  });

  it("measures the time to acceptance from the decision for owners and admins, and from the timeline for everyone else", async () => {
    const quote = await sentQuote(rep);
    await sentAt(quote, hours(-10));
    await setStatus(quote, "accepted");
    // the decision row (QUO-09) says it was accepted 4 hours after sending; the timeline entry is now (10 hours after)
    await asAdmin((q) =>
      q(
        `insert into public.quote_decisions (organization_id, quote_id, decision, decided_at, signer_name, signature_kind, wording_version, content_sha256)
         values ($1, $2, 'accepted', $3, 'רונית', 'typed', 'draft-2026-10-18', $4)`,
        [org, quote, hours(-6), "a".repeat(64)],
      ),
    );
    const forOwner = (await report(owner, rep.id)).totals;
    const forRep = (await report(rep, rep.id)).totals;
    expect(forOwner).toMatchObject({ accepted: 1, accepted_measured: 1, avg_hours_to_accept: 4 });
    expect(forRep).toMatchObject({ accepted: 1, accepted_measured: 1 });
    expect(forRep.avg_hours_to_accept).toBeGreaterThanOrEqual(9.9);
    expect(forRep.avg_hours_to_accept).toBeLessThanOrEqual(10.1);
  });

  it("counts a version chain once, by its newest sent version, and filters by owner", async () => {
    const v1 = await sentQuote(owner);
    const v2 = await asUser(owner.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, v1])).v);
    const before = (await report(owner, owner.id)).totals;
    expect(before.sent).toBe(1); // a draft version supersedes nothing
    await asUser(owner.id, (q) => q("select public.quote_send($1, $2)", [org, v2]));
    const after = await report(owner, owner.id);
    expect(after.totals.sent).toBe(1);
    expect(after.totals.open_count).toBe(1);
    expect(after.by_owner.map((r) => r.owner_id)).toEqual([owner.id]);
  });

  it("is invoker: RLS decides, another business sees nothing, and only signed-in users may call it", async () => {
    await sentQuote(outsider, otherOrg);
    const mine = (await report(owner)).totals.sent;
    expect(mine).toBeGreaterThan(0);
    expect((await report(outsider, null, org)).totals).toMatchObject({ sent: 0, open_count: 0, open_amount: 0 });
    expect((await report(owner, null, otherOrg)).totals).toMatchObject({ sent: 0, open_count: 0 });
    // with "own" visibility a member counts only the quotes of the deals they read
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const repView = await report(rep);
      expect(repView.by_owner.every((r) => r.owner_id === rep.id)).toBe(true);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    const fn = await asAdmin(async (q) =>
      one<{ definer: boolean; anon: boolean; authed: boolean }>(
        q,
        `select p.prosecdef as definer, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'report_quotes'`,
      ),
    );
    expect(fn).toEqual({ definer: false, anon: false, authed: true });
  });

  it("the export log takes the report key while the business has quotes", async () => {
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'quotes', 3, 'csv')", [org]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'quotes', 3, 'csv')", [org])))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
  });
});
