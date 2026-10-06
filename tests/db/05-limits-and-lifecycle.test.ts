import { afterAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, insertLead, pgError } from "./helpers";

afterAll(closePool);

describe("plan limits", () => {
  it("pipelines are capped by the plan", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await asAdmin((q) => q("update public.subscriptions set plan_key = 'free', status = 'active' where organization_id = $1", [org]));

    const err = await pgError(
      asUser(owner.id, (q) => q("insert into public.pipelines (organization_id, name) values ($1, 'שני')", [org])),
    );
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:max_pipelines");

    await asAdmin((q) => q("update public.subscriptions set plan_key = 'basic' where organization_id = $1", [org]));
    await asUser(owner.id, (q) => q("insert into public.pipelines (organization_id, name) values ($1, 'שני')", [org]));
  });

  it("live records are counted across leads, contacts, companies and deals", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await asAdmin((q) =>
      q(`update public.subscriptions set limit_overrides = '{"max_records": 3}' where organization_id = $1`, [org]),
    );
    const usage = () =>
      asAdmin(async (q) =>
        Number((await q<{ n: string }>("select records_count as n from public.org_usage where organization_id = $1", [org])).rows[0].n),
      );

    const lead1 = await insertLead(owner.id, org);
    await insertLead(owner.id, org);
    await asUser(owner.id, (q) => q("insert into public.companies (organization_id, name) values ($1, 'חברה')", [org]));
    expect(await usage()).toBe(3);

    const over = await pgError(
      asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name) values ($1, 'רביעי')", [org])),
    );
    expect(over.code).toBe("P0001");
    expect(over.hint).toBe("limit:max_records");
    expect(await usage()).toBe(3); // the failed insert left no trace

    // moving one to the recycle bin frees a slot
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead1]));
    expect(await usage()).toBe(2);
    await asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name) values ($1, 'רביעי')", [org]));
    expect(await usage()).toBe(3);

    // restoring it would exceed the limit again
    const restore = await pgError(
      asUser(owner.id, (q) => q("update public.leads set deleted_at = null where id = $1", [lead1])),
    );
    expect(restore.hint).toBe("limit:max_records");

    // purging a trashed row does not change the count of live rows
    await asUser(owner.id, (q) => q("delete from public.leads where id = $1", [lead1]));
    expect(await usage()).toBe(3);

    // the counter matches reality
    const real = await asAdmin((q) =>
      count(
        q,
        `select 1 from public.leads where organization_id = $1 and deleted_at is null
         union all select 1 from public.contacts where organization_id = $1 and deleted_at is null
         union all select 1 from public.companies where organization_id = $1 and deleted_at is null
         union all select 1 from public.deals where organization_id = $1 and deleted_at is null`,
        [org],
      ),
    );
    expect(real).toBe(3);
  });

  it("custom fields are capped per object", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await asAdmin((q) =>
      q(`update public.subscriptions set limit_overrides = '{"max_custom_fields_per_object": 1}' where organization_id = $1`, [org]),
    );
    const add = (object: string, key: string) =>
      asUser(owner.id, (q) =>
        q(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, $2, $3, 'שדה', 'text')",
          [org, object, key],
        ),
      );
    await add("lead", "one");
    expect((await pgError(add("lead", "two"))).hint).toBe("limit:max_custom_fields_per_object");
    await add("contact", "one");
  });
});

describe("organization lifecycle", () => {
  it("a read-only organization can be read and exported but not changed", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    const lead = await insertLead(owner.id, org);
    const status = await defaultLeadStatus(org);

    for (const state of ["read_only", "suspended", "cancelled"]) {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [state, org]));

      await asUser(owner.id, async (q) => {
        expect(await count(q, "select 1 from public.leads where id = $1", [lead]), state).toBe(1);
        expect((await q("update public.leads set campaign = 'x' where id = $1", [lead])).rowCount, state).toBe(0);
        expect((await q("update public.leads set deleted_at = now() where id = $1", [lead])).rowCount, state).toBe(0);
      });
      for (const [sql, params] of [
        ["insert into public.leads (organization_id, status_id, full_name) values ($1, $2, 'x')", [org, status]],
        ["insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [org, lead]],
        ["insert into public.tasks (organization_id, title) values ($1, 'x')", [org]],
        ["insert into public.pipelines (organization_id, name) values ($1, 'x')", [org]],
        ["insert into public.tags (organization_id, name) values ($1, 'x')", [org]],
      ] as [string, unknown[]][]) {
        expect((await pgError(asUser(owner.id, (q) => q(sql, params)))).code, `${state}: ${sql}`).toBe("42501");
      }
      expect((await pgError(asUser(owner.id, (q) => q("select public.create_invitation($1, 'x@example.test')", [org])))).code).toBe("42501");
    }

    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      expect((await q("update public.leads set campaign = 'x' where id = $1", [lead])).rowCount).toBe(1);
    });
  });

  it("deleting an organization removes everything that belonged to it", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await insertLead(owner.id, org);
    await asAdmin((q) => q("delete from public.organizations where id = $1", [org]));
    await asAdmin(async (q) => {
      for (const table of ["memberships", "leads", "pipelines", "stages", "subscriptions", "org_usage", "audit_log", "outbox_events"]) {
        expect(await count(q, `select 1 from public.${table} where organization_id = $1`, [org]), table).toBe(0);
      }
    });
  });
});
