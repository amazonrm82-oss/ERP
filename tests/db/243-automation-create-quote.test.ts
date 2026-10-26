import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discountedPrice } from "@/features/price-lists/price";
import { productPriceFor } from "@/features/products/price";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; error?: string; warning?: string; warnings?: string[]; warning_count?: number; attempt?: number };
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
  const ALL = { quotes: true, products: true, price_lists: true, discounts: true, collection: true };

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
    // a viewer owns no quote, and the step says so (owner's answer of 26 October 2026)
    const NO_OWNER = "the record owner is not usable, the quote has no owner";
    expect(steps).toEqual([{ action: "create_quote", status: "ok", warning: NO_OWNER, warnings: [NO_OWNER] }]);
    const [quote] = await quotesOf("contact_id", contact);
    // a template with no item lines keeps the business's mode (false here)
    expect(quote).toMatchObject({ deal_id: null, contact_id: contact, company_id: company, owner_id: null, prices_include_vat: false, notes: null });
    expect(await linesOf(quote.id)).toEqual([]);
  });

  it("lines the rules refuse are left out and counted (an archived product, a discount without the flag)", async () => {
    await features({ ...ALL, discounts: false });
    try {
      const contact = await insert(org, "contacts", { first_name: "רוני", owner_id: owner.id });
      const { steps } = await runNow("contact", [{ type: "create_quote", template_id: skipTemplate }], contact);
      expect(steps).toEqual([
        {
          action: "create_quote",
          status: "ok",
          warning: "some template lines were skipped",
          warnings: ["some template lines were skipped"],
          warning_count: 2,
        },
      ]);
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
  // Owner's answers of 26 October 2026 (migration automation_quote_owner_hold): a customer on hold gets the quote with a
  // warning; an optional owner in the step.
  describe("a customer on hold and the step's owner (AUT-02 follow-up)", () => {
    const ON_HOLD = "the customer is on hold";
    const COMPANY_ON_HOLD = "the customer's company is on hold";
    const RECORD_UNUSABLE = "the record owner is not usable, the quote has no owner";
    const hold = (values: { contact_id?: string; company_id?: string }) => insert(org, "customer_holds", { reason: "חוב פתוח", ...values });
    const step = (extra: Record<string, unknown> = {}) => [{ type: "create_quote", template_id: emptyTemplate, ...extra }];

    it("a hold on the contact: the quote is made and the step is ok with a warning", async () => {
      const contact = await insert(org, "contacts", { first_name: "חייב", owner_id: owner.id });
      await hold({ contact_id: contact });
      const { steps } = await runNow("contact", step(), contact);
      expect(steps).toEqual([{ action: "create_quote", status: "ok", warning: ON_HOLD, warnings: [ON_HOLD] }]);
      expect(await quotesOf("contact_id", contact)).toHaveLength(1);
    });

    it("a hold on the contact's company: on a contact rule and on a deal with no company of its own", async () => {
      const heldCompany = await insert(org, "companies", { name: "חברה חייבת" });
      await hold({ company_id: heldCompany });
      const contact = await insert(org, "contacts", { first_name: "עובד", company_id: heldCompany, owner_id: owner.id });
      const both = await insert(org, "contacts", { first_name: "שניהם", company_id: heldCompany, owner_id: owner.id });
      await hold({ contact_id: both });

      expect((await runNow("contact", step(), contact)).steps).toEqual([
        { action: "create_quote", status: "ok", warning: COMPANY_ON_HOLD, warnings: [COMPANY_ON_HOLD] },
      ]);
      // the deal names the contact only; the quote takes the contact's company, and so does the warning
      const d = await deal("עסקה לחברה חייבת", contact, owner.id);
      await asAdmin((q) => q("update public.deals set company_id = null where id = $1", [d]));
      expect((await runNow("deal", step(), d)).steps).toEqual([
        { action: "create_quote", status: "ok", warning: COMPANY_ON_HOLD, warnings: [COMPANY_ON_HOLD] },
      ]);
      expect((await quotesOf("deal_id", d))[0].company_id).toBe(heldCompany);
      // both held: the contact's own hold first, then its company's
      expect((await runNow("contact", step(), both)).steps).toEqual([
        { action: "create_quote", status: "ok", warning: ON_HOLD, warnings: [ON_HOLD, COMPANY_ON_HOLD] },
      ]);
    });

    it("a lifted hold, or a plan without collection, gives no warning", async () => {
      const contact = await insert(org, "contacts", { first_name: "שילם", owner_id: owner.id });
      const holdId = await hold({ contact_id: contact });
      await asAdmin((q) => q("update public.customer_holds set cleared_at = now() where id = $1", [holdId]));
      expect((await runNow("contact", step(), contact)).steps).toEqual([{ action: "create_quote", status: "ok" }]);

      const held = await insert(org, "contacts", { first_name: "חייב בלי גבייה", owner_id: owner.id });
      await hold({ contact_id: held });
      await features({ ...ALL, collection: false });
      try {
        expect((await runNow("contact", step(), held)).steps).toEqual([{ action: "create_quote", status: "ok" }]);
      } finally {
        await features(ALL);
      }
    });

    // owner's answer (ב) of 26 October 2026 (migration automation_quote_record_owner_first): the record's owner first,
    // the chosen one only as a fallback
    it("the record's owner while usable owns the quote, also when a usable owner is chosen in the step", async () => {
      const contact = await insert(org, "contacts", { first_name: "לאחראי הרשומה", owner_id: owner.id });
      const { steps } = await runNow("contact", step({ owner_id: member.id }), contact);
      expect(steps).toEqual([{ action: "create_quote", status: "ok" }]);
      expect((await quotesOf("contact_id", contact))[0].owner_id).toBe(owner.id);
    });

    it("the record's owner not usable: the chosen one owns the quote, with no warning", async () => {
      const suspended = await addMember(org, owner.id, "member", "aq-rec-suspended");
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]));
      for (const recordOwner of [viewer.id, suspended.id, null]) {
        const contact = await insert(org, "contacts", { first_name: "לגיבוי", owner_id: owner.id });
        await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [contact, recordOwner]));
        const { steps } = await runNow("contact", step({ owner_id: member.id }), contact);
        expect(steps).toEqual([{ action: "create_quote", status: "ok" }]);
        expect((await quotesOf("contact_id", contact))[0].owner_id).toBe(member.id);
      }
    });

    it("a chosen owner who is not usable is not noted while the record's owner is usable", async () => {
      for (const chosen of [viewer.id, stranger.id, randomUUID(), "not-a-uuid"]) {
        const contact = await insert(org, "contacts", { first_name: "גיבוי לא שמיש", owner_id: member.id });
        const { steps } = await runNow("contact", step({ owner_id: chosen }), contact);
        expect(steps).toEqual([{ action: "create_quote", status: "ok" }]);
        expect((await quotesOf("contact_id", contact))[0].owner_id).toBe(member.id);
      }
    });

    it("neither usable (a viewer, suspended, of another business or not an id): no owner and the record's warning only", async () => {
      const suspended = await addMember(org, owner.id, "member", "aq-suspended");
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]));
      for (const chosen of [viewer.id, suspended.id, stranger.id, randomUUID(), "not-a-uuid"]) {
        const contact = await insert(org, "contacts", { first_name: "לא שמיש", owner_id: viewer.id });
        const { steps } = await runNow("contact", step({ owner_id: chosen }), contact);
        expect(steps).toEqual([{ action: "create_quote", status: "ok", warning: RECORD_UNUSABLE, warnings: [RECORD_UNUSABLE] }]);
        expect((await quotesOf("contact_id", contact))[0].owner_id).toBeNull();
      }
    });

    it("no chosen owner: the record's owner while usable, else no owner and a warning", async () => {
      const kept = await insert(org, "contacts", { first_name: "אחראי רשומה", owner_id: member.id });
      expect((await runNow("contact", step(), kept)).steps).toEqual([{ action: "create_quote", status: "ok" }]);
      expect((await quotesOf("contact_id", kept))[0].owner_id).toBe(member.id);

      const ownerless = await insert(org, "contacts", { first_name: "בלי אחראי" });
      await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [ownerless]));
      expect((await runNow("contact", step(), ownerless)).steps).toEqual([
        { action: "create_quote", status: "ok", warning: RECORD_UNUSABLE, warnings: [RECORD_UNUSABLE] },
      ]);
      expect((await quotesOf("contact_id", ownerless))[0].owner_id).toBeNull();
    });

    it("a retry of a later failed step leaves the one quote and its warnings as they were (AUT-06)", async () => {
      const tag = randomUUID();
      const contact = await insert(org, "contacts", { first_name: "ניסיון חוזר חייב", owner_id: owner.id });
      await hold({ contact_id: contact });
      const ruleId = await rule("contact", [...step({ owner_id: viewer.id }), { type: "add_tag", tag_id: tag }], true);
      const key = `event:aq-${randomUUID()}`;
      const runId = await asAdmin(async (q) => {
        await q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [ruleId, contact, key]);
        return (await q<{ id: string }>("select id from public.automation_runs where automation_id = $1 and run_key = $2", [ruleId, key])).rows[0].id;
      });
      await asUser(owner.id, (q) => q("insert into public.tags (id, organization_id, name) values ($1, $2, 'תגית לניסיון')", [tag, org]));
      await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [runId]));
      await asAdmin((q) => q("select app.retry_automation_runs(500)"));
      const after = await one<{ status: string; steps: Step[] }>("select status, steps from public.automation_runs where id = $1", [runId]);
      expect(after.status).toBe("success");
      expect(after.steps).toEqual([
        // the record's owner owns it (the chosen viewer is only a fallback), so the hold is its only warning
        { action: "create_quote", status: "ok", warning: ON_HOLD, warnings: [ON_HOLD] },
        { action: "add_tag", status: "ok", attempt: 2 },
      ]);
      expect(await quotesOf("contact_id", contact)).toHaveLength(1);
    });
  });

  // review L1 of 020940: the session is put aside around the server write and given back as it was
  describe("the session around a server write (AUT-02 review L1)", () => {
    it("a manual run of [create_quote, create_task] makes the task as the person who ran it", async () => {
      const contact = await insert(org, "contacts", { first_name: "הרצה ידנית", owner_id: member.id });
      const id = await rule("contact", [...[{ type: "create_quote", template_id: emptyTemplate }], { type: "create_task", title: "לעקוב" }]);
      const seen = await asUser(owner.id, async (q) => {
        await q("select public.run_automation_now($1, $2)", [id, contact]);
        return (await q<{ claims: string | null }>("select current_setting('request.jwt.claims', true) as claims")).rows[0].claims;
      });
      expect(JSON.parse(seen ?? "{}")).toMatchObject({ sub: owner.id, role: "authenticated" });
      const steps = (await one<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [id])).steps;
      expect(steps).toEqual([{ action: "create_quote", status: "ok" }, { action: "create_task", status: "ok" }]);
      const task = await one<{ created_by: string | null }>("select created_by from public.tasks where contact_id = $1", [contact]);
      expect(task.created_by).toBe(owner.id);
      // the quote is still the server's: the record's owner owns it, not the person who ran the rule
      expect((await quotesOf("contact_id", contact))[0].owner_id).toBe(member.id);
    });

    it("claims that were never set stay unset (create_quote and create_deal's copied lines)", async () => {
      const contact = await insert(org, "contacts", { first_name: "בלי סשן", owner_id: owner.id });
      const source = await deal("עסקת מקור", contact, owner.id);
      await insert(org, "deal_lines", { deal_id: source, position: 0, description: "שורה", quantity: 1, unit_price_agorot: 1000 });
      const quoteRule = await rule("contact", [{ type: "create_quote", template_id: emptyTemplate }]);
      const dealRule = await rule("deal", [{ type: "create_deal", pipeline_id: pipeline, copy_from_source: true }]);
      // a connection of its own, where the settings were never defined (the pool's may have had them set before)
      const client = new Client({ connectionString: TEST_DB_URL });
      await client.connect();
      try {
        await client.query("begin");
        const before = await client.query<{ c: string | null; s: string | null }>(
          "select current_setting('request.jwt.claims', true) as c, current_setting('request.jwt.claim.sub', true) as s",
        );
        expect(before.rows[0]).toEqual({ c: null, s: null });
        const ran = await client.query<{ q: Step[]; d: Step[]; c: string | null; s: string | null }>(
          `select (select app.run_automation_actions(a, 'contact', $3) from public.automations a where a.id = $1) as q,
                  (select app.run_automation_actions(a, 'deal', $4) from public.automations a where a.id = $2) as d`,
          [quoteRule, dealRule, contact, source],
        );
        expect(ran.rows[0].q).toEqual([{ action: "create_quote", status: "ok" }]);
        expect(ran.rows[0].d).toEqual([{ action: "create_deal", status: "ok" }]);
        const after = await client.query<{ c: string | null; s: string | null }>(
          "select current_setting('request.jwt.claims', true) as c, current_setting('request.jwt.claim.sub', true) as s",
        );
        expect(after.rows[0]).toEqual({ c: null, s: null });
      } finally {
        await client.query("rollback");
        await client.end();
      }
    });
  });
});
