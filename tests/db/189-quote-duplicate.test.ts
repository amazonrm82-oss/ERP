import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Copy = { quote: string; skipped: string[]; discount_dropped: boolean };

/**
 * QUO-15 (duplicating only): public.quote_duplicate copies any quote, whatever its status, into a new draft on the same deal
 * and contact, with its lines, payment steps, terms and VAT mode; never its version chain or addendum link. A line the rules
 * no longer allow (a product that is no longer offerable, a flag the plan lost) is left out and named; the copy never fails
 * because of it.
 */
describe("duplicating a quote (QUO-15)", () => {
  let owner: U, member: U, viewer: U, outsider: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const all = { quotes: true, products: true, discounts: true, price_lists: true };
  const product = (name: string) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat, billing) values ($1, $2, 10000, 'taxable', false, 'one_time') returning id",
          [org, name],
        )
      ).id,
    );
  const newParent = () =>
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
  const duplicate = (quote: string, u: U = member) =>
    asUser(u.id, async (q) => (await one<{ c: Copy }>(q, "select public.quote_duplicate($1, $2) as c", [org, quote])).c);
  const quoteRow = (id: string) =>
    asAdmin((q) =>
      one<{
        status: string;
        title: string;
        deal_id: string | null;
        contact_id: string | null;
        previous_id: string | null;
        addendum_of: string | null;
        prices_include_vat: boolean;
        discount_bp: number | null;
        terms: string | null;
        notes: string | null;
        number_display: string | null;
        valid_until: string | null;
        owner_id: string;
        total_agorot: string;
      }>(
        q,
        "select status, title, deal_id, contact_id, previous_id, addendum_of, prices_include_vat, discount_bp, terms, notes, number_display, valid_until::text, owner_id, total_agorot::text from public.quotes where id = $1",
        [id],
      ),
    );
  const lines = (id: string) =>
    asAdmin(async (q) =>
      (
        await q<{ name: string; kind: string; quantity: string; unit_price_agorot: string; is_optional: boolean; optional_selected: boolean; product_id: string | null }>(
          "select name, kind, quantity::text, unit_price_agorot::text, is_optional, optional_selected, product_id from public.quote_lines where quote_id = $1 order by position, id",
          [id],
        )
      ).rows,
    );
  const steps = (id: string) =>
    asAdmin(async (q) => (await q<{ name: string; percent_bp: number }>("select name, percent_bp from public.quote_payment_steps where quote_id = $1 order by position, id", [id])).rows);

  beforeAll(async () => {
    owner = await createUser("qd-owner");
    org = await createOrg(owner.id, "עסק השכפול");
    member = await addMember(org, owner.id, "member", "qd-member");
    viewer = await addMember(org, owner.id, "viewer", "qd-viewer");
    outsider = await createUser("qd-outsider");
    await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await setFeatures(all);
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("copies a sent quote into a draft with lines, steps, terms and VAT mode; no number, chain or addendum link", async () => {
    const parent = await newParent();
    const p = await product("מטבח");
    const original = await asUser(member.id, async (q) => {
      const id = (
        await one<{ id: string }>(
          q,
          "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until, terms, notes, discount_bp) values ($1, 'שיפוץ מטבח', $2, $3, current_date + 10, 'תנאים', 'הערה', 500) returning id",
          [org, parent.deal, parent.contact],
        )
      ).id;
      // the business moves to prices with VAT later; the copy keeps the original's mode
      await q("insert into public.quote_lines (organization_id, quote_id, position, kind, name) values ($1, $2, 1, 'group', 'עבודות')", [org, id]);
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, quantity) values ($1, $2, 2, 'עבודה', 50000, 2)", [org, id]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, discount_bp, is_optional, optional_selected) values ($1, $2, 3, $3, 'מטבח', 10000, 1000, true, false)",
        [org, id, p],
      );
      await q("insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, milestone) values ($1, $2, 1, 'מקדמה', 3000, 'בחתימה'), ($1, $2, 2, 'סיום', 7000, 'במסירה')", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = true where organization_id = $1", [org]));
    try {
      const copy = await duplicate(original);
      expect(copy.skipped).toEqual([]);
      expect(copy.discount_dropped).toBe(false);
      const row = await quoteRow(copy.quote);
      const was = await quoteRow(original);
      expect(row).toMatchObject({
        status: "draft",
        title: "עותק של שיפוץ מטבח",
        deal_id: parent.deal,
        contact_id: parent.contact,
        previous_id: null,
        addendum_of: null,
        prices_include_vat: false,
        discount_bp: 500,
        terms: "תנאים",
        notes: "הערה",
        number_display: null,
        owner_id: member.id,
        total_agorot: was.total_agorot,
      });
      // validity keeps the original's span (10 days), counted from today
      expect(row.valid_until).toBe((await asAdmin(async (q) => one<{ d: string }>(q, "select (current_date + 10)::text as d"))).d);
      expect(await lines(copy.quote)).toEqual(await lines(original));
      expect(await steps(copy.quote)).toEqual([
        { name: "מקדמה", percent_bp: 3000 },
        { name: "סיום", percent_bp: 7000 },
      ]);
      // the original is untouched
      expect((await quoteRow(original)).status).toBe("sent");
    } finally {
      await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org]));
    }
  });

  it("copies a quote of any status: accepted, declined, cancelled, an addendum and a version", async () => {
    const parent = await newParent();
    const make = () =>
      asUser(member.id, async (q) => {
        const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [org, parent.deal, parent.contact])).id;
        await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 1000)", [org, id]);
        await q("select public.quote_send($1, $2)", [org, id]);
        return id;
      });
    const accepted = await make();
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [accepted]));
    const declined = await make();
    await asAdmin((q) => q("update public.quotes set status = 'rejected' where id = $1", [declined]));
    const cancelled = await make();
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, cancelled]));
    const addendum = await asUser(member.id, async (q) => (await one<{ a: string }>(q, "select public.quote_new_addendum($1, $2) as a", [org, accepted])).a);
    const versioned = await make();
    const version = await asUser(member.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, versioned])).v);
    const draft = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'טיוטה', $2) returning id", [org, parent.deal])).id);

    for (const source of [accepted, declined, cancelled, addendum, version, draft]) {
      const copy = await duplicate(source);
      expect(await quoteRow(copy.quote), source).toMatchObject({ status: "draft", previous_id: null, addendum_of: null, deal_id: parent.deal });
    }
    // the copy of a copy says so once more
    const first = await duplicate(accepted);
    expect((await quoteRow((await duplicate(first.quote)).quote)).title).toBe("עותק של עותק של הצעה");
  });

  it("leaves out lines the rules no longer allow and names them; the copy still happens", async () => {
    const parent = await newParent();
    const kept = await product("ארון");
    const archived = await product("מדף ישן");
    const inactive = await product("ידית");
    const original = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, discount_bp) values ($1, 'ריהוט', $2, 1000) returning id", [org, parent.deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot) values ($1, $2, 1, $3, 'ארון', 10000)", [org, id, kept]);
      await q("insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot) values ($1, $2, 2, $3, 'מדף ישן', 10000)", [org, id, archived]);
      await q("insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot) values ($1, $2, 3, $3, 'ידית', 10000)", [org, id, inactive]);
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, discount_bp) values ($1, $2, 4, 'הרכבה בהנחה', 5000, 1000)", [org, id]);
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot) values ($1, $2, 5, 'הובלה', 3000)", [org, id]);
      return id;
    });
    await asUser(owner.id, async (q) => {
      await q("update public.products set archived_at = now() where id = $1", [archived]);
      await q("update public.products set is_active = false where id = $1", [inactive]);
    });

    const copy = await duplicate(original);
    expect(copy.skipped).toEqual(["מדף ישן", "ידית"]);
    expect((await lines(copy.quote)).map((l) => l.name)).toEqual(["ארון", "הרכבה בהנחה", "הובלה"]);

    // the plan lost discounts: the discounted line and the document discount are left out, and said so
    await setFeatures({ ...all, discounts: false });
    try {
      const again = await duplicate(original);
      expect(again.skipped).toEqual(["מדף ישן", "ידית", "הרכבה בהנחה"]);
      expect(again.discount_dropped).toBe(true);
      expect((await quoteRow(again.quote)).discount_bp).toBeNull();
      // and lost products too: every product line is left out, the free lines stay
      await setFeatures({ ...all, discounts: false, products: false });
      const third = await duplicate(original);
      expect(third.skipped).toEqual(["ארון", "מדף ישן", "ידית", "הרכבה בהנחה"]);
      expect((await lines(third.quote)).map((l) => l.name)).toEqual(["הובלה"]);
    } finally {
      await setFeatures(all);
    }
  });

  it("an error that is not a refusal fails the whole copy; nothing is left behind", async () => {
    const parent = await newParent();
    const original = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'שבירה', $2) returning id", [org, parent.deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot) values ($1, $2, 1, 'רגילה', 1000), ($1, $2, 2, 'שוברת', 1000)", [org, id]);
      return id;
    });
    // a fault in the database (here a test trigger dividing by zero) is not a refusal of the line
    await asAdmin(async (q) => {
      await q("create schema if not exists qa_test_tmp");
      await q(`create or replace function qa_test_tmp.break_line() returns trigger language plpgsql as $f$
               begin if new.name = 'שוברת' then perform 1 / 0; end if; return new; end $f$`);
      await q("create trigger zz_qa_break_line before insert on public.quote_lines for each row execute function qa_test_tmp.break_line()");
    });
    try {
      expect((await pgError(duplicate(original))).code).toBe("22012");
    } finally {
      await asAdmin(async (q) => {
        await q("drop trigger zz_qa_break_line on public.quote_lines");
        await q("drop schema qa_test_tmp cascade");
      });
    }
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quotes where deal_id = $1", [parent.deal])).c)).toBe(1);
    // without the fault the same quote copies whole
    expect((await duplicate(original)).skipped).toEqual([]);
  });

  it("is refused without the right to edit the record, without the plan, and across businesses", async () => {
    const parent = await newParent();
    const original = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, parent.deal])).id);
    expect((await pgError(duplicate(original, viewer))).code).toBe("42501");
    expect((await pgError(duplicate(original, outsider))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.quote_duplicate($1, $2)", [org, original])))).code).toBe("42501");
    // a deal in the bin cannot be quoted
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [parent.deal]));
    expect((await pgError(duplicate(original))).code).toBe("42501");
    await asAdmin((q) => q("update public.deals set deleted_at = null where id = $1", [parent.deal]));

    await setFeatures({ ...all, quotes: false });
    try {
      expect((await pgError(duplicate(original))).hint).toBe("feature:quotes");
    } finally {
      await setFeatures(all);
    }
    const n = await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quotes where deal_id = $1", [parent.deal])).c);
    expect(n).toBe(1);
  });

  it("only signed-in people may call it", async () => {
    for (const [role, allowed] of [
      ["anon", false],
      ["authenticated", true],
    ] as const) {
      expect(
        await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_duplicate(uuid, uuid)', 'execute') as c", [role])).c),
        role,
      ).toBe(allowed);
    }
  });
});
