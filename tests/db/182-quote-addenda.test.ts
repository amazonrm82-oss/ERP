import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = {
  quote: { number: string; status: string; title: string };
  addendum: { number: string } | null;
  addenda: { number: string; title: string; total_agorot: number }[];
};

/**
 * GAP-10: an addendum to an accepted quote is an ordinary quote with addendum_of pointing at the original, made empty by
 * public.quote_new_addendum (definer; whoever may edit the record, quotes flag; the original accepted and not an addendum).
 * It has its own number, link, decision and versions, and is never a version itself. The customer's page names the original,
 * and the original's page lists its accepted addenda (number, title, total; no ids).
 */
describe("addenda to an accepted quote (GAP-10)", () => {
  let owner: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const newDeal = () =>
    asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'שיפוץ', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stageId,
          contact,
          member.id,
        ])
      ).id;
      return { deal, contact };
    });
  const draft = (parent: { deal: string; contact: string }, title = "שיפוץ מטבח") =>
    asUser(member.id, async (q) => {
      const id = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until) values ($1, $2, $3, $4, current_date + 14) returning id", [
          org,
          title,
          parent.deal,
          parent.contact,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, id]);
      return id;
    });
  const send = (quote: string) => asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const accept = (quote: string) => asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
  const addendum = (quote: string, u: U = member) =>
    asUser(u.id, async (q) => (await one<{ a: string }>(q, "select public.quote_new_addendum($1, $2) as a", [org, quote])).a);
  const row = (quote: string) =>
    asAdmin((q) =>
      one<{ status: string; addendum_of: string | null; previous_id: string | null; deal_id: string; contact_id: string; title: string; number_display: string | null; valid_until: string | null }>(
        q,
        "select status, addendum_of, previous_id, deal_id, contact_id, title, number_display, valid_until::text from public.quotes where id = $1",
        [quote],
      ),
    );
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const page = (token: string) => asService(async (q) => (await one<{ p: Page }>(q, "select public.quote_public($1) as p", [token])).p);
  const accepted = async () => {
    const parent = await newDeal();
    const quote = await draft(parent);
    await send(quote);
    await accept(quote);
    return { quote, parent };
  };

  beforeAll(async () => {
    owner = await createUser("qa-owner");
    org = await createOrg(owner.id, "עסק התוספות");
    member = await addMember(org, owner.id, "member", "qa-member");
    viewer = await addMember(org, owner.id, "viewer", "qa-viewer");
    outsider = await createUser("qa-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("an addendum is an empty draft on the same deal and contact, with its own number, link and decision; the pages name each other", async () => {
    const { quote: original, parent } = await accepted();
    const t1 = await linkOf(original);
    const n1 = (await row(original)).number_display!;

    const a = await addendum(original);
    expect(await row(a)).toMatchObject({ status: "draft", addendum_of: original, previous_id: null, deal_id: parent.deal, contact_id: parent.contact, title: "תוספת: שיפוץ מטבח" });
    // the original's validity span (14 days), from today
    expect((await row(a)).valid_until).toBe((await asAdmin(async (q) => one<{ d: string }>(q, "select (current_date + 14)::text as d"))).d);
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quote_lines where quote_id = $1", [a])).c)).toBe(0);

    await asUser(member.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'מדף נוסף', 20000)", [org, a]));
    await send(a);
    const na = (await row(a)).number_display!;
    expect(na).not.toBe(n1);
    const ta = await linkOf(a);
    // the addendum's page names the original; the original's link still shows the original (an addendum is not a version)
    const shown = await page(ta);
    expect(shown.quote.number).toBe(na);
    expect(shown.addendum).toEqual({ number: n1 });
    expect(shown.addenda).toEqual([]);
    expect((await page(t1)).quote.number).toBe(n1);
    expect((await page(t1)).addenda).toEqual([]);

    // once the customer accepts it, the original's page lists it: number, title and total only
    await accept(a);
    const listed = (await page(t1)).addenda;
    expect(listed).toEqual([{ number: na, title: "תוספת: שיפוץ מטבח", total_agorot: 23600 }]);
    expect(JSON.stringify(await page(t1))).not.toContain(a);
    expect(JSON.stringify(await page(ta))).not.toContain(original);

    // a second addendum is made to the original too
    expect((await row(await addendum(original))).addendum_of).toBe(original);
  });

  it("is refused for a quote that is not accepted, for an addendum, without the right or the plan", async () => {
    const parent = await newDeal();
    const d = await draft(parent);
    expect((await pgError(addendum(d))).hint).toBe("quote_addendum:not_accepted");
    await send(d);
    expect((await pgError(addendum(d))).hint).toBe("quote_addendum:not_accepted");
    await asAdmin((q) => q("update public.quotes set status = 'rejected' where id = $1", [d]));
    expect((await pgError(addendum(d))).hint).toBe("quote_addendum:not_accepted");

    const { quote: original } = await accepted();
    const a = await addendum(original);
    await asUser(member.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עוד', 100)", [org, a]));
    await send(a);
    await accept(a);
    // no addendum to an addendum: further work is another addendum to the original
    expect((await pgError(addendum(a))).hint).toBe("quote_addendum:of_addendum");

    expect((await pgError(addendum(original, viewer))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, async (q) => q("select public.quote_new_addendum($1, $2)", [otherOrg, original])))).code).toBe("42501");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(addendum(original))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
  });

  it("holds for every writer: no person writes addendum_of, no other original, deal or business, and it never moves", async () => {
    const { quote: original, parent } = await accepted();
    const { quote: other } = await accepted();
    // a person cannot write the column at all
    expect(
      (await pgError(asUser(member.id, (q) => q("insert into public.quotes (organization_id, title, deal_id, addendum_of) values ($1, 'x', $2, $3)", [org, parent.deal, original])))).code,
    ).toBe("42501");
    // the server: same deal and contact, an accepted original that is no addendum, inside the business
    const insert = (deal: string, contact: string | null, of: string, orgId = org) =>
      asAdmin((q) => q("insert into public.quotes (organization_id, title, deal_id, contact_id, addendum_of) values ($1, 'x', $2, $3, $4)", [orgId, deal, contact, of]));
    const elsewhere = await newDeal();
    expect((await pgError(insert(elsewhere.deal, elsewhere.contact, original))).hint).toBe("quote_addendum:parent");
    // a sent (not accepted) original, and an addendum as the original, are refused for the server too
    const sentOnly = await draft(parent);
    await send(sentOnly);
    expect((await pgError(insert(parent.deal, parent.contact, sentOnly))).hint).toBe("quote_addendum:not_accepted");
    const first = await addendum(original);
    await asUser(member.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עוד', 100)", [org, first]));
    await send(first);
    await accept(first);
    expect((await pgError(insert(parent.deal, parent.contact, first))).hint).toBe("quote_addendum:of_addendum");
    const otherDeal = await defaultPipeline(otherOrg).then((p) =>
      asUser(outsider.id, async (q) =>
        (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'x', $2, $3, $4) returning id", [otherOrg, p.pipelineId, p.stages[0].id, outsider.id])).id,
      ),
    );
    expect((await pgError(insert(otherDeal, null, original, otherOrg))).code).toBe("23503");
    // it never moves to another original
    const a = await addendum(original);
    expect((await pgError(asAdmin((q) => q("update public.quotes set addendum_of = $2 where id = $1", [a, other]))))).toMatchObject({ hint: "quote_addendum:fixed" });
    expect((await row(a)).addendum_of).toBe(original);
  });

  it("judges the row as stored: an original with no contact gets no addendum with the contact its deal has now", async () => {
    const deal = await asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'בלי איש קשר', $2, $3, $4) returning id", [org, pipelineId, stageId, member.id])).id,
    );
    const original = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, id]);
      return id;
    });
    await send(original);
    await accept(original);
    expect((await row(original)).contact_id).toBeNull();
    // the deal has a contact now; quotes_check would fill it into the addendum, which the original does not have
    await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'חדש', $2) returning id", [org, member.id])).id;
      await q("update public.deals set contact_id = $2 where id = $1", [deal, contact]);
    });
    expect((await pgError(addendum(original))).hint).toBe("quote_addendum:parent");
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quotes where addendum_of = $1", [original])).c)).toBe(0);
  });

  it("a version of an addendum stays an addendum of the same original, and an addendum is never treated as a version", async () => {
    const { quote: original } = await accepted();
    const t1 = await linkOf(original);
    const a = await addendum(original);
    await asUser(member.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'מדף', 20000)", [org, a]));
    await send(a);
    const ta = await linkOf(a);
    const a2 = await asUser(member.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, a])).v);
    expect(await row(a2)).toMatchObject({ addendum_of: original, previous_id: a });
    await send(a2);
    await linkOf(a2);
    // the addendum's old link shows its newer version; the original's link is unaffected
    expect((await page(ta)).quote.number).toBe((await row(a2)).number_display);
    expect((await page(ta)).addendum).toEqual({ number: (await row(original)).number_display });
    expect((await page(t1)).quote.number).toBe((await row(original)).number_display);
    // a version must carry its previous quote's addendum_of, for every writer
    const plain = await asAdmin(async (q) => (await one<{ d: string; c: string }>(q, "select deal_id as d, contact_id as c from public.quotes where id = $1", [a2])));
    expect(
      (await pgError(asAdmin((q) => q("insert into public.quotes (organization_id, title, deal_id, contact_id, previous_id) values ($1, 'x', $2, $3, $4)", [org, plain.d, plain.c, a2])))),
    ).toMatchObject({ hint: "quote_addendum:version" });
  });

  it("a merge moves an addendum with its original, and keeps the link", async () => {
    // quotes on a contact only (no deal), so a contact merge moves them
    const [keep, dup] = await asUser(member.id, async (q) => [
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נשאר', $2) returning id", [org, member.id])).id,
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'כפול', $2) returning id", [org, member.id])).id,
    ]);
    const original = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, dup])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, id]);
      return id;
    });
    await send(original);
    await accept(original);
    const a = await addendum(original);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect(await row(original)).toMatchObject({ contact_id: keep });
    expect(await row(a)).toMatchObject({ contact_id: keep, addendum_of: original });
  });

  it("the quotes report counts an addendum as a quote", async () => {
    const before = await asUser(owner.id, async (q) => (await one<{ r: { totals: { sent: number } } }>(q, "select public.report_quotes($1, now() - interval '1 day', now() + interval '1 day') as r", [org])).r.totals.sent);
    const { quote: original } = await accepted();
    const a = await addendum(original);
    await asUser(member.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'מדף', 20000)", [org, a]));
    await send(a);
    const after = await asUser(owner.id, async (q) => (await one<{ r: { totals: { sent: number } } }>(q, "select public.report_quotes($1, now() - interval '1 day', now() + interval '1 day') as r", [org])).r.totals.sent);
    expect(after).toBe(before + 2);
  });

  it("only signed-in people may make an addendum", async () => {
    for (const [role, expected] of [
      ["anon", false],
      ["authenticated", true],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_new_addendum(uuid, uuid)', 'execute') as c", [role])).c), role).toBe(
        expected,
      );
    }
  });
});
