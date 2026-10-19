import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * LST-09 for the quotes list: list_preferences and saved_views take the object type 'quote' with the same rules as every
 * other list, the list export logs 'quotes' and keeps the quote status codes of its advanced filter (nothing typed), and
 * the computed sort fields sort_owner(quotes) / sort_customer(quotes) read with the caller's rights.
 */
describe("the quotes list's columns, saved views, export and sort fields (LST-09)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let dealQuote: string, contactQuote: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  beforeAll(async () => {
    owner = await createUser("lst09q-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    member = await addMember(org, owner.id, "member", "lst09q-member");
    outsider = await createUser("lst09q-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true })]));
    const pipe = await defaultPipeline(org);
    const stage = pipe.stages.find((s) => s.kind === "open")!.id;
    [dealQuote, contactQuote] = await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, 'רות', 'לוי', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'שיפוץ מטבח', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          stage,
          member.id,
        ])
      ).id;
      const a = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה לעסקה', $2) returning id", [org, deal])).id;
      const b = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה לאיש קשר', $2) returning id", [org, contact])).id;
      return [a, b];
    });
  });

  it("columns of the quotes list are personal, like every list's", async () => {
    await asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'quote', $2)", [org, JSON.stringify([{ key: "total", width: "wide" }])]));
    await asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'quote', '[]')", [org]));
    expect((await pgError(asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'quote')", [org])))).code).toBe("23505");
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.list_preferences where object_type = 'quote'")).toBe(1);
      expect((await q("update public.list_preferences set columns = '[]' where user_id = $1", [member.id])).rowCount).toBe(0);
    });
    expect((await pgError(asUser(outsider.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'quote')", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'quotes')", [org])))).code).toBe("23514");
  });

  it("saved views of the quotes list follow the view rules", async () => {
    const insert = (u: U, orgId: string, scope: string) =>
      asUser(u.id, (q) =>
        q("insert into public.saved_views (organization_id, object_type, name, scope, owner_id, config) values ($1, 'quote', 'נשלחו', $2, $3, $4)", [
          orgId,
          scope,
          u.id,
          JSON.stringify({ filters: { status: "sent" }, sort: "-total", columns: null }),
        ]),
      );
    await insert(member, org, "private");
    expect((await pgError(insert(member, org, "org"))).code).toBe("42501");
    await insert(owner, org, "org");
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.saved_views where object_type = 'quote'"))).toBe(2);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.saved_views where object_type = 'quote'"))).toBe(1);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.saved_views where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(insert(outsider, org, "private"))).code).toBe("42501");
    await insert(outsider, otherOrg, "private");
  });

  it("the export logs 'quotes' and keeps the status codes, and nothing typed", async () => {
    const f = {
      match: "any",
      groups: [
        {
          match: "any",
          conditions: [
            { field: "status", op: "is", value: "sent" },
            { field: "status", op: "is", value: "viewed" },
            { field: "status", op: "is", value: "accepted" },
            { field: "status", op: "is", value: "rejected" },
            { field: "status", op: "is", value: "expired" },
            { field: "status", op: "is", value: "draft" },
            { field: "status", op: "is", value: "cancelled" },
            { field: "title", op: "contains", value: "סוד" },
          ],
        },
      ],
    };
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'quote', 'xlsx', 2, 'filtered', $2)", [org, JSON.stringify({ f: JSON.stringify(f), sort: "-total" })]));
    const entry = await asAdmin(
      async (q) =>
        (
          await q<{ entity_type: string; filters: { sort: string; f: { groups: Array<{ conditions: Array<{ value: unknown }> }> } } }>(
            "select entity_type, changes -> 'filters' as filters from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1",
            [org],
          )
        ).rows[0],
    );
    expect(entry.entity_type).toBe("quotes");
    expect(entry.filters.sort).toBe("-total");
    expect(entry.filters.f.groups[0].conditions.map((c) => c.value)).toEqual(["sent", "viewed", "accepted", "rejected", "expired", "draft", "cancelled", true]);
    expect(JSON.stringify(entry)).not.toContain("סוד");
    // a member may not export (owners, admins and team managers, or the PRM-01 grant)
    expect((await pgError(asUser(member.id, (q) => q("select public.log_list_export($1, 'quote', 'csv', 1, 'filtered', '{}')", [org])))).code).toBe("42501");
  });

  it("sorts by the customer and the owner as the list shows them, with the caller's rights", async () => {
    const rows = await asUser(member.id, async (q) =>
      (
        await q<{ id: string; customer: string | null; owner: string | null }>(
          "select q.id, public.sort_customer(q) as customer, public.sort_owner(q) as owner from public.quotes q where q.organization_id = $1",
          [org],
        )
      ).rows,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(dealQuote)?.customer).toBe("שיפוץ מטבח");
    expect(byId.get(contactQuote)?.customer).toBe("רות לוי");
    expect(byId.get(dealQuote)?.owner).not.toBeNull();
    // the name kept on a sent quote comes first
    await asAdmin((q) => q("update public.quotes set customer_name = 'לקוח שמור' where id = $1", [contactQuote]));
    expect(await asUser(member.id, async (q) => (await one<{ c: string }>(q, "select public.sort_customer(q) as c from public.quotes q where q.id = $1", [contactQuote])).c)).toBe("לקוח שמור");
    // nobody else reads them
    expect(await asUser(outsider.id, (q) => count(q, "select public.sort_customer(q) from public.quotes q where q.organization_id = $1", [org]))).toBe(0);
    // the API's anonymous role may not call them
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; anon: boolean; auth: boolean }>(
            `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sort_customer', 'sort_owner')
                and p.proargtypes[0] = 'public.quotes'::regtype`,
          )
        ).rows,
    );
    expect(grants.map((g) => [g.name, g.anon, g.auth]).sort()).toEqual([
      ["sort_customer", false, true],
      ["sort_owner", false, true],
    ]);
  });
});
