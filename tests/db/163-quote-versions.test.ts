import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = { quote: { number: string; title: string }; replaced: { number: string } | null };

/**
 * QUO-12 (owner, 18 October 2026): editing a sent quote makes a new version, a draft copy with its lines and payment steps
 * that takes a new number when sent. A quote has at most one newer version, made only from a sent quote; a quote that was
 * sent never returns to draft. The old customer link shows the newest version once that one is sent and has a link.
 */
describe("quote versions (QUO-12)", () => {
  let owner: U, member: U, viewer: U, other: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const sentQuote = (opts: { validUntil?: string } = {}) =>
    asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          member.id,
        ])
      ).id;
      const quote = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, notes, valid_until) values ($1, 'שיפוץ', $2, 'הערות', $3) returning id", [
          org,
          deal,
          opts.validUntil ?? null,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, kind, name, position) values ($1, $2, 'group', 'חדר', 1)", [org, quote]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, name, description, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 'פירוט', 3, 12345, 2)",
        [org, quote],
      );
      await q("insert into public.quote_payment_steps (organization_id, quote_id, name, percent_bp, milestone, position) values ($1, $2, 'מקדמה', 4000, 'בחתימה', 0)", [org, quote]);
      await q("insert into public.quote_payment_steps (organization_id, quote_id, name, percent_bp, milestone, position) values ($1, $2, 'יתרה', 6000, 'במסירה', 1)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });
  const newVersion = (u: U, quote: string) => asUser(u.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, quote])).v);
  const send = (quote: string) => asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const page = (token: string) => asService(async (q) => (await one<{ p: Page }>(q, "select public.quote_public($1) as p", [token])).p);
  const row = (quote: string) =>
    asAdmin(async (q) =>
      one<{ status: string; number_display: string | null; previous_id: string | null; prices_include_vat: boolean; valid_until: string | null; quote_date: string; deal_id: string; notes: string }>(
        q,
        "select status, number_display, previous_id, prices_include_vat, valid_until::text, quote_date::text, deal_id, notes from public.quotes where id = $1",
        [quote],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("qv-owner");
    org = await createOrg(owner.id, "עסק הגרסאות");
    member = await addMember(org, owner.id, "member", "qv-member");
    viewer = await addMember(org, owner.id, "viewer", "qv-viewer");
    other = await addMember(org, owner.id, "member", "qv-other");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("a new version is a draft copy of the quote, its lines and its payment steps, with no number until it is sent", async () => {
    const original = await sentQuote();
    // the business changes its VAT mode after sending: the version keeps the original's
    await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = true where organization_id = $1", [org]));
    try {
      const version = await newVersion(member, original);
      const [o, v] = [await row(original), await row(version)];
      expect(v).toMatchObject({ status: "draft", number_display: null, previous_id: original, deal_id: o.deal_id, notes: "הערות", prices_include_vat: o.prices_include_vat });
      const lines = (quote: string) =>
        asAdmin(async (q) =>
          (await q("select position, kind, name, description, quantity::text, unit_price_agorot::text, total_agorot::text from public.quote_lines where quote_id = $1 order by position", [quote])).rows,
        );
      expect(await lines(version)).toEqual(await lines(original));
      const steps = (quote: string) =>
        asAdmin(async (q) => (await q("select position, name, percent_bp, due_date, milestone from public.quote_payment_steps where quote_id = $1 order by position", [quote])).rows);
      expect(await steps(version)).toEqual(await steps(original));
      // sending it takes the next number; the original keeps its own and stays sent
      await send(version);
      const [o2, v2] = [await row(original), await row(version)];
      expect(v2.status).toBe("sent");
      expect(v2.number_display).not.toBeNull();
      expect(v2.number_display).not.toBe(o2.number_display);
      expect(o2).toMatchObject({ status: "sent", number_display: o.number_display });
    } finally {
      await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org]));
    }
  });

  it("a validity date that has passed keeps its length from today", async () => {
    const original = await sentQuote({ validUntil: "2099-01-01" });
    // arranged as if it was sent 40 days ago for 30 days (triggers off: quotes_check keeps a quote's date)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set quote_date = current_date - 40, valid_until = current_date - 10 where id = $1", [original]);
    });
    const v = await row(await newVersion(member, original));
    expect(Date.parse(v.valid_until!) - Date.parse(v.quote_date)).toBe(30 * 86400000);
  });

  it("only one newer version per quote, only from a sent and undecided quote, only by whoever may edit it", async () => {
    const original = await sentQuote();
    expect((await pgError(newVersion(viewer, original))).code).toBe("42501");
    expect((await pgError(newVersion(other, original))).code).toBe("42501");
    const version = await newVersion(member, original);
    expect((await pgError(newVersion(member, original))).hint).toBe("quote_version:exists");
    // a draft is edited, not versioned
    expect((await pgError(newVersion(member, version))).hint).toBe("quote_version:draft");
    // deleting the draft version frees the original again
    expect(await asUser(member.id, async (q) => (await q("delete from public.quotes where id = $1", [version])).rowCount)).toBe(1);
    const again = await newVersion(member, original);
    expect((await row(again)).previous_id).toBe(original);
    // a version of a version continues the chain
    await send(again);
    const third = await newVersion(member, again);
    expect((await row(third)).previous_id).toBe(again);
    // a decided or closed quote is locked
    for (const status of ["accepted", "rejected", "expired", "cancelled"]) {
      const closed = await sentQuote();
      await asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [closed, status]));
      expect((await pgError(newVersion(member, closed))).hint, status).toBe("quote_version:closed");
    }
    // the plan without quotes
    const noPlan = await sentQuote();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(newVersion(member, noPlan))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
  });

  it("nobody but the server sets the chain, and the chain never moves", async () => {
    const original = await sentQuote();
    const deal = await asAdmin(async (q) => (await one<{ d: string }>(q, "select deal_id as d from public.quotes where id = $1", [original])).d);
    // no client grant on previous_id
    expect((await pgError(asUser(member.id, (q) => q("insert into public.quotes (organization_id, title, deal_id, previous_id) values ($1, 'x', $2, $3)", [org, deal, original])))).code).toBe(
      "42501",
    );
    const version = await newVersion(member, original);
    expect((await pgError(asUser(member.id, (q) => q("update public.quotes set previous_id = null where id = $1", [version])))).code).toBe("42501");
    // the guard holds for the server too: no move to another quote, no version of a draft, no version on another deal
    const elsewhere = await sentQuote();
    expect((await pgError(asAdmin((q) => q("update public.quotes set previous_id = $2 where id = $1", [version, elsewhere]))))).toMatchObject({ hint: "quote_version:fixed" });
    expect(
      (await pgError(asAdmin((q) => q("insert into public.quotes (organization_id, title, deal_id, previous_id) values ($1, 'x', $2, $3)", [org, deal, version])))),
    ).toMatchObject({ hint: "quote_version:not_sent" });
    const otherDeal = await asAdmin(async (q) => (await one<{ d: string }>(q, "select deal_id as d from public.quotes where id = $1", [elsewhere])).d);
    await asAdmin((q) => q("delete from public.quotes where id = $1", [version]));
    expect(
      (await pgError(asAdmin((q) => q("insert into public.quotes (organization_id, title, deal_id, previous_id) values ($1, 'x', $2, $3)", [org, otherDeal, original])))),
    ).toMatchObject({ hint: "quote_version:parent" });
  });

  it("a quote that was sent never returns to draft, for any writer", async () => {
    const original = await sentQuote();
    expect((await pgError(asAdmin((q) => q("update public.quotes set status = 'draft' where id = $1", [original]))))).toMatchObject({ hint: "quote:no_redraft" });
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [original]));
    expect((await pgError(asAdmin((q) => q("update public.quotes set status = 'draft' where id = $1", [original]))))).toMatchObject({ hint: "quote:no_redraft" });
    // and a person has no way to write the status at all
    expect((await pgError(asUser(member.id, (q) => q("update public.quotes set status = 'draft' where id = $1", [original])))).code).toBe("42501");
  });

  it("the old customer link shows the newest version once it is sent and has a link, and names the number it was made for", async () => {
    const v1 = await sentQuote();
    const n1 = (await row(v1)).number_display!;
    const t1 = await linkOf(v1);
    expect(await page(t1)).toMatchObject({ quote: { number: n1 }, replaced: null });

    const v2 = await newVersion(member, v1);
    // a draft version changes nothing on the page
    expect(await page(t1)).toMatchObject({ quote: { number: n1 }, replaced: null });
    await send(v2);
    const n2 = (await row(v2)).number_display!;
    // sent but without a link of its own: still the original
    expect(await page(t1)).toMatchObject({ quote: { number: n1 }, replaced: null });
    const t2 = await linkOf(v2);
    expect(await page(t1)).toMatchObject({ quote: { number: n2 }, replaced: { number: n1 } });
    expect(await page(t2)).toMatchObject({ quote: { number: n2 }, replaced: null });
    // the answer on an old link holds exactly the page's keys, and `replaced` only the earlier number: no ids
    const shown = (await page(t1)) as unknown as Record<string, unknown> & { replaced: Record<string, unknown> };
    expect(Object.keys(shown).sort()).toEqual(["brand", "built_with", "business", "customer", "design", "lines", "quote", "replaced", "schedule"]);
    expect(Object.keys(shown.replaced)).toEqual(["number"]);
    expect(JSON.stringify(shown)).not.toContain(v1);
    expect(JSON.stringify(shown)).not.toContain(v2);

    // a third version with a link: both old links show it
    const v3 = await newVersion(member, v2);
    await send(v3);
    const n3 = (await row(v3)).number_display!;
    const t3 = await linkOf(v3);
    expect(await page(t1)).toMatchObject({ quote: { number: n3 }, replaced: { number: n1 } });
    expect(await page(t2)).toMatchObject({ quote: { number: n3 }, replaced: { number: n2 } });

    // the newest version's link turned off, or the newest version cancelled: the old links fall back along the chain
    await asUser(member.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, v3]));
    expect(await page(t1)).toMatchObject({ quote: { number: n2 }, replaced: { number: n1 } });
    await asAdmin((q) => q("update public.quotes set status = 'cancelled' where id = $1", [v2]));
    expect(await page(t1)).toMatchObject({ quote: { number: n1 }, replaced: null });
    expect((await pgError(page(t2))).code).toBe("P0002");
    void t3;
  });

  it("the copy is all or nothing: a line that can no longer be offered stops the version", async () => {
    const product = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'ארון', 50000) returning id", [org])).id,
    );
    const original = await asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          member.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'ארונות', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'ארון', 50000, 'product')", [
        org,
        quote,
        product,
      ]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });
    await asUser(owner.id, (q) => q("update public.products set is_active = false where id = $1", [product]));
    expect((await pgError(newVersion(member, original))).hint).toBe("quote_lines:product");
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where previous_id = $1", [original]))).toBe(0);
  });

  it("making a version is no one else's: the function is granted to signed-in users only", async () => {
    for (const [role, expected] of [
      ["anon", false],
      ["authenticated", true],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_new_version(uuid, uuid)', 'execute') as c", [role])).c), role).toBe(
        expected,
      );
    }
  });
});
