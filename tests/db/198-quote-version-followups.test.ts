import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = {
  quote: { number: string; status: string };
  replaced: { number: string } | null;
  draft_version: boolean;
  lines: Array<{ name: string; unit_price_agorot: number }>;
};

/**
 * QUO-12 follow-ups (owner's answers of 19 October 2026):
 * (5) a version keeps a line whose product left the catalog as it is (the screen marks it); only quote_new_version's copy
 *     may add such a line, never a person; the draft may be sent and the customer sees the line as any other;
 * (6) a version may be made from a declined or expired quote too, never from an accepted or cancelled one; only an
 *     accepted previous quote stops a version from being sent;
 * (7) the customer's page says a newer version is being prepared while a draft version follows the quote shown.
 */
describe("quote versions, the owner's answers of 19 October (QUO-12)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const product = (name: string) =>
    asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, $2, 50000) returning id", [org, name])).id);
  const sentQuote = (productId: string | null = null) =>
    asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          member.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'שיפוץ', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 30000)", [org, quote]);
      if (productId) {
        await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'ארון אלון', 50000, 'product')", [
          org,
          quote,
          productId,
        ]);
      }
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const newVersion = (quote: string) => asUser(member.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, quote])).v);
  const send = (quote: string) => asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const page = (token: string) => asService(async (q) => (await one<{ p: Page }>(q, "select public.quote_public($1) as p", [token])).p);
  const status = (quote: string) => asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quote])).s);
  const number = (quote: string) => asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.quotes where id = $1", [quote])).n);
  const setStatus = (quote: string, to: string) => asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [quote, to]));

  beforeAll(async () => {
    owner = await createUser("qf-owner");
    org = await createOrg(owner.id, "עסק הגרסאות המעודכן");
    member = await addMember(org, owner.id, "member", "qf-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("(5) a version copies a line whose product was archived or switched off as it is, and it can be sent", async () => {
    const archived = await product("ארון אלון");
    const off = await product("מדף");
    const v1 = await sentQuote(archived);
    await asUser(owner.id, async (q) => {
      await q("update public.products set archived_at = now() where id = $1", [archived]);
      await q("update public.products set is_active = false where id = $1", [off]);
    });
    const t1 = await linkOf(v1);
    const v2 = await newVersion(v1);
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_lines where quote_id = $1 and product_id = $2 and name = 'ארון אלון' and unit_price_agorot = 50000", [v2, archived]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [v2]))).toBe(2);

    // a person never adds a product that left the catalog: not to the version, not to another draft, and not by naming the
    // draft in the copy setting themselves (only a product the previous version already had could pass, and only by the copy)
    const addLine = (quote: string, productId: string, forge = false) =>
      asUser(member.id, async (q) => {
        if (forge) await q("select set_config('app.quote_version_copy', $1, true)", [quote]);
        await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'x', 100, 'product')", [
          org,
          quote,
          productId,
        ]);
      });
    expect((await pgError(addLine(v2, archived))).hint).toBe("quote_lines:product");
    expect((await pgError(addLine(v2, off))).hint).toBe("quote_lines:product");
    expect((await pgError(addLine(v2, off, true))).hint).toBe("quote_lines:product");
    const plain = await asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          member.id,
        ])
      ).id;
      return (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'אחרת', $2) returning id", [org, deal])).id;
    });
    expect((await pgError(addLine(plain, archived, true))).hint).toBe("quote_lines:product");
    // the copy setting does not outlive the copy: right after quote_new_version, in the same transaction, the person still
    // cannot add the archived product to the new draft
    const again = await sentQuote();
    await asAdmin(async (q) => {
      // a quote whose sent line already names the archived product (the product was offerable when it was added)
      await q("set local session_replication_role = replica");
      await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source, total_agorot) values ($1, $2, $3, 'ארון אלון', 50000, 'product', 50000)", [
        org,
        again,
        archived,
      ]);
    });
    const sameTransaction = await pgError(
      asUser(member.id, async (q) => {
        const draft = (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, again])).v;
        await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'x', 100, 'product')", [
          org,
          draft,
          archived,
        ]);
      }),
    );
    expect(sameTransaction.hint).toBe("quote_lines:product");

    // sent as it is; the customer's page shows the line like any other
    await send(v2);
    await linkOf(v2);
    const shown = await page(t1);
    expect(shown.quote.number).toBe(await number(v2));
    expect(shown.lines.map((l) => [l.name, l.unit_price_agorot])).toEqual(
      expect.arrayContaining([
        ["ארון אלון", 50000],
        ["עבודה", 30000],
      ]),
    );
  });

  it("(6) a version is made from a declined or expired quote and sent; never from an accepted or cancelled one", async () => {
    // declined: the version is sent, and the customer's old link shows it once it has a link of its own
    const declined = await sentQuote();
    const td = await linkOf(declined);
    await setStatus(declined, "rejected");
    expect((await page(td)).quote).toMatchObject({ number: await number(declined), status: "rejected" });
    const dv = await newVersion(declined);
    expect((await page(td)).draft_version).toBe(true);
    await send(dv);
    expect(await status(dv)).toBe("sent");
    // sent but no link of its own yet: the old link closes, never showing the declined quote as the offer
    expect((await pgError(page(td))).code).toBe("P0002");
    await linkOf(dv);
    expect(await page(td)).toMatchObject({ quote: { number: await number(dv), status: "viewed" }, replaced: { number: await number(declined) }, draft_version: false });
    // the declined quote stays declined; it is superseded now
    expect(await status(declined)).toBe("rejected");
    expect((await pgError(setStatus(declined, "accepted"))).hint).toBe("quote:superseded");

    // a draft version made before the customer declined may be sent after it
    const early = await sentQuote();
    const ev = await newVersion(early);
    await setStatus(early, "rejected");
    await send(ev);
    expect(await status(ev)).toBe("sent");

    // expired
    const expired = await sentQuote();
    await setStatus(expired, "expired");
    const xv = await newVersion(expired);
    await send(xv);
    expect(await status(xv)).toBe("sent");

    // accepted or cancelled: no version; and an accepted previous quote still stops a draft version from being sent
    for (const to of ["accepted", "cancelled"]) {
      const closed = await sentQuote();
      await setStatus(closed, to);
      expect((await pgError(newVersion(closed))).hint, to).toBe("quote_version:closed");
    }
    const won = await sentQuote();
    const wv = await newVersion(won);
    await setStatus(won, "accepted");
    expect((await pgError(send(wv))).hint).toBe("quote_version:previous_decided");
    // and the guard's own insert rule: a version only from a sent, viewed, declined or expired quote
    const draft = await asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          member.id,
        ])
      ).id;
      return (await one<{ id: string; deal_id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'טיוטה', $2) returning id, deal_id", [org, deal]));
    });
    expect(
      (await pgError(asAdmin((q) => q("insert into public.quotes (organization_id, title, deal_id, previous_id) values ($1, 'x', $2, $3)", [org, draft.deal_id, draft.id])))).hint,
    ).toBe("quote_version:not_sent");
  });

  it("(7) the old link keeps the sent quote, saying an updated version is being prepared, until the version is sent", async () => {
    const v1 = await sentQuote();
    const t1 = await linkOf(v1);
    expect((await page(t1)).draft_version).toBe(false);
    const v2 = await newVersion(v1);
    const before = await page(t1);
    expect(before).toMatchObject({ quote: { number: await number(v1) }, replaced: null, draft_version: true });
    // nothing of the draft: no id, no title of its own
    expect(JSON.stringify(before)).not.toContain(v2);
    await send(v2);
    await linkOf(v2);
    expect(await page(t1)).toMatchObject({ quote: { number: await number(v2) }, replaced: { number: await number(v1) }, draft_version: false });
    // a draft after the version shown is announced on both links
    const v3 = await newVersion(v2);
    expect(await page(t1)).toMatchObject({ quote: { number: await number(v2) }, draft_version: true });
    // deleting the draft takes the notice away
    await asUser(member.id, (q) => q("delete from public.quotes where id = $1", [v3]));
    expect((await page(t1)).draft_version).toBe(false);
  });
});
