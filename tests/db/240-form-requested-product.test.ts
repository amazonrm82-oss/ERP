import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = Record<string, unknown>;

const formOf = (token: string) =>
  asService(async (q) => (await q<{ f: Row | null }>("select public.intake_form($1) as f", [token])).rows[0].f);

const submit = (token: string, payload: Row, kind = "form") =>
  asService(async (q) =>
    (await q<{ r: Row }>("select public.intake_submit($1, $2, $3, null, null, false) as r", [token, kind, JSON.stringify(payload)])).rows[0].r,
  );

/**
 * LEAD-04 follow-up for CAP-08 (owner, 14 October 2026): the public form may ask for a requested product. intake_form
 * shows only the offered products (id and name), intake_submit accepts only one of them and sets the lead's requested
 * product before the distribution routing, so the product rule applies to form leads.
 */
describe("requested product on the public form (LEAD-04 / CAP-08)", () => {
  let owner: U, admin: U, rep: U, rep2: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let team: string, team2: string;
  let product: string, product2: string, archived: string, inactive: string, otherProduct: string;
  let form: { id: string; token: string };
  let webhook: { id: string; token: string };

  const setFeature = (o: string, key: string, on: boolean) =>
    asAdmin((q) =>
      q(
        "update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object($2::text, $3::boolean) where organization_id = $1",
        [o, key, on],
      ),
    );
  const setForm = (patch: Row) =>
    asUser(owner.id, async (q) => {
      const names = Object.keys(patch);
      return (
        await q(`update public.forms set ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")} where id = $1`, [form.id, ...Object.values(patch)])
      ).rowCount;
    });
  const setLeads = (on: boolean) =>
    asAdmin((q) =>
      q(
        "insert into public.org_modules (organization_id, leads_enabled) values ($1, $2) on conflict (organization_id) do update set leads_enabled = excluded.leads_enabled",
        [org, on],
      ),
    );
  const lead = (id: unknown) =>
    asAdmin(async (q) => (await q<Row>("select owner_id, team_id, requested_product_id from public.leads where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("frp-owner");
    org = await createOrg(owner.id, "עסק המוצרים");
    admin = await addMember(org, owner.id, "admin", "frp-admin");
    rep = await addMember(org, owner.id, "member", "frp-rep");
    rep2 = await addMember(org, owner.id, "member", "frp-rep2");
    member = await addMember(org, owner.id, "member", "frp-member");
    outsider = await createUser("frp-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    await setFeature(org, "products", true);
    await setFeature(org, "lead_distribution", true);
    await asUser(owner.id, async (q) => {
      const make = async (name: string) =>
        (await q<{ id: string }>("insert into public.products (organization_id, name, sku, price_agorot) values ($1, $2, null, 12345) returning id", [org, name])).rows[0].id;
      product = await make("בדיקת עיניים");
      product2 = await make("אחריות מורחבת");
      archived = await make("דגם ישן");
      inactive = await make("מוצר כבוי");
      await q("update public.products set archived_at = now() where id = $1", [archived]);
      await q("update public.products set is_active = false where id = $1", [inactive]);
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      team2 = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'עיניים') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, rep.id]);
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team2, rep2.id]);
      form = (
        await q<{ id: string; token: string }>(
          "insert into public.forms (organization_id, name, owner_id, assign_mode, team_id) values ($1, 'טופס באתר', $2, 'round_robin', $3) returning id, token",
          [org, owner.id, team],
        )
      ).rows[0];
      webhook = (
        await q<{ id: string; token: string }>(
          "insert into public.forms (organization_id, kind, name, owner_id, product_choice) values ($1, 'webhook', 'Zapier', $2, true) returning id, token",
          [org, rep.id],
        )
      ).rows[0];
    });
    otherProduct = await asUser(outsider.id, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'מוצר זר') returning id", [otherOrg])).rows[0].id,
    );
    // working hours everywhere, so the rotation always has someone (CAP-09)
    await asAdmin((q) => q("update public.org_calendar_settings set working_hours = null where organization_id = $1", [org]));
  });

  beforeEach(async () => {
    await setFeature(org, "products", true);
    await setLeads(true);
    await setForm({ product_choice: false, product_ids: null });
  });

  it("intake_form asks nothing until the form asks, and then lists offerable products by name: id and name only", async () => {
    const before = await formOf(form.token);
    expect(before).not.toHaveProperty("products");
    expect(await setForm({ product_choice: true })).toBe(1);
    const shown = (await formOf(form.token))!.products as Row[];
    expect(shown).toEqual([
      { id: product2, name: "אחריות מורחבת" },
      { id: product, name: "בדיקת עיניים" },
    ]);
    // nothing but id and name leaves (no price, SKU, state)
    for (const item of shown) expect(Object.keys(item).sort()).toEqual(["id", "name"]);
  });

  it("a picked list narrows the offer; archived, switched-off and other businesses' products never show", async () => {
    await setForm({ product_choice: true, product_ids: [product] });
    expect((await formOf(form.token))!.products).toEqual([{ id: product, name: "בדיקת עיניים" }]);
    // a server write can hold any id (the trigger checks people); still only this business's offerable ones show
    await asAdmin((q) => q("update public.forms set product_ids = $2 where id = $1", [form.id, [archived, inactive, otherProduct]]));
    expect(await formOf(form.token)).not.toHaveProperty("products");
    await asAdmin((q) => q("update public.forms set product_ids = $2 where id = $1", [form.id, [otherProduct, product2]]));
    expect((await formOf(form.token))!.products).toEqual([{ id: product2, name: "אחריות מורחבת" }]);
  });

  it("without the products flag the question is not shown and a sent product is ignored", async () => {
    await setForm({ product_choice: true });
    await setFeature(org, "products", false);
    expect(await formOf(form.token)).not.toHaveProperty("products");
    const r = await submit(form.token, { full_name: "בלי דגל", phone: "050-7300001", requested_product_id: product });
    expect(r.status).toBe("accepted");
    expect((await lead(r.lead_id)).requested_product_id).toBeNull();
  });

  it("a person may pick only products of the form's business; members cannot change the setting", async () => {
    const refused = await pgError(asUser(owner.id, (q) => q("update public.forms set product_ids = $2 where id = $1", [form.id, [otherProduct]])));
    expect(refused.hint).toBe("form:product_ids");
    const dup = await pgError(asUser(owner.id, (q) => q("update public.forms set product_ids = $2 where id = $1", [form.id, [product, product]])));
    expect(dup.hint).toBe("form:product_ids");
    const empty = await pgError(asUser(owner.id, (q) => q("update public.forms set product_ids = '{}' where id = $1", [form.id])));
    expect(empty.code).toBe("23514");
    // an admin may set it; a member updates nothing; an outsider neither
    expect(await asUser(admin.id, async (q) => (await q("update public.forms set product_choice = true, product_ids = $2 where id = $1", [form.id, [product]])).rowCount)).toBe(1);
    expect(await asUser(member.id, async (q) => (await q("update public.forms set product_choice = false where id = $1", [form.id])).rowCount)).toBe(0);
    // an outsider sees no row to change (RLS), and learns nothing about the products
    expect(await asUser(outsider.id, async (q) => (await q("update public.forms set product_ids = $2 where id = $1", [form.id, [otherProduct]])).rowCount)).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.forms where id = $1 and product_choice and product_ids = array[$2]::uuid[]", [form.id, product]))).toBe(1);
  });

  it("intake_submit stores an offered product on the new lead, and the product rule sends it to its team", async () => {
    await setForm({ product_choice: true });
    const plain = await submit(form.token, { full_name: "בלי חוק", phone: "050-7300002", requested_product_id: product2 });
    expect(await lead(plain.lead_id)).toMatchObject({ requested_product_id: product2, team_id: team, owner_id: rep.id });
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, position, product_id, team_id) values ($1, 0, $2, $3)", [org, product, team2]));
    try {
      const routed = await submit(form.token, { full_name: "רוצה בדיקה", phone: "050-7300003", requested_product_id: product });
      expect(await lead(routed.lead_id)).toMatchObject({ requested_product_id: product, team_id: team2, owner_id: rep2.id });
      // no product: the rule does not match
      const none = await submit(form.token, { full_name: "בלי מוצר", phone: "050-7300004" });
      expect(await lead(none.lead_id)).toMatchObject({ requested_product_id: null, team_id: team });
    } finally {
      await asAdmin((q) => q("update public.lead_routing_rules set is_active = false where organization_id = $1", [org]));
    }
  });

  it("refuses any product the form does not offer with the same answer, and stores nothing", async () => {
    await setForm({ product_choice: true, product_ids: [product] });
    const before = await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]));
    const answers = new Set<string>();
    for (const id of [product2, archived, inactive, otherProduct, "00000000-0000-4000-8000-000000000000", "not-a-uuid", "", " "]) {
      if (id.trim() === "") {
        // empty: no product, the lead is made without one
        expect((await submit(form.token, { full_name: "ניסיון", phone: "050-7300005", requested_product_id: id })).status).toMatch(/^(accepted|duplicate)$/);
        continue;
      }
      const error = await pgError(submit(form.token, { full_name: "ניסיון", phone: "050-7300005", requested_product_id: id }));
      expect(error.code).toBe("22023");
      expect(error.hint).toBe("requested_product:invalid");
      answers.add(`${error.message}|${error.hint}`);
    }
    expect(answers.size).toBe(1);
    // not a string at all: ignored (no product), never an error
    for (const id of [42, { id: product }, [product]]) {
      expect((await submit(form.token, { full_name: "ניסיון", phone: "050-7300005", requested_product_id: id })).status).toBe("duplicate");
    }
    const made = await asAdmin(async (q) =>
      (await q<Row>("select requested_product_id from public.leads where organization_id = $1 and phone = '050-7300005'", [org])).rows,
    );
    expect(made.every((row) => row.requested_product_id === null)).toBe(true);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(before + made.length);
  });

  it("a form that does not ask, and a webhook, ignore a sent product", async () => {
    const r = await submit(form.token, { full_name: "לא נשאל", phone: "050-7300006", requested_product_id: otherProduct });
    expect((await lead(r.lead_id)).requested_product_id).toBeNull();
    const w = await submit(webhook.token, { full_name: "מזאפייר", phone: "050-7300007", requested_product_id: product }, "webhook");
    expect((await lead(w.lead_id)).requested_product_id).toBeNull();
  });

  it("a repeat inquiry fills a matched lead's empty product only, and keeps the product on the inquiry entry", async () => {
    await setForm({ product_choice: true });
    const first = await submit(form.token, { full_name: "חוזר", phone: "050-7300008" });
    const again = await submit(form.token, { full_name: "חוזר", phone: "050-7300008", requested_product_id: product });
    expect(again.status).toBe("duplicate");
    expect((await lead(first.lead_id)).requested_product_id).toBe(product);
    await submit(form.token, { full_name: "חוזר", phone: "050-7300008", requested_product_id: product2 });
    expect((await lead(first.lead_id)).requested_product_id).toBe(product);
    const entries = await asAdmin(async (q) =>
      (await q<{ metadata: Row }>("select metadata from public.activities where lead_id = $1 and type = 'inquiry' order by created_at, id", [first.lead_id])).rows,
    );
    expect(entries.map((e) => e.metadata.requested_product_id)).toEqual([product, product2]);
    expect(entries[1].metadata.requested_product).toBe("אחריות מורחבת");
  });

  it("with leads off, the product steers the owner pick and stays on the contact's inquiry entry", async () => {
    await setForm({ product_choice: true });
    await setLeads(false);
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, position, product_id, team_id) values ($1, 0, $2, $3)", [org, product, team2]));
    try {
      const r = await submit(form.token, { full_name: "איש קשר", phone: "050-7300009", requested_product_id: product });
      expect(r.status).toBe("accepted");
      const contact = await asAdmin(async (q) => (await q<Row>("select owner_id, team_id from public.contacts where id = $1", [r.contact_id])).rows[0]);
      expect(contact).toEqual({ owner_id: rep2.id, team_id: team2 });
      const entry = await asAdmin(async (q) =>
        (await q<{ metadata: Row }>("select metadata from public.activities where contact_id = $1 and type = 'inquiry'", [r.contact_id])).rows[0],
      );
      expect(entry.metadata).toMatchObject({ requested_product_id: product, requested_product: "בדיקת עיניים" });
      // the product's name is in the "לחזור ללקוח" task's title; without a product the title is as before
      const titles = async (contact: unknown) =>
        asAdmin(async (q) => (await q<{ title: string }>("select title from public.tasks where contact_id = $1", [contact])).rows.map((t) => t.title));
      expect(await titles(r.contact_id)).toEqual(["לחזור ללקוח: איש קשר · בדיקת עיניים"]);
      const plain = await submit(form.token, { full_name: "בלי מוצר", phone: "050-7300011" });
      expect(await titles(plain.contact_id)).toEqual(["לחזור ללקוח: בלי מוצר"]);
      // a repeat inquiry from the contact with a product: the same title rule
      await submit(form.token, { full_name: "בלי מוצר", phone: "050-7300011", requested_product_id: product2 });
      expect((await titles(plain.contact_id)).sort()).toEqual(["לחזור ללקוח: בלי מוצר", "לחזור ללקוח: בלי מוצר · אחריות מורחבת"]);
      const bad = await pgError(submit(form.token, { full_name: "איש קשר", phone: "050-7300010", requested_product_id: otherProduct }));
      expect(bad.hint).toBe("requested_product:invalid");
    } finally {
      await asAdmin((q) => q("update public.lead_routing_rules set is_active = false where organization_id = $1", [org]));
    }
  });

  it("categories: a picked top category includes its sub-categories, only offerable products, only this business's", async () => {
    const [top, sub, other] = await asUser(owner.id, async (q) => {
      const cat = async (name: string, parent: string | null) =>
        (await q<{ id: string }>("insert into public.product_categories (organization_id, name, parent_id) values ($1, $2, $3) returning id", [org, name, parent])).rows[0].id;
      const t = await cat("משקפיים", null);
      return [t, await cat("משקפי שמש", t), await cat("עדשות", null)];
    });
    const foreign = await asUser(outsider.id, async (q) =>
      (await q<{ id: string }>("insert into public.product_categories (organization_id, name) values ($1, 'זרה') returning id", [otherOrg])).rows[0].id,
    );
    const [inTop, inSub, inOther, archivedInTop] = await asUser(owner.id, async (q) => {
      const make = async (name: string, category: string) =>
        (await q<{ id: string }>("insert into public.products (organization_id, name, category_id) values ($1, $2, $3) returning id", [org, name, category])).rows[0].id;
      return [await make("מסגרת", top), await make("ריי-באן", sub), await make("עדשה יומית", other), await make("מסגרת ישנה", top)];
    });
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [archivedInTop]));

    // a person's pick of another business's category, or the same one twice, is refused
    expect((await pgError(setForm({ product_category_ids: [foreign] }))).hint).toBe("form:product_categories");
    expect((await pgError(setForm({ product_category_ids: [top, top] }))).hint).toBe("form:product_categories");

    await setForm({ product_choice: true, product_category_ids: [top], product_ids: [product] });
    const shown = ((await formOf(form.token))!.products as Row[]).map((p) => p.id);
    expect(new Set(shown)).toEqual(new Set([inTop, inSub, product]));
    expect(shown).not.toContain(inOther);
    expect(shown).not.toContain(archivedInTop);
    // the sub-category alone offers only its own products
    await setForm({ product_category_ids: [sub], product_ids: null });
    expect(((await formOf(form.token))!.products as Row[]).map((p) => p.id)).toEqual([inSub]);
    // the submit accepts exactly the offer
    const ok = await submit(form.token, { full_name: "שמש", phone: "050-7300020", requested_product_id: inSub });
    expect((await lead(ok.lead_id)).requested_product_id).toBe(inSub);
    expect((await pgError(submit(form.token, { full_name: "שמש", phone: "050-7300021", requested_product_id: inTop }))).hint).toBe(
      "requested_product:invalid",
    );
    // a server write may hold another business's category: it offers nothing from it
    await asAdmin((q) => q("update public.forms set product_category_ids = $2, product_ids = null where id = $1", [form.id, [foreign, sub]]));
    expect(((await formOf(form.token))!.products as Row[]).map((p) => p.id)).toEqual([inSub]);
    await asAdmin((q) => q("update public.forms set product_category_ids = null where id = $1", [form.id]));
  });

  it("over 100 active products the form must pick what it shows; a business that grew later shows the first 100", async () => {
    await asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_products\": 1000}'::jsonb where organization_id = $1", [org]),
    );
    const bigCat = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.product_categories (organization_id, name) values ($1, 'סדרה') returning id", [org])).rows[0].id,
    );
    const offerable = async () =>
      asAdmin((q) => count(q, "select 1 from public.products where organization_id = $1 and is_active and archived_at is null", [org]));
    // up to exactly 100 offerable products: "all" may be saved
    const need = 100 - (await offerable());
    await asAdmin((q) =>
      q("insert into public.products (organization_id, name, category_id) select $1, 'סדרה ' || lpad(g::text, 3, '0'), $2 from generate_series(1, $3::int) g", [org, bigCat, need]),
    );
    expect(await offerable()).toBe(100);
    expect(await setForm({ product_choice: true, product_ids: null, product_category_ids: null })).toBe(1);
    // the business grows past 100 (not refused); the public form shows the first 100 by name
    await asAdmin((q) => q("insert into public.products (organization_id, name, category_id) values ($1, 'סדרה 999', $2)", [org, bigCat]));
    expect(((await formOf(form.token))!.products as Row[]).length).toBe(100);
    // the next save of that form while it asks for a product is refused
    expect((await pgError(setForm({ product_choice: true }))).hint).toBe("form:products_over");
    // a pick whose offer is over 100 (a category plus products) is refused too
    const others = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "select id from public.products where organization_id = $1 and is_active and archived_at is null and category_id is distinct from $2",
          [org, bigCat],
        )
      ).rows.map((r) => r.id),
    );
    expect((await pgError(setForm({ product_category_ids: [bigCat], product_ids: others }))).hint).toBe("form:products_over");
    // the category alone (100 - the others + 1 products) is within the limit
    expect(await setForm({ product_category_ids: [bigCat], product_ids: null })).toBe(1);
    // a narrow pick is saved; a form that does not ask is not judged
    expect(await setForm({ product_category_ids: null, product_ids: [product, product2] })).toBe(1);
    expect(await setForm({ product_choice: false, product_ids: null })).toBe(1);
    expect((await pgError(setForm({ product_choice: true }))).hint).toBe("form:products_over");
  });
});

