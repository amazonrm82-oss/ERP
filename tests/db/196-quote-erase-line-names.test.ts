import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-07 / GAP-09, owner's answer of 19 October 2026: a privacy erasure of a sent quote's customer empties the names of
 * lines that were edited by hand (a product line whose name differs from its product's catalog name takes the catalog
 * name), and keeps the payment steps, their milestones and the quote's terms.
 */
describe("erasing a kept quote: hand-edited line names (QUO-07)", () => {
  let owner: U, member: U;
  let org: string;
  let product: string, gone: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];

  beforeAll(async () => {
    owner = await createUser("qel-owner");
    org = await createOrg(owner.id, "עסק המחיקות");
    member = await addMember(org, owner.id, "member", "qel-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, products: true })]));
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    product = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'התקנה', 10000) returning id", [org])).id);
    gone = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'ארון', 20000) returning id", [org])).id);
  });

  it("a product line renamed by hand takes the catalog name; one named as in the catalog keeps it; steps, milestones and terms stay", async () => {
    const contact = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'נועה') returning id", [org])).id);
    const quote = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id, terms) values ($1, 'הצעה', $2, 'תשלום שוטף + 30') returning id", [org, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source, position) values ($1, $2, $3, 'התקנה', 10000, 'product', 1)", [
        org,
        id,
        product,
      ]);
      await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source, position) values ($1, $2, $3, 'התקנה אצל נועה כהן', 10000, 'product', 2)", [
        org,
        id,
        product,
      ]);
      await q("insert into public.quote_lines (organization_id, quote_id, product_id, name, unit_price_agorot, price_source, position) values ($1, $2, $3, 'ארון לנועה', 20000, 'product', 3)", [
        org,
        id,
        gone,
      ]);
      await q(
        "insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, milestone) values ($1, $2, 1, 'מקדמה', 3000, 'בחתימה'), ($1, $2, 2, 'סיום', 7000, 'במסירה לנועה')",
        [org, id],
      );
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    // the catalog renames the second product after the quote was sent: its line's name differs from the catalog's now
    await asUser(owner.id, (q) => q("update public.products set name = 'ארון קיר' where id = $1", [gone]));
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contact]);
      await q("delete from public.contacts where id = $1", [contact]);
    });
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));

    const names = await asAdmin(async (q) => (await q<{ name: string }>("select name from public.quote_lines where quote_id = $1 order by position", [quote])).rows.map((r) => r.name));
    expect(names).toEqual(["התקנה", "התקנה", "ארון קיר"]);
    const steps = await asAdmin(async (q) =>
      (await q<{ name: string; milestone: string | null; percent_bp: number }>("select name, milestone, percent_bp from public.quote_payment_steps where quote_id = $1 order by position", [quote])).rows,
    );
    expect(steps).toEqual([
      { name: "מקדמה", milestone: "בחתימה", percent_bp: 3000 },
      { name: "סיום", milestone: "במסירה לנועה", percent_bp: 7000 },
    ]);
    expect(await asAdmin(async (q) => (await one<{ t: string }>(q, "select terms as t from public.quotes where id = $1", [quote])).t)).toBe("תשלום שוטף + 30");
  });

  it("the cancel reason of an accepted quote goes, from the quote, its timeline entry and the entry's history", async () => {
    const pipe = await asAdmin(async (q) =>
      (await one<{ p: string; s: string }>(q, "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1", [org])),
    );
    const ids = await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'יעל', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id", [
          org,
          pipe.p,
          pipe.s,
          contact,
          member.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [org, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 100)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return { contact, deal, quote };
    });
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [ids.quote]));
    await asUser(owner.id, (q) => q("select public.quote_cancel_accepted($1, $2, 'יעל כהן ביקשה לבטל')", [org, ids.quote]));
    const entry = await asAdmin(async (q) => (await one<{ id: string; body: string }>(q, "select id, body from public.activities where deal_id = $1 and metadata->>'kind' = 'quote_cancelled'", [ids.deal])));
    expect(entry.body).toContain("סיבה: יעל כהן");

    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [ids.contact]);
      await q("delete from public.contacts where id = $1", [ids.contact]);
    });
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, ids.contact]));

    expect(await asAdmin(async (q) => (await one<{ r: string | null }>(q, "select cancel_reason as r from public.quotes where id = $1", [ids.quote])).r)).toBeNull();
    const after = await asAdmin(async (q) => (await one<{ body: string }>(q, "select body from public.activities where id = $1", [entry.id])).body);
    expect(after).toMatch(/בוטלה/);
    expect(after).not.toContain("סיבה");
    const history = await asAdmin(async (q) =>
      (
        await q<{ c: string }>(
          "select changes::text as c from public.audit_log where organization_id = $1 and ((entity_type = 'activities' and entity_id = $2) or (entity_type = 'quotes' and entity_id = $3))",
          [org, entry.id, ids.quote],
        )
      ).rows.map((r) => r.c),
    );
    expect(history.filter((c) => c.includes("יעל"))).toEqual([]);
  });
});
