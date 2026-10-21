import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * LST-09 for the money lists (owner, 21 October 2026): list_preferences and saved_views take the object types 'document' and
 * 'payment' with the same rules as every other list; the list export logs 'accounting_documents' / 'payments', keeps their
 * choice codes (nothing typed), and is refused without the plan's key; the computed sort fields sort_customer(...) and
 * sort_recorder(...) read with the caller's rights.
 */
describe("the documents and payments lists: columns, saved views, export and sort fields (LST-09)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let contactDoc: string, dealDoc: string, contactPay: string, dealPay: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const lastExport = () =>
    asAdmin(
      async (q) =>
        (
          await q<{ entity_type: string; filters: { sort?: string; f?: { groups: Array<{ conditions: Array<{ value: unknown }> }> } } }>(
            "select entity_type, changes -> 'filters' as filters from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1",
            [org],
          )
        ).rows[0],
    );

  beforeAll(async () => {
    owner = await createUser("lst09m-owner");
    org = await createOrg(owner.id, "עסק הכספים");
    member = await addMember(org, owner.id, "member", "lst09m-member");
    outsider = await createUser("lst09m-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setFeatures({ documents: true, payments: true });
    const pipe = await defaultPipeline(org);
    const stage = pipe.stages.find((s) => s.kind === "open")!.id;
    // the member owns the records; the owner records the documents and payments on them
    const [contact, deal] = await asUser(member.id, async (q) => [
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, 'רות', 'לוי', $2) returning id", [org, member.id])).id,
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'שיפוץ מטבח', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          stage,
          member.id,
        ])
      ).id,
    ]);
    [contactDoc, dealDoc, contactPay, dealPay] = await asUser(owner.id, async (q) => [
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', '501', 1000) returning id", [org, contact])).id,
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, deal_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', '1001', 117000) returning id", [org, deal])).id,
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 1000, 'cash') returning id", [org, contact])).id,
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, deal_id, amount_agorot, method) values ($1, $2, 117000, 'transfer') returning id", [org, deal])).id,
    ]);
  });

  it("columns of the two lists are personal, like every list's", async () => {
    for (const object of ["document", "payment"]) {
      await asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, $2, $3)", [org, object, JSON.stringify([{ key: "amount", width: "wide" }])]));
      await asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, $2, '[]')", [org, object]));
      expect((await pgError(asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, $2)", [org, object])))).code).toBe("23505");
      await asUser(owner.id, async (q) => {
        expect(await count(q, "select 1 from public.list_preferences where object_type = $1", [object])).toBe(1);
        expect((await q("update public.list_preferences set columns = '[]' where user_id = $1 and object_type = $2", [member.id, object])).rowCount).toBe(0);
      });
      expect((await pgError(asUser(outsider.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, $2)", [org, object])))).code).toBe("42501");
    }
    for (const wrong of ["documents", "payments", "accounting_document"]) {
      expect((await pgError(asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, $2)", [org, wrong])))).code).toBe("23514");
    }
  });

  it("saved views of the two lists follow the view rules", async () => {
    const insert = (u: U, orgId: string, object: string, scope: string) =>
      asUser(u.id, (q) =>
        q("insert into public.saved_views (organization_id, object_type, name, scope, owner_id, config) values ($1, $2, 'החודש', $3, $4, $5)", [
          orgId,
          object,
          scope,
          u.id,
          JSON.stringify({ filters: { from: "2026-10-01" }, sort: "-amount", columns: null }),
        ]),
      );
    for (const object of ["document", "payment"]) {
      await insert(member, org, object, "private");
      expect((await pgError(insert(member, org, object, "org"))).code).toBe("42501");
      await insert(owner, org, object, "org");
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.saved_views where object_type = $1", [object]))).toBe(2);
      expect(await asUser(owner.id, (q) => count(q, "select 1 from public.saved_views where object_type = $1", [object]))).toBe(1);
      expect((await pgError(insert(outsider, org, object, "private"))).code).toBe("42501");
      await insert(outsider, otherOrg, object, "private");
    }
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.saved_views where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(insert(owner, org, "documents", "private"))).code).toBe("23514");
  });

  it("the export logs the table, keeps the choice codes and nothing typed", async () => {
    const docFilter = {
      match: "any",
      groups: [
        {
          match: "any",
          conditions: [
            ...["tax_invoice", "tax_invoice_receipt", "receipt", "credit_invoice", "proforma"].map((value) => ({ field: "type", op: "is", value })),
            ...["active", "cancelled"].map((value) => ({ field: "status", op: "is", value })),
            { field: "number", op: "contains", value: "סוד" },
          ],
        },
      ],
    };
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'document', 'xlsx', 2, 'filtered', $2)", [org, JSON.stringify({ f: JSON.stringify(docFilter), sort: "-amount" })]));
    const docs = await lastExport();
    expect(docs.entity_type).toBe("accounting_documents");
    expect(docs.filters.sort).toBe("-amount");
    expect(docs.filters.f!.groups[0].conditions.map((c) => c.value)).toEqual(["tax_invoice", "tax_invoice_receipt", "receipt", "credit_invoice", "proforma", "active", "cancelled", true]);
    expect(JSON.stringify(docs)).not.toContain("סוד");

    const payFilter = {
      match: "any",
      groups: [
        // app.export_filters keeps 10 conditions per group
        { match: "any", conditions: ["credit", "transfer", "cash", "cheque", "bit_paybox", "standing_order", "other"].map((value) => ({ field: "method", op: "is", value })) },
        {
          match: "any",
          conditions: [
            ...["recorded", "confirmed", "failed", "refunded", "cancelled"].map((value) => ({ field: "status", op: "is", value })),
            { field: "reference", op: "contains", value: "4580-1234" },
          ],
        },
      ],
    };
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'payment', 'csv', 2, 'filtered', $2)", [org, JSON.stringify({ f: JSON.stringify(payFilter) })]));
    const pays = await lastExport();
    expect(pays.entity_type).toBe("payments");
    expect(pays.filters.f!.groups.map((g) => g.conditions.map((c) => c.value))).toEqual([
      ["credit", "transfer", "cash", "cheque", "bit_paybox", "standing_order", "other"],
      ["recorded", "confirmed", "failed", "refunded", "cancelled", true],
    ]);
    expect(JSON.stringify(pays)).not.toContain("4580");

    // a member may not export (owners, admins and team managers, or the PRM-01 grant)
    for (const object of ["document", "payment"]) {
      expect((await pgError(asUser(member.id, (q) => q("select public.log_list_export($1, $2, 'csv', 1, 'filtered', '{}')", [org, object])))).code).toBe("42501");
      expect((await pgError(asUser(outsider.id, (q) => q("select public.log_list_export($1, $2, 'csv', 1, 'filtered', '{}')", [org, object])))).code).toBe("42501");
    }
  });

  it("without the plan's key a money list is not exported, and nothing is logged", async () => {
    const exports = () => asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'export'", [org]));
    const before = await exports();
    await setFeatures({ documents: false, payments: true });
    try {
      const refused = await pgError(asUser(owner.id, (q) => q("select public.log_list_export($1, 'document', 'csv', 1, 'filtered', '{}')", [org])));
      expect([refused.code, refused.hint]).toEqual(["P0001", "feature:documents"]);
      // the other list is unaffected
      await asUser(owner.id, (q) => q("select public.log_list_export($1, 'payment', 'csv', 1, 'filtered', '{}')", [org]));
      await setFeatures({ documents: true, payments: false });
      const refusedPay = await pgError(asUser(owner.id, (q) => q("select public.log_list_export($1, 'payment', 'csv', 1, 'filtered', '{}')", [org])));
      expect([refusedPay.code, refusedPay.hint]).toEqual(["P0001", "feature:payments"]);
      // other lists never needed either key
      await asUser(owner.id, (q) => q("select public.log_list_export($1, 'contact', 'csv', 1, 'filtered', '{}')", [org]));
    } finally {
      await setFeatures({ documents: true, payments: true });
    }
    expect(await exports()).toBe(before + 2);
  });

  it("sorts by the customer and the recorder as the lists show them, with the caller's rights", async () => {
    const read = (u: U, table: string) =>
      asUser(u.id, async (q) =>
        new Map(
          (
            await q<{ id: string; customer: string | null; recorder: string | null }>(
              `select t.id, public.sort_customer(t) as customer, public.sort_recorder(t) as recorder from public.${table} t where t.organization_id = $1`,
              [org],
            )
          ).rows.map((row) => [row.id, row]),
        ),
      );
    for (const [table, onContact, onDeal] of [
      ["accounting_documents", contactDoc, dealDoc],
      ["payments", contactPay, dealPay],
    ] as const) {
      const rows = await read(member, table);
      expect(rows.get(onContact)?.customer, table).toBe("רות לוי");
      expect(rows.get(onDeal)?.customer, table).toBe("שיפוץ מטבח");
      expect(rows.get(onDeal)?.recorder, table).not.toBeNull();
      // nobody else reads them
      expect(await asUser(outsider.id, (q) => count(q, `select public.sort_customer(t) from public.${table} t where t.organization_id = $1`, [org]))).toBe(0);
    }
    // the API's anonymous role may not call them
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; arg: string; anon: boolean; auth: boolean; definer: boolean }>(
            `select p.proname as name, p.proargtypes[0]::regtype::text as arg, has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as auth, p.prosecdef as definer
               from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sort_customer', 'sort_recorder')
                and p.proargtypes[0] in ('public.accounting_documents'::regtype, 'public.payments'::regtype)`,
          )
        ).rows,
    );
    expect(grants.map((g) => [g.name, g.arg, g.anon, g.auth, g.definer]).sort()).toEqual([
      ["sort_customer", "accounting_documents", false, true, false],
      ["sort_customer", "payments", false, true, false],
      ["sort_recorder", "accounting_documents", false, true, false],
      ["sort_recorder", "payments", false, true, false],
    ]);
  });
});
