import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Report = ReturnType<typeof parseReportData<"report_quotes">>;

/**
 * QUO-17 follow-up (020695): for a caller who does not read quote_decisions, the time to acceptance comes from the quote's
 * "accepted" timeline entry, now looked up on the quote's deal, else on its contact (an index on metadata cannot be used
 * under RLS). A quote with neither (both purged, their entries with them) gets no time.
 */
describe("the quotes report finds the accepted entry through the deal or the contact", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
  const from = hours(-24 * 7);
  const to = hours(24);

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const report = (u: U): Promise<Report> =>
    asUser(u.id, async (q) =>
      parseReportData("report_quotes", (await one<{ r: unknown }>(q, "select public.report_quotes($1, $2, $3, $4) as r", [org, from, to, member.id])).r),
    );
  const newContact = (name: string) =>
    asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, member.id])).id,
    );
  // a quote of the member on a deal (without a contact) or on a contact only, sent `ago` hours ago and accepted now
  const acceptedQuote = (parent: { deal?: true; contact?: string }, ago: number) =>
    asUser(member.id, async (q) => {
      let deal: string | null = null;
      if (parent.deal) {
        deal = (
          await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
            org,
            pipelineId,
            stageId,
            member.id,
          ])
        ).id;
      }
      const quote = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [
          org,
          deal,
          parent.contact ?? null,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    }).then(async (quote) => {
      await asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.quotes set sent_at = $2 where id = $1", [quote, hours(-ago)]);
      });
      // the status change writes the QUO-16 "accepted" entry on the quote's deal and contact, now
      await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
      return quote;
    });
  const entriesOf = (quote: string) =>
    asAdmin((q) => count(q, "select 1 from public.activities where metadata ->> 'kind' = 'quote_accepted' and metadata ->> 'quote_id' = $1", [quote]));

  beforeAll(async () => {
    owner = await createUser("rql-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    member = await addMember(org, owner.id, "member", "rql-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
  });

  it("a member gets the time to acceptance through the deal, and through the contact when there is no deal", async () => {
    const onDeal = await acceptedQuote({ deal: true }, 10);
    expect(await entriesOf(onDeal)).toBe(1);
    const first = (await report(member)).totals;
    expect(first).toMatchObject({ accepted: 1, accepted_measured: 1 });
    expect(first.avg_hours_to_accept).toBeGreaterThanOrEqual(9.9);
    expect(first.avg_hours_to_accept).toBeLessThanOrEqual(10.1);

    const onContact = await acceptedQuote({ contact: await newContact("שלי") }, 20);
    expect(await entriesOf(onContact)).toBe(1);
    const both = (await report(member)).totals;
    expect(both).toMatchObject({ accepted: 2, accepted_measured: 2 });
    // (10 + 20) / 2
    expect(both.avg_hours_to_accept).toBeGreaterThanOrEqual(14.9);
    expect(both.avg_hours_to_accept).toBeLessThanOrEqual(15.1);
    // the owner reads no decision rows here either (none were made), so the same entries count for them
    expect((await report(owner)).totals).toMatchObject({ accepted: 2, accepted_measured: 2 });
  });

  it("an entry of the same quote on another record is not taken, and a quote with neither deal nor contact gets no time", async () => {
    // a stray "accepted" entry naming a quote, on an unrelated contact: the lookup reads only the quote's own records
    const contact = await newContact("נועם");
    const quote = await acceptedQuote({ contact }, 5);
    const other = await newContact("אחר");
    await asAdmin((q) =>
      q(
        "insert into public.activities (organization_id, type, body, metadata, contact_id, created_at) values ($1, 'system', 'הצעה אושרה', jsonb_build_object('kind', 'quote_accepted', 'quote_id', $2::text), $3, $4)",
        [org, quote, other, hours(-4.5)],
      ),
    );
    const withStray = (await report(member)).totals;
    expect(withStray).toMatchObject({ accepted: 3, accepted_measured: 3 });
    // (10 + 20 + 5) / 3, not counting the stray entry half an hour after sending
    expect(withStray.avg_hours_to_accept).toBeGreaterThanOrEqual(11.6);
    expect(withStray.avg_hours_to_accept).toBeLessThanOrEqual(11.8);

    // purging the contact detaches the sent quote (no deal, no contact) and removes its entries with it: no time
    await asAdmin((q) => q("delete from public.contacts where id = $1", [contact]));
    const detached = await asAdmin((q) =>
      one<{ deal_id: string | null; contact_id: string | null }>(q, "select deal_id, contact_id from public.quotes where id = $1", [quote]),
    );
    expect(detached).toEqual({ deal_id: null, contact_id: null });
    const after = (await report(owner)).totals;
    expect(after).toMatchObject({ accepted: 3, accepted_measured: 2 });
  });
});
