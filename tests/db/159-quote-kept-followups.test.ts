import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-07 follow-ups (owner, 18 October 2026): a sent quote kept after its customer was purged is read by owners, admins
 * and managers by role; a privacy erasure empties the free text of its lines too (descriptions, and the name of a free
 * line or a group heading), keeping product names, quantities, prices and amounts.
 */
describe("kept quotes of deleted customers (QUO-07 follow-ups)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string;
  let product: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];

  // a contact's sent quote with a product line, a free line and a group heading, all with personal free text; then the
  // contact is purged, which keeps the quote detached
  const keptQuote = async (name: string) => {
    const contact = await run(member, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).id);
    const quote = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, $2, $3) returning id", [org, `הצעה ל${name}`, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, kind, name, position) values ($1, $2, 'group', $3, 1)", [org, id, `הבית של ${name}`]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, product_id, name, description, quantity, unit_price_agorot, price_source, position) values ($1, $2, $3, 'התקנה', $4, 2, 10000, 'product', 2)",
        [org, id, product, `ברחוב של ${name}`],
      );
      await q("insert into public.quote_lines (organization_id, quote_id, name, description, unit_price_agorot, position) values ($1, $2, $3, $4, 5000, 3)", [
        org,
        id,
        `תיקון אצל ${name}`,
        `קומה 3, דירה של ${name}`,
      ]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    return { contact, quote };
  };

  beforeAll(async () => {
    owner = await createUser("qk-owner");
    org = await createOrg(owner.id, "עסק ההצעות השמורות");
    admin = await addMember(org, owner.id, "admin", "qk-admin");
    manager = await addMember(org, owner.id, "manager", "qk-manager");
    member = await addMember(org, owner.id, "member", "qk-member");
    viewer = await addMember(org, owner.id, "viewer", "qk-viewer");
    outsider = await createUser("qk-outsider");
    const otherOrg = await createOrg(outsider.id, "עסק אחר");
    void otherOrg;
    await run(owner, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    product = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'התקנה', 10000) returning id", [org])).id,
    );
  });

  it("owners, admins and managers by role read a kept quote and its lines; members, viewers and outsiders do not; nobody edits it", async () => {
    const { quote } = await keptQuote("יעל");
    for (const u of [owner, admin, manager]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quotes where id = $1", [quote])), u.email).toBe(1);
      expect(await run(u, (q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [quote])), u.email).toBe(3);
      expect(await run(u, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [quote])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("update public.quote_lines set name = 'x' where quote_id = $1", [quote])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quotes where id = $1", [quote])).rowCount), u.email).toBe(0);
    }
    for (const u of [member, viewer, outsider]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quotes where id = $1", [quote])), u.email).toBe(0);
      expect(await run(u, (q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [quote])), u.email).toBe(0);
    }
    // a manager who is suspended reads nothing
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, manager.id]));
    try {
      expect(await run(manager, (q) => count(q, "select 1 from public.quotes where id = $1", [quote]))).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, manager.id]));
    }
  });

  it("a privacy erasure empties the free text of the kept quote's lines and keeps what the amounts stand on", async () => {
    const { contact, quote } = await keptQuote("נועה");
    const before = await asAdmin(async (q) =>
      (await q<{ kind: string; name: string; quantity: string; unit_price_agorot: string; total_agorot: string; product_id: string | null }>(
        "select kind, name, quantity::text, unit_price_agorot::text, total_agorot::text, product_id from public.quote_lines where quote_id = $1 order by position",
        [quote],
      )).rows,
    );
    const totals = await asAdmin(async (q) => one<{ t: string; n: string }>(q, "select total_agorot::text as t, number_display as n from public.quotes where id = $1", [quote]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const after = await asAdmin(async (q) =>
      (await q<{ kind: string; name: string; description: string | null; quantity: string; unit_price_agorot: string; total_agorot: string; product_id: string | null }>(
        "select kind, name, description, quantity::text, unit_price_agorot::text, total_agorot::text, product_id from public.quote_lines where quote_id = $1 order by position",
        [quote],
      )).rows,
    );
    expect(after.map((l) => [l.kind, l.name, l.description])).toEqual([
      ["group", "קבוצה", null],
      ["item", "התקנה", null],
      ["item", "שורה", null],
    ]);
    expect(after.map((l) => [l.quantity, l.unit_price_agorot, l.total_agorot, l.product_id])).toEqual(before.map((l) => [l.quantity, l.unit_price_agorot, l.total_agorot, l.product_id]));
    expect(await asAdmin(async (q) => one<{ t: string; n: string }>(q, "select total_agorot::text as t, number_display as n from public.quotes where id = $1", [quote]))).toEqual(totals);
    // nothing of the old text is left in the audit log of the quote or its lines
    const leftovers = await asAdmin(async (q) =>
      (
        await q<{ c: string }>(
          `select a.changes::text as c from public.audit_log a
            where a.organization_id = $1
              and ((a.entity_type = 'quotes' and a.entity_id = $2)
                   or (a.entity_type = 'quote_lines' and a.entity_id in (select id from public.quote_lines where quote_id = $2)))`,
          [org, quote],
        )
      ).rows.map((r) => r.c),
    );
    expect(leftovers.length).toBeGreaterThan(0);
    expect(leftovers.filter((c) => c.includes("נועה"))).toEqual([]);
  });

  it("a kept quote's lines stay locked to people after the erasure", async () => {
    const { contact, quote } = await keptQuote("דנה");
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    for (const u of [owner, manager]) {
      expect(await run(u, async (q) => (await q("update public.quote_lines set description = 'x' where quote_id = $1", [quote])).rowCount), u.email).toBe(0);
      const refused = await pgError(run(u, (q) => q("insert into public.quote_lines (organization_id, quote_id, name) values ($1, $2, 'x')", [org, quote])));
      expect(refused.code, u.email).toBe("42501");
    }
  });
});
