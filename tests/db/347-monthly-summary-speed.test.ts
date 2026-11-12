import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * MNY-06 review: the monthly summary on 20,000 leads and 300,000 audit entries stays well under the hosted statement
 * timeout. Under RLS every audit row paid audit_log_select's is_admin (61.9 s on 300k rows); the counts now run in the
 * admin-checked definer, every audit read bounded by created_at (audit_log_org_time_idx). The fixture is analyzed first:
 * unanalyzed estimates hide plans that real statistics pick (021144).
 */
describe("monthly summary on a large business (MNY-06 review)", () => {
  let owner: U, admin: U;
  let org: string;
  const BOUND_MS = 2000;

  beforeAll(async () => {
    owner = await createUser("mss-owner");
    org = await createOrg(owner.id, "עסק גדול");
    admin = await addMember(org, owner.id, "admin", "mss-admin");
    // fixture rows in bulk, triggers set aside (server data): 20,000 leads the server made this month with an owner, their
    // insert entries, 100,000 owner changes by a person this month and 180,000 lead entries of the six months before
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      const statusId = (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and is_default", [org])).rows[0].id;
      await q(
        `with b as (select date_trunc('month', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem' as m)
         insert into public.leads (organization_id, status_id, full_name, owner_id, created_at, updated_at)
         select $1, $2, 'ליד ' || g, $3, b.m + (now() - b.m) * (g::float / 20001), now() from b, generate_series(1, 20000) g`,
        [org, statusId, owner.id],
      );
      await q(
        `insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes, created_at)
         select l.organization_id, null, 'insert', 'leads', l.id, '{}'::jsonb, l.created_at from public.leads l where l.organization_id = $1`,
        [org],
      );
      await q(
        `with l as (select id, created_at, row_number() over (order by id) as n from public.leads where organization_id = $1)
         insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes, created_at)
         select $1, $2::uuid, 'update', 'leads', l.id,
                jsonb_build_object('owner_id', jsonb_build_object('old', $2::text, 'new', $3::text)),
                l.created_at + (now() - l.created_at) * (g::float / 6)
           from l, generate_series(1, 5) g`,
        [org, owner.id, admin.id],
      );
      await q(
        `insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes, created_at)
         select $1, null, case when g % 3 = 0 then 'insert' else 'update' end, case when g % 2 = 0 then 'leads' else 'tasks' end,
                gen_random_uuid(),
                case when g % 3 = 0 then '{}'::jsonb else jsonb_build_object('owner_id', jsonb_build_object('old', null, 'new', $2::text)) end,
                (date_trunc('month', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') - (g % 180 + 1) * interval '1 day'
           from generate_series(1, 180000) g`,
        [org, owner.id],
      );
    });
    await asAdmin((q) => q("analyze public.leads, public.audit_log"));
  });

  it.each([
    ["owner", () => owner],
    ["admin", () => admin],
  ])("%s: 20,000 leads and 300,000 audit entries counted within the bound", async (_name, who) => {
    const started = Date.now();
    const r = await asUser(who().id, async (q) =>
      (await q<{ r: { allowed: boolean; leads_distributed: number; automation_tasks: number } }>("select public.report_monthly_summary($1) as r", [org])).rows[0].r,
    );
    const took = Date.now() - started;
    console.info(`MNY-06 summary, ${_name}: ${took} ms`);
    expect(r.allowed).toBe(true);
    // every lead the server made with an owner; the person's later changes and the earlier months add nothing
    expect(r.leads_distributed).toBe(20000);
    expect(r.automation_tasks).toBe(0);
    expect(took).toBeLessThan(BOUND_MS);
  });

  it("the 300,000 entries are there", async () => {
    const n = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.audit_log where organization_id = $1", [org])).rows[0].n));
    expect(n).toBeGreaterThanOrEqual(300000);
  });
});
