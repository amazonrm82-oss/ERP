import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";
import { migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

type U = { id: string };

// Re-running this migration puts back its own functions (app.price_list_lines_vat, which PRM-01 redefines later);
// rerunClosure adds every later migration that redefines one of them, so no later test sees an old body.
const RERUN = rerunClosure([migrationFile("_price_list_vat.sql")]);

// Owner, 13 October 2026 (DECISIONS.md "מע"מ במחירון"): one "prices include VAT" setting per price list,
// starting from the business's setting, locked once the list has prices; every line takes the list's flag.
describe("one VAT setting per price list (PL-01 follow-up)", () => {
  let owner: U, owner2: U, member: U;
  let org: string, grossOrg: string;
  let product: string, product2: string, exemptProduct: string;

  const newList = (userId: string, name: string, o = org, extra: Record<string, unknown> = {}) =>
    asUser(userId, async (q) => {
      const values: Record<string, unknown> = { name, ...extra };
      const keys = Object.keys(values);
      const sql = `insert into public.price_lists (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => values[k])])).rows[0].id;
    });
  const listVat = (id: string) =>
    asAdmin(async (q) => (await q<{ v: boolean }>("select prices_include_vat as v from public.price_lists where id = $1", [id])).rows[0].v);
  const insertLine = (userId: string, list: string, values: Record<string, unknown>, o = org) =>
    asUser(userId, async (q) => {
      const all: Record<string, unknown> = { price_list_id: list, product_id: product, ...values };
      const keys = Object.keys(all);
      const sql = `insert into public.price_list_lines (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => all[k])])).rows[0].id;
    });
  const lineVat = (id: string) =>
    asAdmin(async (q) => (await q<{ v: boolean }>("select price_includes_vat as v from public.price_list_lines where id = $1", [id])).rows[0].v);
  const newProduct = (userId: string, name: string, o = org, vatKind = "taxable") =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot, vat_kind) values ($1, $2, 10000, $3) returning id", [o, name, vatKind])).rows[0].id,
    );
  const setVat = (userId: string, list: string, value: boolean) =>
    asUser(userId, async (q) => (await q("update public.price_lists set prices_include_vat = $2 where id = $1", [list, value])).rowCount);

  beforeAll(async () => {
    owner = await createUser("plv-owner");
    owner2 = await createUser("plv-owner2");
    org = await createOrg(owner.id);
    grossOrg = await createOrg(owner.id, "עסק שמקליד כולל מע\"מ");
    await createOrg(owner2.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "plv-member");
    product = await newProduct(owner.id, "מוצר");
    product2 = await newProduct(owner.id, "מוצר שני");
    exemptProduct = await newProduct(owner.id, "פטור", org, "exempt");
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, prices_include_vat) values ($1, true) on conflict (organization_id) do update set prices_include_vat = true", [grossOrg]),
    );
  });

  it("a new list starts from the business's setting (false without a settings row); a chosen value wins", async () => {
    expect(await listVat(await newList(owner.id, "רגיל"))).toBe(false);
    expect(await listVat(await newList(owner.id, "כולל", grossOrg))).toBe(true);
    expect(await listVat(await newList(owner.id, "נטו בעסק כולל", grossOrg, { prices_include_vat: false }))).toBe(false);
    expect(await listVat(await newList(owner.id, "כולל בעסק נטו", org, { prices_include_vat: true }))).toBe(true);
    // the setting is not null
    expect((await pgError(asAdmin((q) => q("update public.price_lists set prices_include_vat = null where organization_id = $1", [org])))).code).toBe("23502");
  });

  it("every fixed price takes the list's flag; a discount takes none; the client cannot choose it", async () => {
    const gross = await newList(owner.id, "מחירון כולל", org, { prices_include_vat: true });
    const net = await newList(owner.id, "מחירון נטו", org, { prices_include_vat: false });
    expect(await lineVat(await insertLine(owner.id, gross, { price_agorot: 11800 }))).toBe(true);
    expect(await lineVat(await insertLine(owner.id, gross, { min_quantity: 10, discount_bp: 500 }))).toBe(false);
    // a product without VAT still carries the list's flag; productPriceFor() reads it as the net price
    expect(await lineVat(await insertLine(owner.id, gross, { product_id: exemptProduct, price_agorot: 4000 }))).toBe(true);
    expect(await lineVat(await insertLine(owner.id, net, { price_agorot: 10000 }))).toBe(false);
    // no column grant any more: sending a mode is refused
    expect((await pgError(insertLine(owner.id, net, { product_id: product2, price_agorot: 1, price_includes_vat: true }))).code).toBe("42501");
    const id = await insertLine(owner.id, net, { product_id: product2, price_agorot: 1 });
    expect((await pgError(asUser(owner.id, (q) => q("update public.price_list_lines set price_includes_vat = true where id = $1", [id])))).code).toBe("42501");
    // a server writer that sends a mode gets the list's anyway
    const serverLine = await asAdmin(async (q) =>
      (await q<{ id: string }>(
        "insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, price_agorot, price_includes_vat) values ($1, $2, $3, 5, 900, true) returning id",
        [org, net, product2],
      )).rows[0].id,
    );
    expect(await lineVat(serverLine)).toBe(false);
    // and the check price_list_lines_vat_mode still holds beneath the trigger: a discount never carries a mode
    const checkErr = await pgError(
      asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q(
          "insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, discount_bp, price_includes_vat) values ($1, $2, $3, 6, 100, true)",
          [org, net, product2],
        );
      }),
    );
    expect(checkErr.code).toBe("23514");
  });

  it("a price changed from a discount to a fixed one, or back, follows the list", async () => {
    const gross = await newList(owner.id, "מעבר", org, { prices_include_vat: true });
    const id = await insertLine(owner.id, gross, { discount_bp: 100 });
    expect(await lineVat(id)).toBe(false);
    await asUser(owner.id, (q) => q("update public.price_list_lines set discount_bp = null, price_agorot = 500 where id = $1", [id]));
    expect(await lineVat(id)).toBe(true);
    await asUser(owner.id, (q) => q("update public.price_list_lines set price_agorot = null, discount_bp = 200 where id = $1", [id]));
    expect(await lineVat(id)).toBe(false);
  });

  it("the setting changes only while the list has no prices, for every writer", async () => {
    const list = await newList(owner.id, "נעילה");
    expect(await setVat(owner.id, list, true)).toBe(1);
    expect(await setVat(owner.id, list, false)).toBe(1);
    const lineId = await insertLine(owner.id, list, { discount_bp: 100 });
    const err = await pgError(setVat(owner.id, list, true));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("price_lists:vat_locked");
    const serverErr = await pgError(asAdmin((q) => q("update public.price_lists set prices_include_vat = true where id = $1", [list])));
    expect(serverErr.hint).toBe("price_lists:vat_locked");
    // the same value, or other fields, still save
    expect(await setVat(owner.id, list, false)).toBe(1);
    expect(await asUser(owner.id, async (q) => (await q("update public.price_lists set name = 'נעילה 2', is_active = false where id = $1", [list])).rowCount)).toBe(1);
    // once the prices are gone the setting is free again
    await asUser(owner.id, (q) => q("delete from public.price_list_lines where id = $1", [lineId]));
    expect(await setVat(owner.id, list, true)).toBe(1);
    expect(await listVat(list)).toBe(true);
  });

  it("only owners and admins change it; an outsider learns nothing", async () => {
    const list = await newList(owner.id, "הרשאות");
    await insertLine(owner.id, list, { price_agorot: 100 });
    // a member and another business's owner: 0 rows, no hint about the lock
    expect(await setVat(member.id, list, true)).toBe(0);
    expect(await setVat(owner2.id, list, true)).toBe(0);
    // a line insert into another business's list by its own outsider: plain 42501
    const outside = await pgError(insertLine(owner2.id, list, { product_id: product2, price_agorot: 1 }));
    expect(outside.code).toBe("42501");
    expect(outside.hint ?? null).toBeNull();
    expect(await listVat(list)).toBe(false);
  });

  it("the migration fills existing lists from their first fixed price, else the business's setting, and runs twice", async () => {
    const fromLine = await newList(owner.id, "מילוי משורה");
    const fromBusiness = await newList(owner.id, "מילוי מהעסק", grossOrg, { prices_include_vat: false });
    const mixed = await newList(owner.id, "מעורב");
    await insertLine(owner.id, fromLine, { discount_bp: 100 });
    await insertLine(owner.id, fromLine, { product_id: product2, price_agorot: 100 });
    const mixedA = await insertLine(owner.id, mixed, { price_agorot: 100 });
    const mixedB = await insertLine(owner.id, mixed, { product_id: product2, price_agorot: 200 });
    // committed: the migration ends in its own final state (and leaves these test rows as it found them, re-filled)
    const seen = await asAdmin(async (q) => {
      // the state before this migration: lines typed with their own modes, lists without a setting
      await q("set local session_replication_role = replica");
      // fromLine: a discount first (skipped), then a fixed price typed including VAT; mixed: one each way
      await q("update public.price_list_lines set price_includes_vat = true where id = $1", [mixedA]);
      await q("update public.price_list_lines set price_includes_vat = true where price_list_id = $1 and price_agorot is not null", [fromLine]);
      await q("alter table public.price_lists alter column prices_include_vat drop not null");
      await q("update public.price_lists set prices_include_vat = null where id = any($1)", [[fromLine, fromBusiness, mixed]]);
      await q("set local session_replication_role = origin");
      for (const sql of RERUN.sql) await q(sql);
      for (const sql of RERUN.sql) await q(sql);
      const lists = (await q<{ id: string; v: boolean }>("select id, prices_include_vat as v from public.price_lists where id = any($1)", [[fromLine, fromBusiness, mixed]])).rows;
      const lines = (await q<{ id: string; v: boolean }>("select id, price_includes_vat as v from public.price_list_lines where id = any($1)", [[mixedA, mixedB]])).rows;
      const notNull = (await q<{ n: boolean }>("select attnotnull as n from pg_attribute where attrelid = 'public.price_lists'::regclass and attname = 'prices_include_vat'")).rows[0].n;
      return { lists: Object.fromEntries(lists.map((r) => [r.id, r.v])), lines: Object.fromEntries(lines.map((r) => [r.id, r.v])), notNull };
    });
    expect(seen.lists[fromLine]).toBe(true);
    expect(seen.lists[fromBusiness]).toBe(true);
    // the first fixed price (by creation) decides; a mixed list keeps its lines unchanged
    expect(seen.lists[mixed]).toBe(true);
    expect(seen.lines).toEqual({ [mixedA]: true, [mixedB]: false });
    expect(seen.notNull).toBe(true);
  });

  it("grants: clients may set the list's mode, not a line's", async () => {
    const grants = await asAdmin(async (q) =>
      (await q<{ t: string; p: string }>(
        `select table_name as t, privilege_type as p from information_schema.column_privileges
          where grantee = 'authenticated' and table_schema = 'public'
            and ((table_name = 'price_lists' and column_name = 'prices_include_vat')
              or (table_name = 'price_list_lines' and column_name = 'price_includes_vat'))
          order by 1, 2`,
      )).rows,
    );
    expect(grants).toEqual([
      { t: "price_list_lines", p: "SELECT" },
      { t: "price_lists", p: "INSERT" },
      { t: "price_lists", p: "SELECT" },
      { t: "price_lists", p: "UPDATE" },
    ]);
  });
});
