import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-04: quote templates. Members read them; owners and admins of a writable business write them;
 * a new one needs the plan flag 'quotes' and counts against max_quote_templates; 200 lines; names are
 * unique per business; quote_template_save makes one from a quote in one transaction.
 */
describe("quote templates (QUO-04)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newTemplate = (u: U, name: string, extra: Record<string, unknown> = {}) =>
    run(u, async (q) => {
      const keys = Object.keys(extra);
      return (
        await q<{ id: string; created_by: string | null }>(
          `insert into public.quote_templates (organization_id, name${keys.map((k) => `, ${k}`).join("")}) values ($1, $2${keys.map((_, i) => `, $${i + 3}`).join("")}) returning id, created_by`,
          [org, name, ...Object.values(extra)],
        )
      ).rows[0];
    });
  const newLine = (u: U, template: string, values: Record<string, unknown>) =>
    run(u, async (q) => {
      const keys = Object.keys(values);
      return (
        await q<{ id: string }>(
          `insert into public.quote_template_lines (organization_id, template_id, ${keys.join(", ")}) values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")}) returning id`,
          [org, template, ...Object.values(values)],
        )
      ).rows[0].id;
    });
  const setOverrides = (column: "feature_overrides" | "limit_overrides", value: Record<string, unknown>) =>
    asAdmin((q) => q(`update public.subscriptions set ${column} = $2 where organization_id = $1`, [org, JSON.stringify(value)]));

  beforeAll(async () => {
    owner = await createUser("qt-owner");
    org = await createOrg(owner.id, "עסק התבניות");
    admin = await addMember(org, owner.id, "admin", "qt-admin");
    member = await addMember(org, owner.id, "member", "qt-member");
    viewer = await addMember(org, owner.id, "viewer", "qt-viewer");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
  });

  it("members read templates; only owners and admins write them; the server sets the author", async () => {
    const made = await newTemplate(admin, "שיפוץ מטבח", { notes: "הערה", terms: "תנאים" });
    expect(made.created_by).toBe(admin.id);
    await newLine(admin, made.id, { name: "עבודה", unit_price_agorot: 10000 });
    for (const u of [owner, admin, member, viewer]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quote_templates where id = $1", [made.id])), u.email).toBe(1);
      expect(await run(u, (q) => count(q, "select 1 from public.quote_template_lines where template_id = $1", [made.id])), u.email).toBe(1);
    }
    for (const u of [member, viewer]) {
      expect((await pgError(newTemplate(u, `של ${u.email}`))).code, u.email).toBe("42501");
      expect((await pgError(newLine(u, made.id, { name: "x", unit_price_agorot: 1 }))).code, u.email).toBe("42501");
      expect(await run(u, async (q) => (await q("update public.quote_templates set name = 'x' where id = $1", [made.id])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("update public.quote_template_lines set name = 'x' where template_id = $1", [made.id])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quote_template_lines where template_id = $1", [made.id])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quote_templates where id = $1", [made.id])).rowCount), u.email).toBe(0);
      // without a WHERE clause too
      expect(await run(u, async (q) => (await q("update public.quote_template_lines set name = 'x'")).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quote_templates")).rowCount), u.email).toBe(0);
    }
    expect(await run(owner, async (q) => (await q("update public.quote_templates set name = 'שיפוץ מטבח מלא' where id = $1", [made.id])).rowCount)).toBe(1);
    expect(await run(owner, async (q) => (await q("update public.quote_template_lines set quantity = 2 where template_id = $1", [made.id])).rowCount)).toBe(1);
  });

  it("a read-only business writes no templates", async () => {
    const made = await newTemplate(admin, "לפני קריאה בלבד");
    const line = await newLine(admin, made.id, { name: "שורה", unit_price_agorot: 1 });
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      for (const u of [owner, admin]) {
        expect((await pgError(newTemplate(u, `בקריאה בלבד ${u.email}`))).code, u.email).toBe("42501");
        expect((await pgError(newLine(u, made.id, { name: "x", unit_price_agorot: 1 }))).code, u.email).toBe("42501");
        expect(await run(u, async (q) => (await q("update public.quote_templates set name = 'x' where id = $1", [made.id])).rowCount), u.email).toBe(0);
        expect(await run(u, async (q) => (await q("update public.quote_template_lines set name = 'x' where id = $1", [line])).rowCount), u.email).toBe(0);
        expect(await run(u, async (q) => (await q("delete from public.quote_template_lines where id = $1", [line])).rowCount), u.email).toBe(0);
        expect(await run(u, async (q) => (await q("delete from public.quote_templates where id = $1", [made.id])).rowCount), u.email).toBe(0);
      }
      expect(await run(member, (q) => count(q, "select 1 from public.quote_templates where id = $1", [made.id]))).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
  });

  it("a new template needs the 'quotes' flag and fits max_quote_templates; an outsider learns nothing about the plan", async () => {
    await setOverrides("feature_overrides", { quotes: false });
    try {
      expect((await pgError(newTemplate(admin, "בלי הצעות"))).hint).toBe("feature:quotes");
      expect((await pgError(newTemplate(member, "בלי הצעות"))).code).toBe("42501");
    } finally {
      await setOverrides("feature_overrides", {});
    }
    const have = await asAdmin((q) => count(q, "select 1 from public.quote_templates where organization_id = $1", [org]));
    await setOverrides("limit_overrides", { max_quote_templates: have + 1 });
    try {
      await newTemplate(admin, "האחרונה שנכנסת");
      expect((await pgError(newTemplate(admin, "אחת יותר מדי"))).hint).toBe("limit:max_quote_templates");
      expect((await pgError(newTemplate(member, "אחת יותר מדי"))).code).toBe("42501");
    } finally {
      await setOverrides("limit_overrides", {});
    }
  });

  it("names are unique per business, ignoring case and spaces; lines keep their shape and cap", async () => {
    await newTemplate(admin, "Basic Package");
    expect((await pgError(newTemplate(admin, "  basic package "))).code).toBe("23505");
    const made = await newTemplate(admin, "מבנה שורות");
    // a free item needs a price; a group has none
    expect((await pgError(newLine(admin, made.id, { name: "חופשית בלי מחיר" }))).code).toBe("23514");
    expect((await pgError(newLine(admin, made.id, { kind: "group", name: "כותרת", unit_price_agorot: 1 }))).code).toBe("23514");
    expect((await pgError(newLine(admin, made.id, { name: "x", unit_price_agorot: 1, optional_selected: true }))).code).toBe("23514");
    await newLine(admin, made.id, { kind: "group", name: "כותרת" });
    await run(admin, (q) =>
      q("insert into public.quote_template_lines (organization_id, template_id, name, unit_price_agorot) select $1, $2, 'שורה ' || g, 1 from generate_series(1, 199) g", [
        org,
        made.id,
      ]),
    );
    expect((await pgError(newLine(admin, made.id, { name: "201", unit_price_agorot: 1 }))).hint).toBe("quote_template_lines:max");
  });

  it("a product on a template line can only be archived, not removed; the line keeps its template", async () => {
    const product = await run(owner, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'מוצר בתבנית', 5000) returning id", [org])).rows[0].id,
    );
    const made = await newTemplate(admin, "עם מוצר");
    const line = await newLine(admin, made.id, { product_id: product, name: "מוצר בתבנית" });
    expect((await pgError(run(owner, (q) => q("delete from public.products where id = $1", [product])))).code).toBe("23503");
    // the template and product of a line cannot be changed by a person (no grant)
    const other = await newTemplate(admin, "אחרת");
    expect((await pgError(run(admin, (q) => q("update public.quote_template_lines set template_id = $2 where id = $1", [line, other.id])))).code).toBe("42501");
    expect((await pgError(run(admin, (q) => q("update public.quote_template_lines set product_id = null where id = $1", [line])))).code).toBe("42501");
    // nor by the server: the trigger keeps them
    await asAdmin((q) => q("update public.quote_template_lines set template_id = $2, kind = 'group', product_id = null where id = $1", [line, other.id]));
    expect(
      await asAdmin(async (q) => (await q<{ template_id: string; product_id: string }>("select template_id, product_id from public.quote_template_lines where id = $1", [line])).rows[0]),
    ).toEqual({ template_id: made.id, product_id: product });
  });

  it("quote_template_save keeps a typed price, leaves catalog prices to the next customer, and copies notes, terms and the VAT mode", async () => {
    const product = await run(owner, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'מוצר לשמירה', 7000) returning id", [org])).rows[0].id,
    );
    const deal = await run(member, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [
          org,
          pipelineId,
          stageId,
        ])
      ).rows[0].id,
    );
    const quote = await run(member, async (q) =>
      (await q<{ id: string }>("insert into public.quotes (organization_id, title, deal_id, notes, terms) values ($1, 'הצעה', $2, 'הערות', 'תנאים') returning id", [org, deal]))
        .rows[0].id,
    );
    await run(member, async (q) => {
      await q("insert into public.quote_lines (organization_id, quote_id, position, kind, name) values ($1, $2, 1, 'group', 'שלב א')", [org, quote]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, quantity) values ($1, $2, 2, $3, 'מוצר לשמירה', 7000, 'product', 3)",
        [org, quote, product],
      );
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source) values ($1, $2, 3, $3, 'מוצר במחיר שהוקלד', 6500, 'manual')",
        [org, quote, product],
      );
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, is_optional, optional_selected) values ($1, $2, 4, 'רשות', 1200, true, true)",
        [org, quote],
      );
    });
    // a member reads the quote but may not write templates
    expect((await pgError(run(member, (q) => q("select public.quote_template_save($1, $2, 'של חבר')", [org, quote])))).code).toBe("42501");
    const id = await run(admin, async (q) => (await q<{ id: string }>("select public.quote_template_save($1, $2, '  מההצעה  ') as id", [org, quote])).rows[0].id);
    const template = await asAdmin(async (q) => (await q("select name, notes, terms, prices_include_vat from public.quote_templates where id = $1", [id])).rows[0]);
    expect(template).toEqual({ name: "מההצעה", notes: "הערות", terms: "תנאים", prices_include_vat: false });
    const lines = await asAdmin(async (q) =>
      (
        await q<{ position: number; kind: string; name: string; unit_price_agorot: string | null; quantity: string; is_optional: boolean; optional_selected: boolean }>(
          "select position, kind, name, unit_price_agorot, quantity::text, is_optional, optional_selected from public.quote_template_lines where template_id = $1 order by position",
          [id],
        )
      ).rows,
    );
    expect(lines).toEqual([
      { position: 1, kind: "group", name: "שלב א", unit_price_agorot: null, quantity: "1", is_optional: false, optional_selected: false },
      { position: 2, kind: "item", name: "מוצר לשמירה", unit_price_agorot: null, quantity: "3", is_optional: false, optional_selected: false },
      { position: 3, kind: "item", name: "מוצר במחיר שהוקלד", unit_price_agorot: "6500", quantity: "1", is_optional: false, optional_selected: false },
      { position: 4, kind: "item", name: "רשות", unit_price_agorot: "1200", quantity: "1", is_optional: true, optional_selected: true },
    ]);
    // a quote the caller cannot read, or of another business, makes nothing
    const stranger = await createUser("qt-stranger");
    const strangerOrg = await createOrg(stranger.id, "עסק זר");
    expect((await pgError(run(stranger, (q) => q("select public.quote_template_save($1, $2, 'גניבה')", [strangerOrg, quote])))).hint).toBe("quote_templates:quote");
    expect((await pgError(run(stranger, (q) => q("select public.quote_template_save($1, $2, 'גניבה')", [org, quote])))).code).toMatch(/^(42501|P0001)$/);
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_templates where name = 'גניבה'", []))).toBe(0);
  });

  it("the update policies check the new row as they check the old one", async () => {
    // the columns that decide (organization_id) have no update grant, so only the policy text shows a weakening
    const rows = await asAdmin(async (q) =>
      (
        await q<{ policyname: string; qual: string; with_check: string }>(
          "select policyname, qual, with_check from pg_policies where schemaname = 'public' and policyname in ('quote_templates_update', 'quote_template_lines_update')",
        )
      ).rows,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.with_check, row.policyname).toBe(row.qual);
      expect(row.qual, row.policyname).toMatch(/is_admin\(organization_id\) AND app\.org_writable\(organization_id\)/);
    }
  });
});
