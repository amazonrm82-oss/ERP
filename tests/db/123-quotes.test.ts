import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type QuoteRow = {
  id: string;
  status: string;
  deal_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  owner_id: string | null;
  prices_include_vat: boolean;
  vat_rate_bp: number | null;
  subtotal_agorot: string;
  discount_total_agorot: string;
  net_total_agorot: string;
  vat_agorot: string;
  total_agorot: string;
};

/**
 * QUO-01, QUO-02: quotes made from a deal or a contact, edited as drafts. Rights follow the deal (else the
 * contact); the server sets the identity columns and the totals by the one totals rule; lines copy what
 * they take from the product; groups and optional lines; the order; the plan flag; and the links to
 * merge, purge, privacy erasure, sample data and import undo.
 */
describe("quotes (QUO-01, QUO-02)", () => {
  let owner: U, admin: U, manager: U, member: U, other: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string, teamId: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const newCompany = (u: U, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, $2) returning id", [org, name])).id);
  const newContact = (u: U, name: string, company: string | null = null) =>
    run(u, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, $2, $3) returning id", [org, name, company])).id,
    );
  const newDeal = (u: U, contact: string | null, company: string | null = null) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, team_id) values ($1, 'עסקה', $2, $3, $4, $5, $6) returning id",
          [org, pipelineId, stageId, contact, company, teamId],
        )
      ).id,
    );
  const newQuote = (u: U, values: Record<string, unknown>) =>
    run(u, async (q) => {
      const keys = Object.keys(values);
      return one<QuoteRow>(
        q,
        `insert into public.quotes (organization_id, title, ${keys.join(", ")}) values ($1, 'הצעה', ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
        [org, ...Object.values(values)],
      );
    });
  const newLine = (u: U, quote: string, values: Record<string, unknown>) =>
    run(u, async (q) => {
      const keys = Object.keys(values);
      return one<{ id: string; total_agorot: string; vat_exempt: boolean; billing: string; unit_name: string | null }>(
        q,
        `insert into public.quote_lines (organization_id, quote_id, ${keys.join(", ")}) values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")}) returning *`,
        [org, quote, ...Object.values(values)],
      );
    });
  const quote = (id: string) => asAdmin(async (q) => one<QuoteRow>(q, "select * from public.quotes where id = $1", [id]));
  const newProduct = (fields: { name: string; price?: number; vat?: string; billing?: string; active?: boolean }) =>
    run(owner, async (q) => {
      const unit = (await one<{ id: string }>(q, "select id from public.product_units where organization_id = $1 order by position limit 1", [org])).id;
      return (
        await one<{ id: string }>(
          q,
          "insert into public.products (organization_id, name, price_agorot, vat_kind, billing, is_active, unit_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, fields.name, fields.price ?? 10000, fields.vat ?? "taxable", fields.billing ?? "one_time", fields.active ?? true, unit],
        )
      ).id;
    });
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const setVisibility = (v: "org" | "team" | "own") => run(owner, (q) => q("update public.organizations set record_visibility = $1 where id = $2", [v, org]));

  beforeAll(async () => {
    owner = await createUser("quo-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    admin = await addMember(org, owner.id, "admin", "quo-admin");
    manager = await addMember(org, owner.id, "manager", "quo-manager");
    member = await addMember(org, owner.id, "member", "quo-member");
    other = await addMember(org, owner.id, "member", "quo-other");
    viewer = await addMember(org, owner.id, "viewer", "quo-viewer");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    teamId = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).id);
    await asAdmin((q) => q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true) on conflict do nothing", [org, teamId, manager.id]));
    // a business that charges VAT (TAX-01), prices typed before VAT
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
  });

  it("QUO-01: a quote from a deal takes the deal's customer; one from a contact takes its company; the server sets the rest", async () => {
    const company = await newCompany(member, "חברה");
    const contact = await newContact(member, "יוסי כהן", company);
    const deal = await newDeal(member, contact);
    const fromDeal = await newQuote(member, { deal_id: deal, owner_id: other.id }).catch((e) => e);
    // owner_id is not a client column
    expect(fromDeal.code).toBe("42501");
    const q1 = await newQuote(member, { deal_id: deal });
    expect(q1).toMatchObject({ status: "draft", deal_id: deal, contact_id: contact, company_id: company, owner_id: member.id, prices_include_vat: false, vat_rate_bp: 1800 });
    const q2 = await newQuote(member, { contact_id: contact });
    expect(q2).toMatchObject({ deal_id: null, contact_id: contact, company_id: company });
    // a quote needs a deal or a contact; a status cannot be sent
    // with no deal and no contact nobody may write it (RLS answers before the check constraint)
    // (a plain insert: with RETURNING the select policy would refuse the row anyway)
    expect((await pgError(run(member, (q) => q("insert into public.quotes (organization_id, title, company_id) values ($1, 'x', $2)", [org, company])))).code).toBe("42501");
    expect((await pgError(newQuote(member, { deal_id: deal, status: "accepted" }))).code).toBe("42501");
  });

  it("rights follow the deal: its editors write, others who read it only read, the rest see nothing", async () => {
    await setVisibility("own");
    const deal = await newDeal(member, null);
    const created = await newQuote(member, { deal_id: deal });
    // the team's manager and an admin may edit the deal, so they may write its quote
    for (const u of [manager, admin, owner]) {
      expect(await run(u, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [created.id])).rowCount), u.email).toBe(1);
    }
    // a colleague who does not read the deal sees nothing and cannot add one
    expect(await run(other, (q) => count(q, "select 1 from public.quotes where id = $1", [created.id]))).toBe(0);
    expect((await pgError(newQuote(other, { deal_id: deal }))).code).toBe("42501");
    expect(await run(other, async (q) => (await q("update public.quotes set notes = 'y' where id = $1", [created.id])).rowCount)).toBe(0);
    expect(await run(other, async (q) => (await q("delete from public.quotes where id = $1", [created.id])).rowCount)).toBe(0);
    // under 'org' a colleague reads the deal and the quote, but may not edit either; a viewer only reads
    await setVisibility("org");
    for (const u of [other, viewer]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quotes where id = $1", [created.id])), u.email).toBe(1);
      expect(await run(u, async (q) => (await q("update public.quotes set notes = 'z' where id = $1", [created.id])).rowCount), u.email).toBe(0);
      expect((await pgError(newQuote(u, { deal_id: deal }))).code, u.email).toBe("42501");
      expect((await pgError(newLine(u, created.id, { name: "x", unit_price_agorot: 100 }))).code, u.email).toBe("42501");
    }
    // a deal in the recycle bin locks its quotes
    await run(admin, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    expect(await run(member, async (q) => (await q("update public.quotes set notes = 'bin' where id = $1", [created.id])).rowCount)).toBe(0);
    await run(admin, (q) => q("update public.deals set deleted_at = null where id = $1", [deal]));
  });

  it("a person links only a contact and company they read and that are live", async () => {
    await setVisibility("own");
    const hidden = await newContact(other, "איש של אחר");
    const mine = await newContact(member, "שלי");
    const deal = await newDeal(member, mine);
    const quoteRow = await newQuote(member, { deal_id: deal });
    expect((await pgError(run(member, (q) => q("update public.quotes set contact_id = $2 where id = $1", [quoteRow.id, hidden])))).hint).toBe("quote:contact");
    const hiddenCompany = await newCompany(other, "חברה נסתרת");
    expect((await pgError(run(member, (q) => q("update public.quotes set company_id = $2 where id = $1", [quoteRow.id, hiddenCompany])))).hint).toBe("quote:company");
    // a contact in the bin is readable (the bin lists it) but cannot be linked
    const binned = await newContact(member, "בסל");
    await run(admin, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(run(member, (q) => q("update public.quotes set contact_id = $2 where id = $1", [quoteRow.id, binned])))).hint).toBe("quote:contact");
    // the deal's own contact is always allowed, even when the person does not read it
    const theirs = await newContact(admin, "איש של מנהל");
    const dealWithHidden = await run(admin, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'x', $2, $3, $4, $5) returning id", [org, pipelineId, stageId, theirs, member.id])).id,
    );
    expect((await newQuote(member, { deal_id: dealWithHidden })).contact_id).toBe(theirs);
    await setVisibility("org");
  });

  it("the plan flag 'quotes' gates a new quote", async () => {
    const deal = await newDeal(member, null);
    await setFeatures({ quotes: false });
    try {
      expect((await pgError(newQuote(member, { deal_id: deal }))).hint).toBe("feature:quotes");
      // an outsider of the deal learns nothing about the plan
      await setVisibility("own");
      expect((await pgError(newQuote(other, { deal_id: deal }))).code).toBe("42501");
      await setVisibility("org");
    } finally {
      await setFeatures({});
    }
  });

  it("acceptance 4.6 on a quote: 100 before VAT x 3, 10% off = 270.00 + VAT 48.60 = 318.60; lines copy the product", async () => {
    const product = await newProduct({ name: "מוצר ב-100", billing: "monthly" });
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    const line = await newLine(member, qr.id, {
      product_id: product, name: "מוצר ב-100", quantity: 3, unit_price_agorot: 10000, discount_bp: 1000, price_source: "product", vat_exempt: true, billing: "one_time",
    });
    expect(line).toMatchObject({ total_agorot: "27000", vat_exempt: false, billing: "monthly" });
    expect(line.unit_name).not.toBeNull();
    expect(await quote(qr.id)).toMatchObject({ subtotal_agorot: "27000", net_total_agorot: "27000", vat_agorot: "4860", total_agorot: "31860" });
    // a change of a line recomputes the quote; a group heading counts nothing
    await run(member, (q) => q("update public.quote_lines set quantity = 1 where id = $1", [line.id]));
    await newLine(member, qr.id, { kind: "group", name: "שלב ב" });
    expect(await quote(qr.id)).toMatchObject({ net_total_agorot: "9000", vat_agorot: "1620", total_agorot: "10620" });
    // an exempt product's line carries no VAT
    const exempt = await newProduct({ name: "פטור", price: 5000, vat: "exempt" });
    expect((await newLine(member, qr.id, { product_id: exempt, name: "פטור", unit_price_agorot: 5000, price_source: "product" })).vat_exempt).toBe(true);
    expect(await quote(qr.id)).toMatchObject({ net_total_agorot: "14000", vat_agorot: "1620", total_agorot: "15620" });
  });

  it("optional lines count only while selected; the document discount and 'no VAT' with a reason", async () => {
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    const base = await newLine(member, qr.id, { name: "בסיס", unit_price_agorot: 10000 });
    const extra = await newLine(member, qr.id, { name: "תוספת", unit_price_agorot: 5000, is_optional: true });
    expect(await quote(qr.id)).toMatchObject({ net_total_agorot: "10000" });
    await run(member, (q) => q("update public.quote_lines set optional_selected = true where id = $1", [extra.id]));
    expect(await quote(qr.id)).toMatchObject({ net_total_agorot: "15000", vat_agorot: "2700" });
    // a selected line that is not optional is refused; a group with a price is refused
    expect((await pgError(run(member, (q) => q("update public.quote_lines set is_optional = false where id = $1", [extra.id])))).code).toBe("23514");
    expect((await pgError(newLine(member, qr.id, { kind: "group", name: "x", unit_price_agorot: 1 }))).code).toBe("23514");
    // a 10% discount on the quote, then "this quote without VAT" (Eilat)
    await run(member, (q) => q("update public.quotes set discount_bp = 1000 where id = $1", [qr.id]));
    expect(await quote(qr.id)).toMatchObject({ discount_total_agorot: "1500", net_total_agorot: "13500", vat_agorot: "2430", total_agorot: "15930" });
    await run(member, (q) => q("update public.quotes set no_vat_reason = 'eilat' where id = $1", [qr.id]));
    expect(await quote(qr.id)).toMatchObject({ vat_rate_bp: 0, vat_agorot: "0", total_agorot: "13500" });
    // 'other' needs a note; no VAT only for prices before VAT
    expect((await pgError(run(member, (q) => q("update public.quotes set no_vat_reason = 'other' where id = $1", [qr.id])))).code).toBe("23514");
    expect((await pgError(run(member, (q) => q("update public.quotes set prices_include_vat = true where id = $1", [qr.id])))).code).toMatch(/^(23514|P0001)$/);
    expect(base.id).toBeTruthy();
  });

  it("the VAT mode of a quote changes only while it has no lines; a discount needs its plan flag", async () => {
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    await run(member, (q) => q("update public.quotes set prices_include_vat = true where id = $1", [qr.id]));
    await newLine(member, qr.id, { name: "שורה", unit_price_agorot: 11800 });
    expect(await quote(qr.id)).toMatchObject({ net_total_agorot: "10000", vat_agorot: "1800", total_agorot: "11800" });
    expect((await pgError(run(member, (q) => q("update public.quotes set prices_include_vat = false where id = $1", [qr.id])))).hint).toBe("quote:vat_locked");
    await setFeatures({ discounts: false });
    try {
      expect((await pgError(run(member, (q) => q("update public.quotes set discount_agorot = 100 where id = $1", [qr.id])))).hint).toBe("feature:discounts");
      expect((await pgError(newLine(member, qr.id, { name: "הנחה", unit_price_agorot: 100, discount_bp: 500 }))).hint).toBe("feature:discounts");
    } finally {
      await setFeatures({});
    }
  });

  it("only offerable products; a quote that is no longer a draft is locked for people", async () => {
    const archived = await newProduct({ name: "לא פעיל", active: false });
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    expect((await pgError(newLine(member, qr.id, { product_id: archived, name: "x", price_source: "product" }))).hint).toBe("quote_lines:product");
    const line = await newLine(member, qr.id, { name: "שורה", unit_price_agorot: 100 });
    await asAdmin((q) => q("update public.quotes set status = 'sent' where id = $1", [qr.id]));
    expect(await run(member, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [qr.id])).rowCount)).toBe(0);
    expect(await run(member, async (q) => (await q("update public.quote_lines set name = 'y' where id = $1", [line.id])).rowCount)).toBe(0);
    expect(await run(member, async (q) => (await q("delete from public.quote_lines where id = $1", [line.id])).rowCount)).toBe(0);
    expect((await pgError(newLine(member, qr.id, { name: "z", unit_price_agorot: 1 }))).code).toBe("42501");
    expect(await run(admin, async (q) => (await q("delete from public.quotes where id = $1", [qr.id])).rowCount)).toBe(0);
  });

  it("QUO-02: lines are reordered in one call, and a quote holds at most 200", async () => {
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    const a = await newLine(member, qr.id, { name: "א", position: 1, unit_price_agorot: 100 });
    const b = await newLine(member, qr.id, { name: "ב", position: 2, unit_price_agorot: 100 });
    const c = await newLine(member, qr.id, { kind: "group", name: "ג", position: 3 });
    expect(await run(member, async (q) => (await one<{ n: number }>(q, "select public.quote_lines_reorder($1, $2, $3) as n", [org, qr.id, [c.id, a.id, b.id]])).n)).toBe(3);
    const order = await run(member, async (q) => (await q<{ name: string }>("select name from public.quote_lines where quote_id = $1 order by position", [qr.id])).rows.map((r) => r.name));
    expect(order).toEqual(["ג", "א", "ב"]);
    // someone who may not edit the quote moves nothing
    await setVisibility("own");
    expect(await run(other, async (q) => (await one<{ n: number }>(q, "select public.quote_lines_reorder($1, $2, $3) as n", [org, qr.id, [a.id, b.id, c.id]])).n)).toBe(0);
    await setVisibility("org");
    await run(member, (q) =>
      q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) select $1, $2, 'שורה ' || g, 1 from generate_series(1, 197) g", [org, qr.id]),
    );
    expect((await pgError(newLine(member, qr.id, { name: "201", unit_price_agorot: 1 }))).hint).toBe("quote_lines:max");
  });

  it("a merged contact's quotes move to the kept contact; purging a deal removes its quotes; erasure clears their entries", async () => {
    const keep = await newContact(owner, "שמור");
    const dup = await newContact(owner, "כפול");
    const qDup = await newQuote(owner, { contact_id: dup });
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect((await quote(qDup.id)).contact_id).toBe(keep);

    const deal = await newDeal(owner, null);
    const qDeal = await newQuote(owner, { deal_id: deal });
    const line = await newLine(owner, qDeal.id, { name: "פרטים אישיים בשורה", unit_price_agorot: 100 });
    await run(owner, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    await run(owner, (q) => q("delete from public.deals where id = $1", [deal]));
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where id = $1", [qDeal.id]))).toBe(0);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, deal]));
    const left = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where organization_id = $1 and entity_id = any($2) and changes <> '{\"erased\": true}'::jsonb", [org, [qDeal.id, line.id]]),
    );
    expect(left).toBe(0);
  });

  it("a record with a quote is real work for sample removal and for import undo", async () => {
    const contact = await newContact(owner, "לדוגמה");
    const snapshot = await asAdmin(async (q) => (await one<{ s: unknown }>(q, "select app.sample_row($1, 'contact', $2) as s", [org, contact])).s);
    const untouched = () =>
      asAdmin(async (q) => (await one<{ u: boolean }>(q, "select app.sample_untouched($1, 'contact', $2, $3::jsonb) as u", [org, contact, JSON.stringify(snapshot)])).u);
    expect(await untouched()).toBe(true);
    await newQuote(owner, { contact_id: contact });
    expect(await untouched()).toBe(false);
    expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now(), null) as w", [org, contact])).w)).toBe(true);
  });

  // --- review af35fc9 ------------------------------------------------------

  it("purging a contact keeps a deal's quote that names it (detached) and removes its contact-only drafts; erasure stays clean", async () => {
    const contact = await newContact(member, "יימחק");
    const deal = await newDeal(member, contact);
    const dealQuote = await newQuote(member, { deal_id: deal });
    expect(dealQuote.contact_id).toBe(contact);
    const own = await newQuote(member, { contact_id: contact });
    const ownLine = await newLine(member, own.id, { name: "שורה של איש קשר", unit_price_agorot: 100 });
    // a colleague's deal quote that names the same contact (readable under 'org')
    const otherDeal = await newDeal(other, null);
    const otherQuote = await newQuote(other, { deal_id: otherDeal });
    await run(other, (q) => q("update public.quotes set contact_id = $2 where id = $1", [otherQuote.id, contact]));
    expect((await quote(otherQuote.id)).contact_id).toBe(contact);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    expect(await quote(dealQuote.id)).toMatchObject({ deal_id: deal, contact_id: null });
    expect(await quote(otherQuote.id)).toMatchObject({ deal_id: otherDeal, contact_id: null });
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where id = $1", [own.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1", [deal]))).toBe(1);

    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const left = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where organization_id = $1 and entity_id = any($2) and changes <> '{\"erased\": true}'::jsonb", [org, [own.id, ownLine.id]]),
    );
    expect(left).toBe(0);
    // the deal quotes are not the contact's: their entries stay
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes <> '{\"erased\": true}'::jsonb", [dealQuote.id]))).toBeGreaterThan(0);
  });

  it("a contact-only quote: its contact's editors write; a colleague, a viewer and own-visibility outsiders do not; a contact in the bin locks it", async () => {
    const contact = await newContact(member, "איש קשר להצעה");
    const qr = await newQuote(member, { contact_id: contact });
    const line = await newLine(member, qr.id, { name: "שורה", unit_price_agorot: 100 });
    const edits = (u: U) => run(u, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [qr.id])).rowCount);
    for (const u of [member, owner, admin]) expect(await edits(u), u.email).toBe(1);
    // under 'org' a colleague and a viewer read the contact and the quote, but write nothing
    for (const u of [other, viewer]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quotes where id = $1", [qr.id])), u.email).toBe(1);
      expect(await edits(u), u.email).toBe(0);
      expect((await pgError(newQuote(u, { contact_id: contact }))).code, u.email).toBe("42501");
      expect(await run(u, async (q) => (await q("delete from public.quotes where id = $1", [qr.id])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quote_lines where id = $1", [line.id])).rowCount), u.email).toBe(0);
    }
    // under 'own' the colleague sees neither the quote nor its lines
    await setVisibility("own");
    try {
      expect(await run(other, (q) => count(q, "select 1 from public.quotes where id = $1", [qr.id]))).toBe(0);
      expect(await run(other, (q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [qr.id]))).toBe(0);
    } finally {
      await setVisibility("org");
    }
    // moving the quote onto a contact the person reads but may not edit is refused
    const colleagues = await newContact(other, "של עמית");
    expect((await pgError(run(member, (q) => q("update public.quotes set contact_id = $2 where id = $1", [qr.id, colleagues])))).code).toBe("42501");
    expect((await quote(qr.id)).contact_id).toBe(contact);
    // a contact in the bin locks its quotes and takes no new one
    await run(admin, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    try {
      expect(await edits(member)).toBe(0);
      expect(await run(member, async (q) => (await q("update public.quote_lines set name = 'y' where id = $1", [line.id])).rowCount)).toBe(0);
      expect((await pgError(newQuote(member, { contact_id: contact }))).code).toMatch(/^(42501|P0001)$/);
    } finally {
      await run(admin, (q) => q("update public.contacts set deleted_at = null where id = $1", [contact]));
    }
  });

  it("a reader who may not edit changes and deletes nothing, even without a WHERE clause", async () => {
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    await newLine(member, qr.id, { name: "שורה", unit_price_agorot: 100 });
    const before = await asAdmin(async (q) => ({
      quotes: await count(q, "select 1 from public.quotes where organization_id = $1", [org]),
      lines: await count(q, "select 1 from public.quote_lines where organization_id = $1", [org]),
    }));
    for (const u of [viewer]) {
      expect(await run(u, async (q) => (await q("update public.quote_lines set name = 'x'")).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("update public.quotes set notes = 'x'")).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quote_lines")).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quotes")).rowCount), u.email).toBe(0);
    }
    // a colleague reads this deal under 'org' but may not edit it
    expect(await run(other, async (q) => (await q("update public.quote_lines set name = 'x' where quote_id = $1", [qr.id])).rowCount)).toBe(0);
    expect(
      await asAdmin(async (q) => ({
        quotes: await count(q, "select 1 from public.quotes where organization_id = $1", [org]),
        lines: await count(q, "select 1 from public.quote_lines where organization_id = $1", [org]),
      })),
    ).toEqual(before);
  });

  it("a read-only business writes no quotes and no lines", async () => {
    const deal = await newDeal(member, null);
    const qr = await newQuote(member, { deal_id: deal });
    const line = await newLine(member, qr.id, { name: "שורה", unit_price_agorot: 100 });
    const status = await asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.organizations where id = $1", [org])).status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      for (const u of [member, owner]) {
        expect((await pgError(newQuote(u, { deal_id: deal }))).code, u.email).toBe("42501");
        expect(await run(u, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [qr.id])).rowCount), u.email).toBe(0);
        expect((await pgError(newLine(u, qr.id, { name: "x", unit_price_agorot: 1 }))).code, u.email).toBe("42501");
        expect(await run(u, async (q) => (await q("update public.quote_lines set name = 'x' where id = $1", [line.id])).rowCount), u.email).toBe(0);
        expect(await run(u, async (q) => (await q("delete from public.quote_lines where id = $1", [line.id])).rowCount), u.email).toBe(0);
        expect(await run(u, async (q) => (await q("delete from public.quotes where id = $1", [qr.id])).rowCount), u.email).toBe(0);
      }
      // still read
      expect(await run(member, (q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [qr.id]))).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
  });

  it("the policies keep their own checks: the plan flag on insert, and the update checks mirror the read side", async () => {
    // Defence in depth: the triggers also refuse these cases today, and the columns these checks guard
    // (status, quote_id) have no client grant, so only the policy text shows a weakening.
    const policies = await asAdmin(async (q) =>
      (await q<{ policyname: string; qual: string | null; with_check: string | null }>(
        "select policyname, qual, with_check from pg_policies where schemaname = 'public' and tablename in ('quotes', 'quote_lines')",
      )).rows,
    );
    const by = (name: string) => policies.find((p) => p.policyname === name);
    expect(by("quotes_insert")?.with_check).toMatch(/org_has_feature\(organization_id, 'quotes'::text\)/);
    expect(by("quotes_insert")?.with_check).toMatch(/quote_editable/);
    for (const name of ["quotes_update", "quote_lines_update"]) {
      expect(by(name)?.with_check, name).toBe(by(name)?.qual);
      expect(by(name)?.qual, name).toMatch(/status = 'draft'::text/);
      expect(by(name)?.qual, name).toMatch(/quote_editable/);
    }
  });

  it("deleting a whole business with a deal quote that names a contact works, and takes the quotes with it", async () => {
    const boss = await createUser("quo-doomed-owner");
    const doomed = await createOrg(boss.id, "עסק שנמחק");
    const pipe = await defaultPipeline(doomed);
    const ids = await asUser(boss.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [doomed])).id;
      const deal = (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id",
          [doomed, pipe.pipelineId, pipe.stages[0].id, contact],
        )
      ).id;
      const quoteRow = await one<{ id: string; contact_id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id, contact_id", [doomed, deal]);
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שורה', 100)", [doomed, quoteRow.id]);
      return { contact, quote: quoteRow };
    });
    expect(ids.quote.contact_id).toBe(ids.contact);
    await asAdmin((q) => q("delete from public.organizations where id = $1", [doomed]));
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where organization_id = $1", [doomed]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_lines where organization_id = $1", [doomed]))).toBe(0);
  });

  it("a quote that is no longer a draft keeps its amounts and rate when its contact is purged after a VAT change; a draft is worked out again", async () => {
    const setVat = (status: string) =>
      run(owner, (q) => q("update public.org_document_settings set vat_status = $2 where organization_id = $1", [org, status]));
    const contact = await newContact(member, "לקוח שנמחק");
    const deal = await newDeal(member, contact);
    const sent = await newQuote(member, { deal_id: deal });
    await newLine(member, sent.id, { name: "שורה", unit_price_agorot: 10000 });
    const draft = await newQuote(member, { deal_id: deal });
    await newLine(member, draft.id, { name: "שורה", unit_price_agorot: 10000 });
    for (const id of [sent.id, draft.id]) expect(await quote(id)).toMatchObject({ vat_rate_bp: 1800, vat_agorot: "1800", total_agorot: "11800" });
    // the server sends it (QUO-07 will); the business then stops charging VAT
    await asAdmin((q) => q("update public.quotes set status = 'sent' where id = $1", [sent.id]));
    await setVat("exempt");
    try {
      await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
      await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
      expect(await quote(sent.id)).toMatchObject({
        status: "sent",
        contact_id: null,
        vat_rate_bp: 1800,
        subtotal_agorot: "10000",
        net_total_agorot: "10000",
        vat_agorot: "1800",
        total_agorot: "11800",
      });
      // the draft follows the business as it is now
      expect(await quote(draft.id)).toMatchObject({ contact_id: null, vat_rate_bp: 0, vat_agorot: "0", total_agorot: "10000" });
      // a server update of a sent quote's other columns leaves its amounts too
      await asAdmin((q) => q("update public.quotes set notes = 'נשלחה' where id = $1", [sent.id]));
      expect(await quote(sent.id)).toMatchObject({ vat_rate_bp: 1800, total_agorot: "11800" });
    } finally {
      await setVat("licensed");
    }
  });

  it("every status but draft keeps the amounts and refuses changes to the pricing inputs, for every writer", async () => {
    const setVat = (status: string) =>
      run(owner, (q) => q("update public.org_document_settings set vat_status = $2 where organization_id = $1", [org, status]));
    const statuses = ["sent", "accepted", "expired", "cancelled"];
    const made: Record<string, string> = {};
    for (const status of statuses) {
      const deal = await newDeal(member, null);
      const qr = await newQuote(member, { deal_id: deal });
      await newLine(member, qr.id, { name: "שורה", unit_price_agorot: 10000 });
      await asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [qr.id, status]));
      made[status] = qr.id;
    }
    await setVat("exempt");
    try {
      for (const status of statuses) {
        const id = made[status];
        // a server update of another column leaves the amounts as they were sent
        await asAdmin((q) => q("update public.quotes set notes = 'עדכון' where id = $1", [id]));
        expect(await quote(id), status).toMatchObject({ status, vat_rate_bp: 1800, net_total_agorot: "10000", vat_agorot: "1800", total_agorot: "11800" });
        // the inputs the amounts came from are refused, even for the server
        for (const set of ["discount_bp = 5000", "discount_agorot = 100", "prices_include_vat = true", "no_vat_reason = 'eilat'"]) {
          expect((await pgError(asAdmin((q) => q(`update public.quotes set ${set} where id = $1`, [id])))).hint, `${status}: ${set}`).toBe("quote:frozen");
        }
        expect(await quote(id), status).toMatchObject({ discount_bp: null, discount_agorot: null, prices_include_vat: false, total_agorot: "11800" });
      }
    } finally {
      await setVat("licensed");
    }
  });
});
