import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

const newJob = (userId: string, org: string, entity = "product") =>
  asUser(userId, async (q) =>
    (
      await q<{ id: string }>(
        "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, $2, 'products.xlsx', 'skip', 10) returning id",
        [org, entity],
      )
    ).rows[0].id,
  );

const insertProduct = (userId: string, org: string, values: Record<string, unknown>) =>
  asUser(userId, async (q) => {
    const keys = Object.keys(values);
    const sql = `insert into public.products (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
    return (await q<{ id: string }>(sql, [org, ...keys.map((k) => values[k])])).rows[0].id;
  });

// PRD-05: products imported from a file remember their import; only a running product import of the same user may tag them.
describe("product import (PRD-05)", () => {
  let owner: U, admin: U, manager: U, member: U, owner2: U;
  let org: string, other: string;

  beforeAll(async () => {
    owner = await createUser("pimp-owner");
    owner2 = await createUser("pimp-owner2");
    org = await createOrg(owner.id);
    other = await createOrg(owner2.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin", "pimp-admin");
    manager = await addMember(org, owner.id, "manager", "pimp-manager");
    member = await addMember(org, owner.id, "member", "pimp-member");
  });

  it("a product import job can be opened; an unknown object cannot", async () => {
    expect(await newJob(owner.id, org)).toBeTruthy();
    expect((await pgError(newJob(owner.id, org, "invoice"))).code).toBe("23514");
  });

  it("a product may carry only a running product import of the same user, set once", async () => {
    const job = await newJob(owner.id, org);
    const id = await insertProduct(owner.id, org, { name: "מיובא", import_job_id: job });
    expect(await asAdmin(async (q) => (await q<{ j: string }>("select import_job_id as j from public.products where id = $1", [id])).rows[0].j)).toBe(job);

    // another user's job, a job of another object, a finished job
    const adminJob = await newJob(admin.id, org);
    expect((await pgError(insertProduct(owner.id, org, { name: "x", import_job_id: adminJob }))).code).toBe("42501");
    const leadJob = await newJob(owner.id, org, "lead");
    expect((await pgError(insertProduct(owner.id, org, { name: "x", import_job_id: leadJob }))).code).toBe("42501");
    const finished = await newJob(owner.id, org);
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [finished]));
    expect((await pgError(insertProduct(owner.id, org, { name: "x", import_job_id: finished }))).code).toBe("42501");
    // a job of another organization (the composite key)
    const otherJob = await newJob(owner2.id, other);
    expect((await pgError(insertProduct(owner.id, org, { name: "x", import_job_id: otherJob }))).code).toMatch(/^(42501|23503)$/);

    // the tag never changes: no update grant, and the guard refuses the server too
    expect((await pgError(asUser(owner.id, (q) => q("update public.products set import_job_id = null where id = $1", [id])))).code).toBe("42501");
  });

  it("only owners and admins write imported products (a manager may open a job, not write the catalog)", async () => {
    const job = await newJob(manager.id, org);
    expect((await pgError(insertProduct(manager.id, org, { name: "x", import_job_id: job }))).code).toBe("42501");
    const adminJob = await newJob(admin.id, org);
    expect(await insertProduct(admin.id, org, { name: "של מנהל מערכת", import_job_id: adminJob })).toBeTruthy();
  });

  it("finds taken SKUs without case, only in the caller's organization", async () => {
    await insertProduct(owner.id, org, { name: "עם מקט", sku: "AbC-1" });
    await insertProduct(owner2.id, other, { name: "של אחר", sku: "ZZZ" });
    const matches = (userId: string, o: string, skus: string[]) =>
      asUser(userId, async (q) => (await q<{ sku: string }>("select sku from public.product_sku_matches($1, $2)", [o, skus])).rows.map((r) => r.sku));
    expect(await matches(owner.id, org, ["abc-1", " ABC-1 ", "zzz", "none"])).toEqual(["AbC-1"]);
    expect(await matches(member.id, org, ["ABC-1"])).toEqual(["AbC-1"]);
    // RLS decides: nothing from another organization
    expect(await matches(owner.id, other, ["ZZZ"])).toEqual([]);
    expect((await pgError(asAnon((q) => q("select * from public.product_sku_matches($1, $2)", [org, ["ABC-1"]]))))).toMatchObject({ code: "42501" });
    // and the unique index has the last word
    expect((await pgError(insertProduct(owner.id, org, { name: "כפול", sku: "abc-1" }))).code).toBe("23505");
  });

  it("the plan quota stops an import row by row", async () => {
    const used = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.products where organization_id = $1", [org])).rows[0].n));
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = $2 where organization_id = $1", [org, JSON.stringify({ max_products: used + 1 })]));
    const job = await newJob(owner.id, org);
    expect(await insertProduct(owner.id, org, { name: "נכנס", import_job_id: job })).toBeTruthy();
    expect((await pgError(insertProduct(owner.id, org, { name: "לא נכנס", import_job_id: job }))).hint).toBe("limit:max_products");
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
  });

  it("a stale product import is closed with the products it created counted", async () => {
    const job = await newJob(owner.id, org);
    await insertProduct(owner.id, org, { name: "א", import_job_id: job });
    await insertProduct(owner.id, org, { name: "ב", import_job_id: job });
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.import_jobs set updated_at = now() - interval '11 minutes' where id = $1", [job]);
    });
    await asAdmin((q) => q("select app.fail_stale_imports()"));
    expect(await asAdmin(async (q) => (await q("select status, created_count from public.import_jobs where id = $1", [job])).rows[0])).toEqual({
      status: "failed",
      created_count: 2,
    });
  });

  it("undo removes exactly the products the import created", async () => {
    const job = await newJob(owner.id, org);
    await insertProduct(owner.id, org, { name: "לביטול 1", import_job_id: job });
    await insertProduct(owner.id, org, { name: "לביטול 2", import_job_id: job });
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    const before = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.products where organization_id = $1", [org])).rows[0].n));
    // what undoImportAction sends: delete by organization, job and ids
    const removed = await asUser(owner.id, (q) => q("delete from public.products where organization_id = $1 and import_job_id = $2", [org, job]));
    expect(removed.rowCount).toBe(2);
    const after = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.products where organization_id = $1", [org])).rows[0].n));
    expect(after).toBe(before - 2);
    // a member cannot
    const job2 = await newJob(owner.id, org);
    await insertProduct(owner.id, org, { name: "נשאר", import_job_id: job2 });
    const none = await asUser(member.id, (q) => q("delete from public.products where organization_id = $1 and import_job_id = $2", [org, job2]));
    expect(none.rowCount).toBe(0);
  });

  it("the product list export is audited; members may not export", async () => {
    await asUser(manager.id, (q) => q("select public.log_list_export($1, 'product', 'xlsx', 3, 'filtered', $2)", [org, JSON.stringify({ q: "כיסא", sort: "name" })]));
    const entry = await asAdmin(
      async (q) =>
        (await q<{ entity_type: string; changes: Record<string, unknown> }>(
          "select entity_type, changes from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1",
          [org],
        )).rows[0],
    );
    expect(entry.entity_type).toBe("products");
    expect(entry.changes).toMatchObject({ format: "xlsx", rows: 3, scope: "filtered", filters: { q: true, sort: "name" } });
    expect((await pgError(asUser(member.id, (q) => q("select public.log_list_export($1, 'product', 'csv', 1, 'filtered', '{}')", [org]))))).toMatchObject({ code: "42501" });
    expect((await pgError(asUser(owner.id, (q) => q("select public.log_list_export($1, 'invoice', 'csv', 1, 'filtered', '{}')", [org]))))).toMatchObject({ code: "22023" });
  });
});
