import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown> & {
  quote?: { number: string; status: string };
  replaced?: { number: string } | null;
  status_page?: Record<string, unknown> & { state: string; number: string; draft_version: boolean };
};

/**
 * The owner's answers of 19 October 2026 to QUO-12b's questions:
 * (1) the link of a sent quote never answers not found (owner, 19 October 2026): it leads to the newest sent version and
 *     shows it in full while it is open or accepted (with the day it was accepted), else a status page without prices
 *     (declined, cancelled, expired); not found only for a revoked token, a draft, a deleted customer or closed pages;
 * (2) a line priced from a price list deleted since is kept in a new version with its price and the list's name;
 * (3) a copy names the lines it left out by id, so the new draft can add them back as free lines.
 */
describe("expired links, deleted price lists, lines a copy left out (QUO-12, QUO-15)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const newDraft = (q: Query) =>
    one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
      org,
      pipelineId,
      stageId,
      member.id,
    ]).then(async (deal) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'שיפוץ', $2) returning id", [org, deal.id])).id);
  const sentQuote = () =>
    asUser(member.id, async (q) => {
      const quote = await newDraft(q);
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 30000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const newVersion = (quote: string) => asUser(member.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, quote])).v);
  const send = (quote: string) => asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const page = (token: string) => asService(async (q) => (await one<{ p: Answer }>(q, "select public.quote_public($1) as p", [token])).p);
  const version = (token: string) => asService(async (q) => (await one<{ v: { number: string; fingerprint: string | null } }>(q, "select public.quote_public_version($1) as v", [token])).v);
  const decide = (token: string, fingerprint: string | null) =>
    asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'רונית לוי',
                      p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
            [token, fingerprint ?? "0".repeat(64)],
          )
        ).a,
    );
  const status = (quote: string) => asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quote])).s);
  const number = (quote: string) => asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.quotes where id = $1", [quote])).n);
  const setStatus = (quote: string, to: string) => asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [quote, to]));
  const pastValidity = (quote: string) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set valid_until = current_date - 2, quote_date = current_date - 30 where id = $1", [quote]);
    });

  beforeAll(async () => {
    owner = await createUser("qe-owner");
    org = await createOrg(owner.id, "עסק התוקף");
    member = await addMember(org, owner.id, "member", "qe-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"price_lists\": true, \"products\": true}' where organization_id = $1", [org]),
    );
  });

  it("(1) an expired quote's link shows its status page, with no prices or signing, until a newer version is sent", async () => {
    const v1 = await sentQuote();
    const t1 = await linkOf(v1);
    await setStatus(v1, "expired");
    const expired = await page(t1);
    expect(Object.keys(expired)).toEqual(["status_page"]);
    expect(Object.keys(expired.status_page!).sort()).toEqual(["business", "color", "draft_version", "logo", "number", "phone", "replaced", "state", "title", "valid_until"]);
    expect(expired.status_page).toMatchObject({ state: "expired", number: await number(v1), title: "שיפוץ", draft_version: false, replaced: null });
    expect(JSON.stringify(expired)).not.toContain(v1);
    // never decided or versioned through it
    expect(await version(t1)).toEqual({ number: await number(v1), fingerprint: null });
    expect(await decide(t1, null)).toEqual({ status: "closed" });
    expect(await status(v1)).toBe("expired");

    // a version is being prepared
    const v2 = await newVersion(v1);
    expect((await page(t1)).status_page).toMatchObject({ draft_version: true });
    // sent: the old link shows it at once, with or without a link of its own, and the customer decides it there
    await send(v2);
    expect(await page(t1)).toMatchObject({ quote: { number: await number(v2) }, replaced: { number: await number(v1) } });
    const shown = await version(t1);
    expect(shown.number).toBe(await number(v2));
    expect(await decide(t1, shown.fingerprint)).toEqual({ status: "accepted" });
    expect([await status(v1), await status(v2)]).toEqual(["expired", "accepted"]);
  });

  it("(1) every closed state shows its status page, an accepted quote shows in full; only a deleted customer is not found", async () => {
    const late = await sentQuote();
    const tl = await linkOf(late);
    await pastValidity(late);
    expect((await page(tl)).status_page).toMatchObject({ state: "expired", number: await number(late) });

    // declined, even past its date, says declined
    const declined = await sentQuote();
    const td = await linkOf(declined);
    await setStatus(declined, "rejected");
    await pastValidity(declined);
    expect((await page(td)).status_page).toMatchObject({ state: "rejected" });
    expect(JSON.stringify(await page(td))).not.toMatch(/30000|lines|total/);

    const cancelled = await sentQuote();
    const tc = await linkOf(cancelled);
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, cancelled]));
    expect((await page(tc)).status_page).toMatchObject({ state: "cancelled" });

    // accepted, even past its date: the full page with the day it was accepted, and no way to decide again
    const won = await sentQuote();
    const tw = await linkOf(won);
    const fw = (await version(tw)).fingerprint;
    expect(await decide(tw, fw)).toEqual({ status: "accepted" });
    await pastValidity(won);
    const wonPage = await page(tw);
    expect(wonPage.quote).toMatchObject({ number: await number(won), status: "accepted" });
    expect(wonPage.accepted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(wonPage.lines).toHaveLength(1);
    expect((await version(tw)).fingerprint).toBeNull();
    expect(await decide(tw, fw)).toEqual({ status: "already_decided", decision: "accepted" });

    // the business's phone on the status page: the document phone, else the business's
    await asUser(owner.id, (q) => q("update public.org_document_settings set phone = '03-1234567' where organization_id = $1", [org]));
    expect((await page(tc)).status_page).toMatchObject({ phone: "03-1234567" });

    const gone = await sentQuote();
    const tg = await linkOf(gone);
    await setStatus(gone, "expired");
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set customer_deleted_at = now() where id = $1", [gone]);
    });
    expect((await pgError(page(tg))).code).toBe("P0002");
  });

  it("(2) a line priced from a price list deleted since is kept in a new version with its price and the list's name", async () => {
    const product = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'ארון', 50000) returning id", [org])).id,
    );
    const list = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.price_lists (organization_id, name) values ($1, 'סיטונאים') returning id", [org])).id);
    const v1 = await asUser(member.id, async (q) => {
      const quote = await newDraft(q);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, product_id, name, quantity, unit_price_agorot, price_source, price_list_id) values ($1, $2, $3, 'ארון', 2, 42000, 'price_list', $4)",
        [org, quote, product, list],
      );
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });
    await asUser(owner.id, (q) => q("delete from public.price_lists where id = $1", [list]));
    const before = await asAdmin(async (q) => one<{ price_list_id: string | null; price_list_name: string }>(q, "select price_list_id, price_list_name from public.quote_lines where quote_id = $1", [v1]));
    expect(before).toEqual({ price_list_id: null, price_list_name: "סיטונאים" });

    const v2 = await newVersion(v1);
    expect(
      await asAdmin(async (q) => one(q, "select product_id, quantity::float as quantity, unit_price_agorot::int as price, price_source, price_list_id, price_list_name from public.quote_lines where quote_id = $1", [v2])),
    ).toEqual({ product_id: product, quantity: 2, price: 42000, price_source: "price_list", price_list_id: null, price_list_name: "סיטונאים" });

    // a person never writes such a line: not into the version, not by setting the copy marker by hand
    const addLine = (forge: boolean) =>
      asUser(member.id, async (q) => {
        if (forge) await q("select set_config('app.quote_version_copy', $1, true)", [v2]);
        await q(
          "insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'x', 100, 'price_list')",
          [org, v2, product],
        );
      });
    // the list's name is the server's to write (no column grant)
    expect(
      (await pgError(asUser(member.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot, price_list_name) values ($1, $2, 'x', 100, 'סיטונאים')", [org, v2])))).code,
    ).toBe("42501");
    expect((await pgError(addLine(false))).hint).toBe("quote_lines:price_list");
    expect((await pgError(addLine(true))).hint).toBe("quote_lines:price_list");
    // and it is sent as it is
    await send(v2);
    expect(await status(v2)).toBe("sent");
  });

  it("(3) a copy names the lines it left out by id; the new draft takes one back as the person's own free line", async () => {
    const product = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'מדף', 9000) returning id", [org])).id,
    );
    const source = await asUser(member.id, async (q) => {
      const quote = await newDraft(q);
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 30000)", [org, quote]);
      await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'מדף', 3, 9000, 'product')", [
        org,
        quote,
        product,
      ]);
      return quote;
    });
    const shelf = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.quote_lines where quote_id = $1 and name = 'מדף'", [source])).id);
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [product]));
    const copy = await asUser(member.id, async (q) =>
      (await one<{ r: { quote: string; skipped: string[]; skipped_lines: Array<{ id: string; name: string; kind: string }> } }>(q, "select public.quote_duplicate($1, $2) as r", [org, source])).r,
    );
    expect(copy.skipped).toEqual(["מדף"]);
    expect(copy.skipped_lines).toEqual([{ id: shelf, name: "מדף", kind: "item" }]);
    // the button's insert (addSkippedLineAction): a free line with its name, quantity and price, under the normal rules
    await asUser(member.id, (q) =>
      q("insert into public.quote_lines (organization_id, quote_id, kind, product_id, name, quantity, unit_price_agorot, price_source) values ($1, $2, 'item', null, 'מדף', 3, 9000, 'manual')", [
        org,
        copy.quote,
      ]),
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_lines where quote_id = $1 and product_id is null and name = 'מדף'", [copy.quote]))).toBe(1);
  });
});
