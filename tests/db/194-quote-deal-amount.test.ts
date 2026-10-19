import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-13, owner's answer of 19 October 2026 (ב): when an accepted quote moves its deal, the deal's amount is the quote's
 * total (before VAT, after the document discount, quotes.net_total_agorot), marked "(לפי הצעה מס' X)" through
 * deals.amount_quote_id. Trigger deals_amount_quote keeps the mark only while it is true.
 */
describe("the deal's amount follows the accepted quote (QUO-13)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, openStage: string, wonStage: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setMode = (mode: "auto" | "ask" | "none") =>
    asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status, quote_accept_deal) values ($1, 'licensed', $2) on conflict (organization_id) do update set quote_accept_deal = $2", [
        org,
        mode,
      ]),
    );
  // a deal and an accepted-to-be quote with a 10% document discount: lines 100,000, net 90,000
  const sentQuote = () =>
    asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'שיפוץ', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          openStage,
          contact,
          member.id,
        ])
      ).id;
      const quote = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, discount_bp) values ($1, 'שיפוץ מטבח', $2, $3, 1000) returning id", [
          org,
          deal,
          contact,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 50000, 2)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t;
      return { quote, deal, token };
    });
  const accept = (token: string) =>
    asService(async (q) => {
      const fp = (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint;
      return (
        await one<{ a: { status: string } }>(
          q,
          `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה כהן',
                    p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
          [token, fp],
        )
      ).a;
    });
  const deal = (id: string) =>
    asAdmin((q) =>
      one<{ status: string; amount_agorot: string | null; amount_auto: boolean | null; amount_source: string | null; amount_quote_id: string | null }>(
        q,
        "select status, amount_agorot::text, amount_auto, amount_source, amount_quote_id from public.deals where id = $1",
        [id],
      ),
    );
  const net = (quote: string) => asAdmin(async (q) => (await one<{ n: string }>(q, "select net_total_agorot::text as n from public.quotes where id = $1", [quote])).n);
  const win = (quote: string, amount: number | null) =>
    asUser(member.id, async (q) =>
      (await one<{ r: unknown }>(q, "select public.quote_win_deal(p_org => $1, p_quote => $2, p_stage => $3, p_amount_agorot => $4, p_closed_at => now()) as r", [org, quote, wonStage, amount])).r,
    );

  beforeAll(async () => {
    owner = await createUser("qda-owner");
    org = await createOrg(owner.id, "עסק הסכומים");
    member = await addMember(org, owner.id, "member", "qda-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, products: true, discounts: true, price_lists: true })]),
    );
    await setMode("ask");
  });

  it("auto: the amount is the quote's total before VAT, after the document discount; a typed amount, marked with the quote", async () => {
    await setMode("auto");
    const a = await sentQuote();
    expect(await net(a.quote)).toBe("90000");
    await accept(a.token);
    // the lines alone would give 100,000; the customer accepted 90,000
    expect(await deal(a.deal)).toEqual({ status: "won", amount_agorot: "90000", amount_auto: null, amount_source: null, amount_quote_id: a.quote });
    await setMode("ask");
  });

  it("the won window: the quote's total keeps the mark; another amount does not", async () => {
    await setMode("ask");
    const a = await sentQuote();
    await accept(a.token);
    await win(a.quote, 90000);
    expect(await deal(a.deal)).toMatchObject({ status: "won", amount_agorot: "90000", amount_quote_id: a.quote });

    const b = await sentQuote();
    await accept(b.token);
    await win(b.quote, 95000);
    expect(await deal(b.deal)).toMatchObject({ status: "won", amount_agorot: "95000", amount_quote_id: null });
  });

  it("the mark goes when the amount changes, and nobody can state a false one", async () => {
    await setMode("auto");
    const a = await sentQuote();
    await accept(a.token);
    expect((await deal(a.deal)).amount_quote_id).toBe(a.quote);
    // a person changes the amount: the mark is cleared in the same update
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 80000 where id = $1", [a.deal]));
    expect(await deal(a.deal)).toMatchObject({ amount_agorot: "80000", amount_quote_id: null });
    // putting the mark back on an amount that is not the quote's total does nothing
    await asUser(member.id, (q) => q("update public.deals set amount_quote_id = $2 where id = $1", [a.deal, a.quote]));
    expect((await deal(a.deal)).amount_quote_id).toBeNull();
    // the quote's total again: the mark may be stated, because it is true
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 90000, amount_quote_id = $2 where id = $1", [a.deal, a.quote]));
    expect((await deal(a.deal)).amount_quote_id).toBe(a.quote);

    // never a quote of another deal, a quote that is not accepted, or on insert
    const other = await sentQuote();
    await asAdmin((q) => q("update public.deals set amount_agorot = 90000 where id = $1", [other.deal]));
    await asAdmin((q) => q("update public.deals set amount_quote_id = $2 where id = $1", [other.deal, other.quote]));
    expect((await deal(other.deal)).amount_quote_id).toBeNull();
    await asAdmin((q) => q("update public.deals set amount_quote_id = $2 where id = $1", [other.deal, a.quote]));
    expect((await deal(other.deal)).amount_quote_id).toBeNull();
    const inserted = await asAdmin(async (q) =>
      (
        await one<{ amount_quote_id: string | null }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot, amount_quote_id) values ($1, 'חדשה', $2, $3, 90000, $4) returning amount_quote_id",
          [org, pipelineId, openStage, a.quote],
        )
      ).amount_quote_id,
    );
    expect(inserted).toBeNull();
    await setMode("ask");
  });

  it("a person's new deal never carries the mark", async () => {
    await setMode("auto");
    const a = await sentQuote();
    await accept(a.token);
    const inserted = await asUser(member.id, async (q) =>
      (
        await one<{ amount_quote_id: string | null }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot, amount_quote_id) values ($1, 'חדשה', $2, $3, 90000, $4) returning amount_quote_id",
          [org, pipelineId, openStage, a.quote],
        )
      ).amount_quote_id,
    );
    expect(inserted).toBeNull();
    await setMode("ask");
  });
});
