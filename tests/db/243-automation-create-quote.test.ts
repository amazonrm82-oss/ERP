import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discountedPrice } from "@/features/price-lists/price";
import { productPriceFor } from "@/features/products/price";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; error?: string; warning?: string; warning_count?: number; attempt?: number };
type Quote = {
  id: string;
  title: string;
  status: string;
  number_display: string | null;
  deal_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  owner_id: string | null;
  prices_include_vat: boolean;
  notes: string | null;
  terms: string | null;
  days_valid: number;
  total_agorot: string;
};
type Line = { position: number; kind: string; product_id: string | null; name: string; quantity: string; price: string; price_source: string; price_list_id: string | null };

// AUT-02 (rest), migration automation_create_quote: a step that makes a draft quote from a quote template on the deal
// or the contact a rule runs on, the lines priced for the customer (PL-03) and refused lines left out and counted.
describe("automations create a quote from a template (AUT-02)", () => {
  let owner: U, member: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;
  let pipeline: string, stage: string;
  let product: string, tiered: string, discounted: string, archived: string;
  let company: string, list: string;
  let template: string, emptyTemplate: string, skipTemplate: string, foreignTemplate: string;

  const one = async <T extends object>(sql: string, params: unknown[]) => asAdmin(async (q) => (await q<T>(sql, params)).rows[0]);
  const insert = (o: string, table: string, values: Record<string, unknown>) =>
    asAdmin(async (q) => {
      const keys = Object.keys(values);
      const sql = `insert into public.${table} (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => values[k])])).rows[0].id;
    });
  const features = (values: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(values)]));
  const ALL = { quotes: true, products: true, price_lists: true, discounts: true };

  const rule = (entity: string, actions: Array<Record<string, unknown>>, active = false) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'הצעה מתבנית', $2, 'created', '{}', '[]', $3, $4) returning id`,
          [org, entity, JSON.stringify(actions), active],
        )
      ).rows[0].id,
    );
  const runNow = async (entity: string, actions: Array<Record<string, unknown>>, recordId: string) => {
    const id = await rule(entity, actions);
    await asUser(owner.id, (q) => q("select public.run_automation_now($1, $2)", [id, recordId]));
    const steps = (await one<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [id])).steps;
    return { rule: id, steps };
  };
  const quotesOf = (column: "deal_id" | "contact_id", id: string) =>
    asAdmin(async (q) =>
      (
        await q<Quote>(
          `select id, title, status, number_display, deal_id, contact_id, company_id, owner_id, prices_include_vat, notes, terms,
                  (valid_until - quote_date) as days_valid, total_agorot::text
             from public.quotes where ${column} = $1 order by created_at, id`,
          [id],
        )
      ).rows,
    );
  const linesOf = (quote: string) =>
    asAdmin(async (q) =>
      (
        await q<Line>(
          `select position, kind, product_id, name, quantity::text, unit_price_agorot::text as price, price_source, price_list_id
             from public.quote_lines where quote_id = $1 order by position`,
          [quote],
        )
      ).rows,
    );
  const tline = (t: string, values: Record<string, unknown>) => insert(org, "quote_template_lines", { template_id: t, ...values });
  const deal = (name: string, contact: string | null, ownerId: string | null) =>
    insert(org, "deals", { name, pipeline_id: pipeline, stage_id: stage, contact_id: contact, owner_id: ownerId });
  const rateToday = async () =>
    Number(
      (
        await one<{ r: number | null }>(
          "select app.vat_rate_at((now() at time zone coalesce((select timezone from public.organizations where id = $1), 'Asia/Jerusalem'))::date) as r",
          [org],
        )
      ).r ?? 0,
    );

  beforeAll(async () => {
    owner = await createUser("aq-owner");
    org = await createOrg(owner.id, "עסק הצעות אוטומטיות");
    member = await addMember(org, owner.id, "member", "aq-member");
    viewer = await addMember(org, owner.id, "viewer", "aq-viewer");
    stranger = await createUser("aq-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await features(ALL);
    await asAdmin((q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = excluded.vat_status, prices_include_vat = excluded.prices_include_vat`,
        [org],
      ),
    );
    const pipe = await defaultPipeline(org);
    pipeline = pipe.pipelineId;
    stage = pipe.stages.find((s) => s.kind === "open")!.id;

    product = await insert(org, "products", { name: "ייעוץ", price_agorot: 11800, price_includes_vat: true, vat_kind: "taxable" });
    tiered = await insert(org, "products", { name: "מדף", price_agorot: 10000 });
    discounted = await insert(org, "products", { name: "התקנה", price_agorot: 20000 });
    archived = await insert(org, "products", { name: "מוצר ישן", price_agorot: 5000 });
    await asAdmin((q) => q("update public.products set archived_at = now(), is_active = false where id = $1", [archived]));

    list = await insert(org, "price_lists", { name: "סיטונאים" });
    await insert(org, "price_list_lines", { price_list_id: list, product_id: tiered, min_quantity: 1, price_agorot: 9000 });
    await insert(org, "price_list_lines", { price_list_id: list, product_id: tiered, min_quantity: 5, price_agorot: 8000 });
    await insert(org, "price_list_lines", { price_list_id: list, product_id: discounted, min_quantity: 1, discount_bp: 1000 });
    company = await insert(org, "companies", { name: "חברת הלקוח", price_list_id: list });

    template = await insert(org, "quote_templates", { name: "שיפוץ", notes: "הערות התבנית", terms: "תנאי התבנית", prices_include_vat: false });
    await tline(template, { position: 0, kind: "group", name: "עבודה" });
    await tline(template, { position: 1, name: "שעת עבודה", quantity: 2, unit_price_agorot: 15000 });
    await tline(template, { position: 2, product_id: product, name: "ייעוץ" });
    await tline(template, { position: 3, product_id: tiered, name: "מדף", quantity: 5 });
    await tline(template, { position: 4, product_id: discounted, name: "התקנה" });
    await tline(template, { position: 5, product_id: product, name: "ייעוץ במחיר מוסכם", unit_price_agorot: 7777 });

    emptyTemplate = await insert(org, "quote_templates", { name: "ריקה", prices_include_vat: true });

    skipTemplate = await insert(org, "quote_templates", { name: "עם שורות שנופלות" });
    await tline(skipTemplate, { position: 0, name: "שורה טובה", unit_price_agorot: 1000 });
    await tline(skipTemplate, { position: 1, product_id: product, name: "ייעוץ בהנחה", unit_price_agorot: 1000, discount_bp: 500 });
    await asAdmin((q) =>
      q(
        `insert into public.quote_template_lines (organization_id, template_id, position, product_id, name, unit_price_agorot)
         values ($1, $2, 2, $3, 'מוצר שהוצא', 100)`,
        [org, skipTemplate, archived],
      ),
    );

    foreignTemplate = await insert(otherOrg, "quote_templates", { name: "של עסק אחר" });
  });

  it("a deal rule makes a draft quote on the deal with the template's lines, priced for the customer (PL-03)", async () => {
    const contact = await insert(org, "contacts", { first_name: "דנה", company_id: company });
    const d = await deal("מטבח", contact, member.id);
    const { rule: ruleId, steps } = await runNow("deal", [{ type: "create_quote", template_id: template }], d);
    expect(steps).toEqual([{ action: "create_quote", status: "ok" }]);

    const quotes = await quotesOf("deal_id", d);
    expect(quotes).toHaveLength(1);
    const quote = quotes[0];
    // a draft, never numbered; on the deal, with its contact and the contact's company; the deal's owner (a member), not the
    // person who ran the rule by hand
    expect(quote).toMatchObject({
      title: "הצעת מחיר: מטבח",
      status: "draft",
      number_display: null,
      deal_id: d,
      contact_id: contact,
      company_id: company,
      owner_id: member.id,
      prices_include_vat: false,
      notes: "הערות התבנית",
      terms: "תנאי התבנית",
      days_valid: 30,
    });
    const rate = await rateToday();
    expect(await linesOf(quote.id)).toEqual([
      { position: 1, kind: "group", product_id: null, name: "עבודה", quantity: "1", price: "0", price_source: "manual", price_list_id: null },
      { position: 2, kind: "item", product_id: null, name: "שעת עבודה", quantity: "2", price: "15000", price_source: "manual", price_list_id: null },
      {
        position: 3,
        kind: "item",
        product_id: product,
        name: "ייעוץ",
        quantity: "1",
        price: String(productPriceFor({ priceAgorot: 11800, priceIncludesVat: true, vatKind: "taxable" }, false, rate)),
        price_source: "product",
        price_list_id: null,
      },
      // the tier by the line's quantity (5 → 80.00), not the first one
      { position: 4, kind: "item", product_id: tiered, name: "מדף", quantity: "5", price: "8000", price_source: "price_list", price_list_id: list },
      { position: 5, kind: "item", product_id: discounted, name: "התקנה", quantity: "1", price: String(discountedPrice(20000, 1000)), price_source: "price_list", price_list_id: list },
      // a typed price is kept as typed
      { position: 6, kind: "item", product_id: product, name: "ייעוץ במחיר מוסכם", quantity: "1", price: "7777", price_source: "manual", price_list_id: null },
    ]);
    expect(Number(quote.total_agorot)).toBeGreaterThan(0);
    // the audit entry of the quote names the rule
    expect(
      await asAdmin((q) =>
        count(
          q,
          "select 1 from public.audit_log where entity_type = 'quotes' and entity_id = $1 and action = 'insert' and changes -> 'automation' ->> 'id' = $2",
          [quote.id, ruleId],
        ),
      ),
    ).toBe(1);
  });

  it("a contact rule makes the quote on the contact; an empty template takes its own VAT mode only with item lines", async () => {
    const contact = await insert(org, "contacts", { first_name: "יוסי", company_id: company, owner_id: viewer.id });
    const { steps } = await runNow("contact", [{ type: "create_quote", template_id: emptyTemplate }], contact);
    expect(steps).toEqual([{ action: "create_quote", status: "ok" }]);
    const [quote] = await quotesOf("contact_id", contact);
    // a viewer owns no quote; a template with no item lines keeps the business's mode (false here)
    expect(quote).toMatchObject({ deal_id: null, contact_id: contact, company_id: company, owner_id: null, prices_include_vat: false, notes: null });
    expect(await linesOf(quote.id)).toEqual([]);
  });

  it("lines the rules refuse are left out and counted (an archived product, a discount without the flag)", async () => {
    await features({ ...ALL, discounts: false });
    try {
      const contact = await insert(org, "contacts", { first_name: "רוני" });
      const { steps } = await runNow("contact", [{ type: "create_quote", template_id: skipTemplate }], contact);
      expect(steps).toEqual([{ action: "create_quote", status: "ok", warning: "some template lines were skipped", warning_count: 2 }]);
      const [quote] = await quotesOf("contact_id", contact);
      expect((await linesOf(quote.id)).map((l) => [l.position, l.name])).toEqual([[1, "שורה טובה"]]);
    } finally {
      await features(ALL);
    }
  });

  it("refuses other record types, a template of another business, a missing flag and a record in the recycle bin, and makes no quote", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד" });
    expect((await runNow("lead", [{ type: "create_quote", template_id: template }], lead)).steps).toEqual([
      { action: "create_quote", status: "error", error: "a quote is made on a deal or a contact" },
    ]);
    const companyRun = await runNow("company", [{ type: "create_quote", template_id: template }], company);
    expect(companyRun.steps[0]).toMatchObject({ status: "error", error: "a quote is made on a deal or a contact" });

    const contact = await insert(org, "contacts", { first_name: "שרה" });
    for (const id of [foreignTemplate, randomUUID(), "not-a-uuid"]) {
      expect((await runNow("contact", [{ type: "create_quote", template_id: id }], contact)).steps[0]).toMatchObject({
        status: "error",
        error: "the quote template no longer exists",
      });
    }
    await features({ ...ALL, quotes: false });
    try {
      expect((await runNow("contact", [{ type: "create_quote", template_id: template }], contact)).steps[0]).toMatchObject({
        status: "error",
        error: "quotes are not in the plan",
      });
    } finally {
      await features(ALL);
    }
    expect(await quotesOf("contact_id", contact)).toEqual([]);

    const binned = await deal("בסל", null, owner.id);
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [binned]));
    // a record in the recycle bin never reaches the engine (execute_automation skips it; the step refuses it too)
    const binnedRule = await rule("deal", [{ type: "create_quote", template_id: template }]);
    await asAdmin((q) => q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [binnedRule, binned, `event:aq-${randomUUID()}`]));
    expect(await quotesOf("deal_id", binned)).toEqual([]);
    const direct = await one<{ s: Step[] }>(
      "select app.run_automation_actions(a, 'deal', $2) as s from public.automations a where a.id = $1",
      [binnedRule, binned],
    );
    expect(direct.s).toEqual([{ action: "create_quote", status: "error", error: "the record is in the recycle bin" }]);
    expect(await quotesOf("deal_id", binned)).toEqual([]);
    // the foreign template's business got nothing either
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where organization_id = $1", [otherOrg]))).toBe(0);
  });

  it("a retry of the run's failed step never makes a second quote (AUT-06)", async () => {
    const tag = randomUUID();
    const d = await deal("לניסיון חוזר", null, owner.id);
    const ruleId = await rule("deal", [
      { type: "create_quote", template_id: template },
      { type: "add_tag", tag_id: tag },
    ], true);
    const key = `event:aq-${randomUUID()}`;
    const runId = await asAdmin(async (q) => {
      await q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [ruleId, d, key]);
      return (await q<{ id: string }>("select id from public.automation_runs where automation_id = $1 and run_key = $2", [ruleId, key])).rows[0].id;
    });
    expect((await one<{ status: string }>("select status from public.automation_runs where id = $1", [runId])).status).toBe("partial");
    expect(await quotesOf("deal_id", d)).toHaveLength(1);

    await asUser(owner.id, (q) => q("insert into public.tags (id, organization_id, name) values ($1, $2, 'תגית חדשה')", [tag, org]));
    await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [runId]));
    await asAdmin((q) => q("select app.retry_automation_runs(500)"));
    const after = await one<{ status: string; steps: Step[] }>("select status, steps from public.automation_runs where id = $1", [runId]);
    expect(after.status).toBe("success");
    expect(after.steps).toEqual([
      { action: "create_quote", status: "ok" },
      { action: "add_tag", status: "ok", attempt: 2 },
    ]);
    expect(await quotesOf("deal_id", d)).toHaveLength(1);
  });

  it("a quote a rule made is seen only inside its business", async () => {
    const d = await deal("לבידוד", null, owner.id);
    await runNow("deal", [{ type: "create_quote", template_id: template }], d);
    const [quote] = await quotesOf("deal_id", d);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.quotes where id = $1", [quote.id]))).toBe(1);
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.quotes where id = $1", [quote.id]))).toBe(0);
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [quote.id]))).toBe(0);
  });
});
