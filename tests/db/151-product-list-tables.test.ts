import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * LST-09 for the product catalog: list_preferences and saved_views take the object type 'product' with the
 * same rules as every other list (columns are personal; views private, team or org), and the list export
 * keeps the catalog's plain filter codes (kind, VAT kind, billing) in its audit entry.
 */
describe("the product catalog's columns and saved views (LST-09)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("lst09p-owner");
    org = await createOrg(owner.id, "עסק הקטלוג");
    member = await addMember(org, owner.id, "member", "lst09p-member");
    outsider = await createUser("lst09p-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("columns of the catalog are personal, like every list's", async () => {
    const columns = JSON.stringify([{ key: "price", width: "wide" }]);
    await asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'product', $2)", [org, columns]));
    await asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'product', '[]')", [org]));
    // one row per user and list
    expect((await pgError(asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'product')", [org])))).code).toBe("23505");
    // the owner sees and changes only their own row
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.list_preferences where object_type = 'product'")).toBe(1);
      expect((await q("update public.list_preferences set columns = '[]' where user_id = $1", [member.id])).rowCount).toBe(0);
    });
    // nobody writes into another business
    expect((await pgError(asUser(outsider.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'product')", [org])))).code).toBe("42501");
    // an unknown list is still refused
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'products')", [org])))).code).toBe("23514");
  });

  it("saved views of the catalog follow the view rules: a member saves for themself, only an admin for everyone", async () => {
    const insert = (u: U, orgId: string, scope: string) =>
      asUser(u.id, (q) =>
        q("insert into public.saved_views (organization_id, object_type, name, scope, owner_id, config) values ($1, 'product', 'פעילים', $2, $3, $4)", [
          orgId,
          scope,
          u.id,
          JSON.stringify({ filters: { status: "active" }, sort: "name", columns: null }),
        ]),
      );
    await insert(member, org, "private");
    expect((await pgError(insert(member, org, "org"))).code).toBe("42501");
    await insert(owner, org, "org");
    // the member sees their own view and the shared one; the owner does not see the member's private one
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.saved_views where object_type = 'product'"))).toBe(2);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.saved_views where object_type = 'product'"))).toBe(1);
    // and nothing crosses into another business
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.saved_views where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(insert(outsider, org, "private"))).code).toBe("42501");
    await insert(outsider, otherOrg, "private");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.saved_views (organization_id, object_type, name, owner_id) values ($1, 'note', 'x', $2)", [org, owner.id])))).code).toBe(
      "23514",
    );
  });

  it("the export keeps the catalog's plain codes, and nothing typed", async () => {
    const f = {
      match: "all",
      groups: [
        {
          match: "all",
          conditions: [
            { field: "kind", op: "is", value: "service" },
            { field: "vat", op: "is", value: "zero_rate" },
            { field: "billing", op: "is", value: "monthly" },
            { field: "name", op: "contains", value: "סוד" },
          ],
        },
      ],
    };
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'product', 'csv', 3, 'filtered', $2)", [org, JSON.stringify({ q: "חיפוש", f: JSON.stringify(f) })]));
    const entry = await asAdmin(
      async (q) =>
        (
          await q<{ entity_type: string; filters: { q: boolean; f: { groups: Array<{ conditions: Array<{ value: unknown }> }> } } }>(
            "select entity_type, changes -> 'filters' as filters from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1",
            [org],
          )
        ).rows[0],
    );
    expect(entry.entity_type).toBe("products");
    expect(entry.filters.q).toBe(true);
    expect(entry.filters.f.groups[0].conditions.map((c) => c.value)).toEqual(["service", "zero_rate", "monthly", true]);
    expect(JSON.stringify(entry)).not.toContain("סוד");
  });
});
