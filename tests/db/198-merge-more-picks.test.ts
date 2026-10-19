import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MERGE_COMPANIONS, mergePicks } from "@/features/merge/fields";

import { asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Row = Record<string, unknown>;

// RVW-26 (migrations 020555, 020560): a merge may take more of the duplicate's fields; the columns that belong to a
// field travel with it, all picks are written in one update, and a picked type or requested product is judged by a
// person's rules although merge_records is security definer.
describe("merge picks: types, preferences, billing details, requested product (RVW-26)", () => {
  let owner: U;
  let org: string;
  let contactType: string, contactTypeOld: string, companyType: string, priceList: string, product: string;

  const merge = (type: string, keep: string, dup: string, picks: Record<string, string>) =>
    asUser(owner.id, (q) => q("select public.merge_records($1, $2, $3, $4, $5)", [org, type, keep, dup, JSON.stringify(picks)]));
  const insert = (table: string, values: Row) =>
    asAdmin(async (q) => {
      const keys = Object.keys(values);
      const sql = `insert into public.${table} (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [org, ...keys.map((k) => values[k])])).rows[0].id;
    });
  const row = (table: string, id: string) => asAdmin(async (q) => (await q<Row>(`select * from public.${table} where id = $1`, [id])).rows[0]);
  const exists = (table: string, id: string) => asAdmin((q) => count(q, `select 1 from public.${table} where id = $1`, [id]));
  // what the merge screen sends for these fields (with their companions)
  const picksFor = (type: "lead" | "contact" | "company", keys: string[]) => mergePicks(type, (key) => keys.includes(key));

  beforeAll(async () => {
    owner = await createUser("mp-owner");
    org = await createOrg(owner.id, "עסק מיזוגים");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: true, price_lists: true })]),
    );
    contactType = await insert("record_type_options", { object_type: "contact", name: "ספק במיזוג" });
    contactTypeOld = await insert("record_type_options", { object_type: "contact", name: "ישן במיזוג", is_active: false });
    companyType = await insert("record_type_options", { object_type: "company", name: "חברה במיזוג" });
    priceList = await insert("price_lists", { name: "מחירון סיטונאי" });
    product = await insert("products", { name: "ייעוץ במיזוג", price_agorot: 10000 });
  });

  it("the merge screen sends each field with the columns that belong to it", () => {
    expect(MERGE_COMPANIONS.contact.phone).toEqual(["phone_type"]);
    expect(picksFor("contact", ["phone", "payment_terms", "preferred_channel"])).toEqual({
      phone: "merge",
      phone_type: "merge",
      payment_terms: "merge",
      payment_days: "merge",
      preferred_channel: "merge",
      preferred_channel_source: "merge",
    });
    expect(picksFor("company", ["tax_id"])).toEqual({ tax_id: "merge", country: "merge" });
  });

  it("contacts: type, phone and email with their types, preferences and every billing detail come from the duplicate", async () => {
    const keep = await insert("contacts", {
      first_name: "רות",
      owner_id: owner.id,
      phone: "050-1000001",
      phone_type: "work",
      email: "ruth@keep.test",
      email_type: "work",
      payment_terms: "immediate",
    });
    const dup = await insert("contacts", {
      first_name: "רות",
      owner_id: owner.id,
      phone: "050-1000002",
      phone_type: "home",
      email: "ruth@dup.test",
      email_type: "home",
      type_id: contactType,
      preferred_locale: "ar",
      preferred_channel: "whatsapp",
      preferred_channel_source: "form",
      billing_name: "רות בע\"מ",
      billing_tax_id: "000000018",
      billing_address: "הרצל 1, חיפה",
      shipping_address: "המחסן 2, חיפה",
      billing_email: "invoices@dup.test",
      payment_terms: "net",
      payment_days: 30,
      price_list_id: priceList,
    });
    const fields = ["phone", "email", "type_id", "preferred_locale", "preferred_channel", "billing_name", "billing_tax_id", "billing_address",
      "shipping_address", "billing_email", "payment_terms", "price_list_id"];
    await merge("contact", keep, dup, picksFor("contact", fields));
    const kept = await row("contacts", keep);
    expect(kept).toMatchObject({
      phone: "050-1000002",
      phone_e164: "+972501000002",
      phone_type: "home",
      email: "ruth@dup.test",
      email_type: "home",
      type_id: contactType,
      preferred_locale: "ar",
      preferred_channel: "whatsapp",
      preferred_channel_source: "form",
      billing_name: "רות בע\"מ",
      billing_tax_id: "000000018",
      billing_address: "הרצל 1, חיפה",
      shipping_address: "המחסן 2, חיפה",
      billing_email: "invoices@dup.test",
      payment_terms: "net",
      payment_days: 30,
      price_list_id: priceList,
    });
    expect(await exists("contacts", dup)).toBe(0);
  });

  it("payment terms and days change together, whichever way (one update, one check of the pair)", async () => {
    // net 45 -> immediate: written one column at a time, either order breaks *_payment_terms_shape half way
    const keep = await insert("companies", { name: "תנאים", payment_terms: "net", payment_days: 45 });
    const dup = await insert("companies", { name: "תנאים בע\"מ", payment_terms: "immediate" });
    await merge("company", keep, dup, picksFor("company", ["payment_terms"]));
    expect(await row("companies", keep)).toMatchObject({ payment_terms: "immediate", payment_days: null });
    // the days alone are never sent: a pick of payment_days without its terms is refused by the shape, nothing changes
    const keep2 = await insert("companies", { name: "תנאים 2", payment_terms: "immediate" });
    const dup2 = await insert("companies", { name: "תנאים 2 בע\"מ", payment_terms: "eom", payment_days: 30 });
    expect((await pgError(merge("company", keep2, dup2, { payment_days: "merge" }))).code).toBe("23514");
    expect(await exists("companies", dup2)).toBe(1);
    expect(await row("companies", keep2)).toMatchObject({ payment_terms: "immediate", payment_days: null });
  });

  it("companies: type, a foreign number with its country, billing details and price list", async () => {
    const keep = await insert("companies", { name: "גלובל", tax_id: "514111111" });
    const dup = await insert("companies", {
      name: "Global Ltd",
      country: "GB",
      tax_id: "UK-1234567",
      type_id: companyType,
      billing_name: "Global Ltd",
      billing_email: "ap@global.test",
      price_list_id: priceList,
    });
    await merge("company", keep, dup, picksFor("company", ["tax_id", "type_id", "billing_name", "billing_email", "price_list_id"]));
    expect(await row("companies", keep)).toMatchObject({
      country: "GB",
      tax_id: "UK-1234567",
      type_id: companyType,
      billing_name: "Global Ltd",
      billing_email: "ap@global.test",
      price_list_id: priceList,
    });
  });

  it("leads: language, preferred channel with its source, and the requested product", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "אבי" });
    const dup = await insertLead(owner.id, org, { full_name: "אבי ל." });
    await asAdmin((q) =>
      q("update public.leads set preferred_locale = 'ru', preferred_channel = 'sms', preferred_channel_source = 'form', requested_product_id = $2 where id = $1", [dup, product]),
    );
    await asAdmin((q) => q("update public.leads set preferred_channel = 'email', preferred_channel_source = 'manual' where id = $1", [keep]));
    await merge("lead", keep, dup, picksFor("lead", ["preferred_locale", "preferred_channel", "requested_product_id"]));
    expect(await row("leads", keep)).toMatchObject({
      preferred_locale: "ru",
      preferred_channel: "sms",
      preferred_channel_source: "form",
      requested_product_id: product,
    });
  });

  it("a type the business switched off, or a type of the other object, is refused like a person's pick; nothing changes", async () => {
    const keep = await insert("contacts", { first_name: "דן", owner_id: owner.id, type_id: contactType });
    const dup = await insert("contacts", { first_name: "דן", owner_id: owner.id, type_id: contactTypeOld });
    expect(await pgError(merge("contact", keep, dup, { type_id: "merge" }))).toMatchObject({ code: "P0001", hint: "record_type:invalid" });
    // a person gets the same answer for the same value
    expect(
      await pgError(asUser(owner.id, (q) => q("update public.contacts set type_id = $2 where id = $1", [keep, contactTypeOld]))),
    ).toMatchObject({ code: "P0001", hint: "record_type:invalid" });
    expect((await row("contacts", keep)).type_id).toBe(contactType);
    expect(await exists("contacts", dup)).toBe(1);

    // a company type on a contact passes the composite foreign key (same business) but not the rule
    const dup2 = await insert("contacts", { first_name: "דן", owner_id: owner.id });
    await asAdmin((q) => q("update public.contacts set type_id = $2 where id = $1", [dup2, companyType]));
    expect((await pgError(merge("contact", keep, dup2, { type_id: "merge" }))).hint).toBe("record_type:invalid");

    // both already carry the same switched-off type: nothing changes, so it passes (as an unchanged update does)
    const keep3 = await insert("contacts", { first_name: "גל", owner_id: owner.id, type_id: contactTypeOld });
    const dup3 = await insert("contacts", { first_name: "גל", owner_id: owner.id, type_id: contactTypeOld });
    await merge("contact", keep3, dup3, { type_id: "merge" });
    expect((await row("contacts", keep3)).type_id).toBe(contactTypeOld);
    // an empty type always passes (it clears the kept one)
    const dup4 = await insert("contacts", { first_name: "גל", owner_id: owner.id });
    await merge("contact", keep3, dup4, { type_id: "merge" });
    expect((await row("contacts", keep3)).type_id).toBeNull();
  });

  it("a requested product that is no longer offered, or a plan without products, is refused; nothing changes", async () => {
    const archived = await insert("products", { name: "בארכיון במיזוג", price_agorot: 500 });
    const keep = await insertLead(owner.id, org, { full_name: "שירה", requested_product_id: product });
    const dup = await insertLead(owner.id, org, { full_name: "שירה כ.", requested_product_id: archived });
    await asAdmin((q) => q("update public.products set archived_at = now() where id = $1", [archived]));
    expect(await pgError(merge("lead", keep, dup, { requested_product_id: "merge" }))).toMatchObject({ code: "P0001", hint: "lead:requested_product" });
    expect((await row("leads", keep)).requested_product_id).toBe(product);
    expect(await exists("leads", dup)).toBe(1);

    const other = await insert("products", { name: "פעיל במיזוג", price_agorot: 700 });
    const dup2 = await insertLead(owner.id, org, { full_name: "שירה ד.", requested_product_id: other });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: false, price_lists: true })]));
    try {
      expect(await pgError(merge("lead", keep, dup2, { requested_product_id: "merge" }))).toMatchObject({ code: "P0001", hint: "feature:products" });
      // other picks of the same lead still merge without the flag
      await merge("lead", keep, dup2, { full_name: "merge" });
      expect((await row("leads", keep)).full_name).toBe("שירה ד.");
      expect((await row("leads", keep)).requested_product_id).toBe(product);
    } finally {
      await asAdmin((q) =>
        q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: true, price_lists: true })]),
      );
    }
  });

  it("an owner picked from the duplicate still brings their team, in the same update as the other picks", async () => {
    const team = await insert("teams", { name: "צוות מיזוג" });
    const keep = await insert("companies", { name: "צוותים", owner_id: owner.id });
    const dup = await insert("companies", { name: "צוותים בע\"מ", owner_id: owner.id, team_id: team, billing_name: "צוותים" });
    await merge("company", keep, dup, picksFor("company", ["owner_id", "billing_name"]));
    expect(await row("companies", keep)).toMatchObject({ owner_id: owner.id, team_id: team, billing_name: "צוותים" });
  });

  it("a company number is judged with the country it ends up with, picked or kept, like a person's write", async () => {
    // the country alone: a foreign number would become an Israeli one that fails the check digit
    const keep = await insert("companies", { name: "מספרים", country: "GB", tax_id: "ABC-1" });
    const dup = await insert("companies", { name: "מספרים בע\"מ", country: "IL" });
    expect(await pgError(merge("company", keep, dup, { country: "merge" }))).toMatchObject({ code: "P0001", hint: "tax_id:invalid" });
    // a person gets the same answer for the same pair
    expect(
      await pgError(asUser(owner.id, (q) => q("update public.companies set country = 'IL' where id = $1", [keep]))),
    ).toMatchObject({ code: "P0001", hint: "tax_id:invalid" });
    expect(await row("companies", keep)).toMatchObject({ country: "GB", tax_id: "ABC-1" });
    expect(await exists("companies", dup)).toBe(1);

    // the number alone: a foreign number under the kept Israeli country
    const keep2 = await insert("companies", { name: "ישראלית", country: "IL", tax_id: "514111111" });
    const dup2 = await insert("companies", { name: "ישראלית בע\"מ", country: "GB", tax_id: "UK-1234567" });
    expect(await pgError(merge("company", keep2, dup2, { tax_id: "merge" }))).toMatchObject({ code: "P0001", hint: "tax_id:invalid" });
    // a foreign number of a shape no person may type, under its own foreign country
    const dup3 = await insert("companies", { name: "זרה", country: "GB", tax_id: "#!" });
    expect(await pgError(merge("company", keep2, dup3, picksFor("company", ["tax_id"])))).toMatchObject({
      code: "P0001",
      hint: "tax_id:invalid_foreign",
    });
    expect(await row("companies", keep2)).toMatchObject({ country: "IL", tax_id: "514111111" });

    // a passing pair is stored the way the trigger stores a person's: trimmed, or an Israeli number padded to 9 digits
    const dup4 = await insert("companies", { name: "זרה 2", country: "GB", tax_id: "  AB 12  " });
    await merge("company", keep2, dup4, picksFor("company", ["tax_id"]));
    expect(await row("companies", keep2)).toMatchObject({ country: "GB", tax_id: "AB 12" });
    const keep5 = await insert("companies", { name: "ריפוד", country: "GB", tax_id: "X-9" });
    const dup5 = await insert("companies", { name: "ריפוד בע\"מ", country: "IL", tax_id: "12345674" });
    await merge("company", keep5, dup5, picksFor("company", ["tax_id"]));
    expect(await row("companies", keep5)).toMatchObject({ country: "IL", tax_id: "012345674" });
  });

  it("a channel's source is taken only with the channel itself", async () => {
    const keep = await insertLead(owner.id, org, { full_name: "מקור" });
    const dup = await insertLead(owner.id, org, { full_name: "מקור ב." });
    await asAdmin((q) => q("update public.leads set preferred_channel = 'email', preferred_channel_source = 'manual' where id = $1", [keep]));
    await asAdmin((q) => q("update public.leads set preferred_channel = 'sms', preferred_channel_source = 'form' where id = $1", [dup]));
    expect((await pgError(merge("lead", keep, dup, { preferred_channel_source: "merge" }))).code).toBe("22023");
    expect(await row("leads", keep)).toMatchObject({ preferred_channel: "email", preferred_channel_source: "manual" });
    expect(await exists("leads", dup)).toBe(1);
  });

  it("app.merge_pick_check is not callable from the API, nor by the service role", async () => {
    const e = await pgError(asUser(owner.id, (q) => q("select app.merge_pick_check($1, 'lead', '{}', '{}', '{}')", [org])));
    expect(e.code).toBe("42501");
    const granted = await asAdmin(async (q) =>
      (
        await q<{ ok: boolean }>(
          "select has_function_privilege(r, 'app.merge_pick_check(uuid, text, jsonb, jsonb, text[])', 'execute') as ok from unnest(array['service_role', 'authenticated', 'anon']) r",
        )
      ).rows.map((x) => x.ok),
    );
    expect(granted).toEqual([false, false, false]);
    // the helper that holds the merge's delete (020555) is callable by no role
    const helper = await asAdmin(async (q) =>
      (
        await q<{ ok: boolean }>(
          "select has_function_privilege(r, 'app.merge_delete_duplicate(uuid, text, uuid)', 'execute') as ok from unnest(array['service_role', 'authenticated', 'anon', 'public']) r",
        )
      ).rows.map((x) => x.ok),
    );
    expect(helper).toEqual([false, false, false, false]);
  });
});
