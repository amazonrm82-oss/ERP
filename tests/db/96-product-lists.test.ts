import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PRODUCT_CATEGORIES, DEFAULT_PRODUCT_UNITS } from "@/features/products/lists";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

/** The last statement of the migration: the seed of the organizations that already exist. */
function backfillStatement(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_product_lists.sql"));
  if (!file) throw new Error("no migration *_product_lists.sql");
  const sql = readFileSync(path.join(dir, file), "utf8");
  return sql.slice(sql.lastIndexOf("\nselect app.seed_product_lists") + 1);
}

// PRD-04: product categories (two levels) and units of measure are managed lists.
describe("product categories and units (PRD-04)", () => {
  // owner2 owns the extra organizations (a user owns at most 5)
  let owner: U, owner2: U, admin: U, manager: U, member: U, viewer: U;
  let org: string;

  const unitsOf = (o: string) =>
    asAdmin(async (q) => (await q<{ name: string; position: number }>("select name, position from public.product_units where organization_id = $1 order by position, name", [o])).rows);
  const categoriesOf = (o: string) =>
    asAdmin(
      async (q) =>
        (await q<{ id: string; name: string; parent_id: string | null }>("select id, name, parent_id from public.product_categories where organization_id = $1 order by position, name", [o]))
          .rows,
    );
  const addCategory = (userId: string, name: string, parent: string | null = null, o = org) =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("insert into public.product_categories (organization_id, name, parent_id) values ($1, $2, $3) returning id", [o, name, parent])).rows[0].id,
    );

  beforeAll(async () => {
    owner = await createUser("plist-owner");
    owner2 = await createUser("plist-owner2");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "plist-admin");
    manager = await addMember(org, owner.id, "manager", "plist-manager");
    member = await addMember(org, owner.id, "member", "plist-member");
    viewer = await addMember(org, owner.id, "viewer", "plist-viewer");
  });

  it("a new organization starts with the default units and categories, in order", async () => {
    const units = await unitsOf(org);
    expect(units.map((u) => u.name)).toEqual([...DEFAULT_PRODUCT_UNITS]);
    expect(units.map((u) => u.position)).toEqual(DEFAULT_PRODUCT_UNITS.map((_, i) => i));
    expect((await categoriesOf(org)).map((c) => c.name)).toEqual([...DEFAULT_PRODUCT_CATEGORIES]);
  });

  it("the backfill seeds only empty lists, and is safe to run twice", async () => {
    const emptied = await createOrg(owner2.id, "עסק שמחק הכול");
    const custom = await createOrg(owner2.id, "עסק עם יחידה משלו");
    await asUser(owner2.id, async (q) => {
      for (const o of [emptied, custom]) {
        await q("delete from public.product_units where organization_id = $1", [o]);
        await q("delete from public.product_categories where organization_id = $1", [o]);
      }
      await q("insert into public.product_units (organization_id, name) values ($1, 'משטח')", [custom]);
      await q("insert into public.product_categories (organization_id, name) values ($1, 'שלנו')", [custom]);
    });
    const statement = backfillStatement();
    await asAdmin((q) => q(statement));
    await asAdmin((q) => q(statement));
    expect((await unitsOf(emptied)).map((u) => u.name)).toEqual([...DEFAULT_PRODUCT_UNITS]);
    expect((await categoriesOf(emptied)).map((c) => c.name)).toEqual([...DEFAULT_PRODUCT_CATEGORIES]);
    expect((await unitsOf(custom)).map((u) => u.name)).toEqual(["משטח"]);
    expect((await categoriesOf(custom)).map((c) => c.name)).toEqual(["שלנו"]);
    expect((await unitsOf(org)).length).toBe(DEFAULT_PRODUCT_UNITS.length);
  });

  it("every member reads both lists; only owners and admins of a writable organization change them", async () => {
    for (const u of [manager, member, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.product_units where organization_id = $1", [org])).toBe(DEFAULT_PRODUCT_UNITS.length);
        expect(await count(q, "select 1 from public.product_categories where organization_id = $1", [org])).toBeGreaterThan(0);
        for (const table of ["product_units", "product_categories"]) {
          expect((await q(`update public.${table} set name = name where organization_id = $1`, [org])).rowCount, table).toBe(0);
          expect((await q(`delete from public.${table} where organization_id = $1`, [org])).rowCount, table).toBe(0);
        }
      });
      for (const table of ["product_units", "product_categories"]) {
        expect((await pgError(asUser(u.id, (q) => q(`insert into public.${table} (organization_id, name) values ($1, 'x')`, [org])))).code, table).toBe("42501");
      }
    }
    await asUser(admin.id, async (q) => {
      const unit = (await q<{ id: string }>("insert into public.product_units (organization_id, name, position) values ($1, 'קרטון', 9) returning id", [org])).rows[0].id;
      expect((await q("update public.product_units set name = 'ארגז' where id = $1", [unit])).rowCount).toBe(1);
      expect((await q("delete from public.product_units where id = $1", [unit])).rowCount).toBe(1);
    });
    // the audit log keeps the changes
    const actions = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where organization_id = $1 and entity_type = 'product_units' and actor_id = $2 order by created_at", [org, admin.id])).rows.map(
        (r) => r.action,
      ),
    );
    // one transaction, so one timestamp: compare as a set
    expect(actions.sort()).toEqual(["delete", "insert", "update"]);

    // read-only: nobody writes, everybody still reads
    const frozen = await createOrg(owner2.id, "עסק בקריאה בלבד");
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [frozen]));
    await asUser(owner2.id, async (q) => {
      expect(await count(q, "select 1 from public.product_units where organization_id = $1", [frozen])).toBe(DEFAULT_PRODUCT_UNITS.length);
      expect((await q("update public.product_units set name = name where organization_id = $1", [frozen])).rowCount).toBe(0);
    });
    expect((await pgError(asUser(owner2.id, (q) => q("insert into public.product_units (organization_id, name) values ($1, 'x')", [frozen])))).code).toBe("42501");
  });

  it("organization_id is fixed once inserted", async () => {
    const other = await createOrg(owner.id, "עסק אחר של הבעלים");
    for (const table of ["product_units", "product_categories"]) {
      const error = await pgError(asUser(owner.id, (q) => q(`update public.${table} set organization_id = $2 where organization_id = $1`, [org, other])));
      expect(error.code, table).toBe("42501");
    }
  });

  it("categories have at most two levels", async () => {
    const top = await addCategory(owner.id, "שירותים");
    const sub = await addCategory(owner.id, "ייעוץ", top);
    // under a subcategory: refused
    const deeper = await pgError(addCategory(owner.id, "ייעוץ עסקי", sub));
    expect(deeper.code).toBe("P0001");
    expect(deeper.hint).toBe("product_categories:depth");
    // a category with subcategories cannot go under another
    const other = await addCategory(owner.id, "מוצרים");
    const moveTop = await pgError(asUser(owner.id, (q) => q("update public.product_categories set parent_id = $2 where id = $1", [top, other])));
    expect(moveTop.hint).toBe("product_categories:depth");
    // nor under itself
    const self = await pgError(asUser(owner.id, (q) => q("update public.product_categories set parent_id = id where id = $1", [other])));
    expect(["P0001", "23514"]).toContain(self.code);
    // a leaf moves freely between top categories and back to the top
    await asUser(owner.id, async (q) => {
      expect((await q("update public.product_categories set parent_id = $2 where id = $1", [sub, other])).rowCount).toBe(1);
      expect((await q("update public.product_categories set parent_id = null where id = $1", [sub])).rowCount).toBe(1);
      expect((await q("update public.product_categories set parent_id = $2 where id = $1", [sub, top])).rowCount).toBe(1);
    });
    // a parent from another organization does not exist for this one
    const foreignOrg = await createOrg(owner2.id, "עסק זר");
    const foreignTop = await addCategory(owner2.id, "זר", null, foreignOrg);
    expect((await pgError(addCategory(owner.id, "פולש", foreignTop))).code).toBe("23503");
  });

  it("names are unique among siblings, ignoring case; removing a top category lifts its subcategories", async () => {
    const top = await addCategory(owner.id, "Hardware");
    expect((await pgError(addCategory(owner.id, "hardware"))).code).toBe("23505");
    const a = await addCategory(owner.id, "Cables", top);
    expect((await pgError(addCategory(owner.id, "cables", top))).code).toBe("23505");
    // the same name under another parent, or on top, is fine
    await addCategory(owner.id, "Cables");
    for (const name of ["", " רווח", "x".repeat(81)]) {
      expect((await pgError(addCategory(owner.id, name))).code, name).toBe("23514");
    }
    // lifting "Cables" to the top would clash with the top "Cables": refused, nothing changes
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.product_categories where id = $1", [top])))).code).toBe("23505");
    await asUser(owner.id, async (q) => {
      await q("update public.product_categories set name = 'Cables HW' where id = $1", [a]);
      expect((await q("delete from public.product_categories where id = $1", [top])).rowCount).toBe(1);
    });
    const lifted = (await categoriesOf(org)).find((c) => c.id === a);
    expect(lifted?.parent_id).toBeNull();
  });

  it("units are unique ignoring case and checked; at most 50 units and 200 categories", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.product_units (organization_id, name) values ($1, 'שעה')", [org])))).code).toBe("23505");
    for (const name of ["", " ק\"ג", "x".repeat(31)]) {
      expect((await pgError(asUser(owner.id, (q) => q("insert into public.product_units (organization_id, name) values ($1, $2)", [org, name])))).code, name).toBe("23514");
    }
    const full = await createOrg(owner2.id, "עסק עם הרבה רשימות");
    await asUser(owner2.id, async (q) => {
      await q("insert into public.product_units (organization_id, name) select $1, 'יחידה ' || g from generate_series(1, $2::int) g", [full, 50 - DEFAULT_PRODUCT_UNITS.length]);
      await q("insert into public.product_categories (organization_id, name) select $1, 'קטגוריה ' || g from generate_series(1, $2::int) g", [full, 200 - DEFAULT_PRODUCT_CATEGORIES.length]);
    });
    const unitError = await pgError(asUser(owner2.id, (q) => q("insert into public.product_units (organization_id, name) values ($1, 'עוד')", [full])));
    expect(unitError.hint).toBe("product_units:max");
    const categoryError = await pgError(addCategory(owner2.id, "עוד", null, full));
    expect(categoryError.hint).toBe("product_categories:max");
  });
});
