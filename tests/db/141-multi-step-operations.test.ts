import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// FXD-07: each multi-step operation is one database call, so it happens whole or not at all.
describe("one call per multi-step operation (FXD-07)", () => {
  let owner: U, manager: U, member: U;
  let org: string, team: string;

  beforeAll(async () => {
    owner = await createUser("fxd07-owner");
    org = await createOrg(owner.id, "עסק פעולות");
    manager = await addMember(org, owner.id, "manager", "fxd07-manager");
    member = await addMember(org, owner.id, "member", "fxd07-member");
    team = await asUser(owner.id, async (q) => {
      const t = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, t, manager.id]);
      return t;
    });
  });

  const defaultPipeline = () =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default and deleted_at is null", [org])).rows.map((r) => r.id));

  it("the default pipeline moves in one call; a refused move leaves the old default", async () => {
    const [first] = await defaultPipeline();
    const second = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.pipelines (organization_id, name, position) values ($1, 'שני', 1) returning id", [org])).rows[0].id);
    // a member may not: nothing changes (before, the old default was already cleared by then)
    expect((await pgError(asUser(member.id, (q) => q("select public.set_default_pipeline($1, $2)", [org, second])))).code).toBe("42501");
    expect(await defaultPipeline()).toEqual([first]);
    // a pipeline in the recycle bin: refused, the old default stays
    const binned = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.pipelines (organization_id, name, position, deleted_at) values ($1, 'בסל', 2, now()) returning id", [org])).rows[0].id);
    expect((await pgError(asUser(owner.id, (q) => q("select public.set_default_pipeline($1, $2)", [org, binned])))).code).toBe("42501");
    expect(await defaultPipeline()).toEqual([first]);
    await asUser(owner.id, (q) => q("select public.set_default_pipeline($1, $2)", [org, second]));
    expect(await defaultPipeline()).toEqual([second]);
    await asUser(owner.id, (q) => q("select public.set_default_pipeline($1, $2)", [org, first]));
  });

  it("the default lead status moves in one call, only to an open status", async () => {
    const before = await defaultLeadStatus(org);
    const statuses = await asAdmin(async (q) => (await q<{ id: string; kind: string }>("select id, kind from public.lead_statuses where organization_id = $1 order by position", [org])).rows);
    const open = statuses.find((s) => s.kind === "open" && s.id !== before)!.id;
    const closed = statuses.find((s) => s.kind !== "open")!.id;
    expect((await pgError(asUser(owner.id, (q) => q("select public.set_default_lead_status($1, $2)", [org, closed])))).hint).toBe("lead_status:default_open");
    expect((await pgError(asUser(member.id, (q) => q("select public.set_default_lead_status($1, $2)", [org, open])))).code).toBe("42501");
    expect(await defaultLeadStatus(org)).toBe(before);
    await asUser(owner.id, (q) => q("select public.set_default_lead_status($1, $2)", [org, open]));
    expect(await defaultLeadStatus(org)).toBe(open);
    await asUser(owner.id, (q) => q("select public.set_default_lead_status($1, $2)", [org, before]));
  });

  it("a list's order is saved whole or not at all", async () => {
    const order = () => asAdmin(async (q) => (await q<{ id: string; position: number }>("select id, position from public.disqualify_reasons where organization_id = $1 order by position, id", [org])).rows);
    const before = await order();
    const reversed = [...before].reverse().map((r) => r.id);
    // a member may not change the list: nothing moves
    expect((await pgError(asUser(member.id, (q) => q("select public.reorder_positions('disqualify_reasons', $1, $2::uuid[])", [org, reversed])))).code).toBe("42501");
    expect(await order()).toEqual(before);
    // an id of another business: nothing moves
    const boss = await createUser("fxd07-other");
    const other = await createOrg(boss.id, "עסק אחר");
    const foreign = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.disqualify_reasons where organization_id = $1 limit 1", [other])).rows[0].id);
    expect((await pgError(asUser(owner.id, (q) => q("select public.reorder_positions('disqualify_reasons', $1, $2::uuid[])", [org, [...reversed.slice(1), foreign]])))).code).toBe("42501");
    expect(await order()).toEqual(before);
    // a list it does not know, and a repeated id
    expect((await pgError(asUser(owner.id, (q) => q("select public.reorder_positions('leads', $1, $2::uuid[])", [org, reversed])))).hint).toBe("reorder:table");
    expect((await pgError(asUser(owner.id, (q) => q("select public.reorder_positions('disqualify_reasons', $1, $2::uuid[])", [org, [reversed[0], reversed[0]]])))).code).toBe("22023");
    // the owner: the whole order, positions 0..n-1
    await asUser(owner.id, (q) => q("select public.reorder_positions('disqualify_reasons', $1, $2::uuid[])", [org, reversed]));
    expect((await order()).map((r) => [r.id, r.position])).toEqual(reversed.map((id, i) => [id, i]));
    // stages too
    const stages = await asAdmin(async (q) => (await q<{ id: string }>("select s.id from public.stages s join public.pipelines p on p.id = s.pipeline_id where p.organization_id = $1 and p.is_default order by s.position", [org])).rows.map((r) => r.id));
    const swapped = [stages[1], stages[0], ...stages.slice(2)];
    await asUser(owner.id, (q) => q("select public.reorder_positions('stages', $1, $2::uuid[])", [org, swapped]));
    expect(await asAdmin(async (q) => (await q<{ id: string }>("select id from public.stages where id = any($1::uuid[]) order by position", [stages])).rows.map((r) => r.id))).toEqual(swapped);
  });

  it("an import is undone whole, or not at all when one of its records is no longer the importer's to change", async () => {
    const status = await defaultLeadStatus(org);
    const importLeads = (n: number) =>
      asUser(manager.id, async (q) => {
        const job = (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'l.csv', 'skip') returning id", [org])).rows[0].id;
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          ids.push((await q<{ id: string }>("insert into public.leads (organization_id, full_name, status_id, team_id, import_job_id) values ($1, $2, $3, $4, $5) returning id", [org, `מיובא ${i}`, status, team, job])).rows[0].id);
        }
        await q("update public.import_jobs set status = 'done' where id = $1", [job]);
        return { job, ids };
      });
    const jobStatus = (job: string) => asAdmin(async (q) => (await q<{ s: string }>("select status as s from public.import_jobs where id = $1", [job])).rows[0].s);
    const live = (ids: string[]) => asAdmin((q) => count(q, "select 1 from public.leads where id = any($1::uuid[]) and deleted_at is null", [ids]));

    // one of the leads moved out of the manager's team meanwhile: nothing is undone, and the import is not marked
    const a = await importLeads(3);
    await asAdmin((q) => q("update public.leads set team_id = null, owner_id = $2 where id = $1", [a.ids[0], owner.id]));
    let detail: string | undefined;
    const refused = await asUser(manager.id, (q) => q("select public.undo_import($1, $2)", [org, a.job])).then(
      () => null,
      (e: { code?: string; hint?: string; detail?: string }) => {
        detail = e.detail;
        return e;
      },
    );
    expect(refused?.hint).toBe("import_undo:left");
    expect(detail).toBe("1");
    expect(await live(a.ids)).toBe(3);
    expect(await jobStatus(a.job)).toBe("done");

    // all of them the manager's: all to the recycle bin, and the import marked undone
    const b = await importLeads(2);
    const result = await asUser(manager.id, async (q) => (await q<{ r: { done: number } }>("select public.undo_import($1, $2) as r", [org, b.job])).rows[0].r);
    expect(result).toEqual({ done: 2 });
    expect(await live(b.ids)).toBe(0);
    expect(await jobStatus(b.job)).toBe("undone");
    // once only, and only by the importer: not by the owner, not by another manager
    expect((await pgError(asUser(manager.id, (q) => q("select public.undo_import($1, $2)", [org, b.job])))).hint).toBe("import_undo:status");
    expect((await pgError(asUser(owner.id, (q) => q("select public.undo_import($1, $2)", [org, a.job])))).code).toBe("P0002");
    const otherManager = await addMember(org, owner.id, "manager", "fxd07-manager2");
    expect((await pgError(asUser(otherManager.id, (q) => q("select public.undo_import($1, $2)", [org, a.job])))).code).toBe("P0002");
    expect(await jobStatus(a.job)).toBe("done");

    // after 7 days: refused, nothing moved
    const c = await importLeads(1);
    // touch_row keeps created_at on an update; set the date with triggers off, for this transaction only
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.import_jobs set created_at = now() - interval '8 days' where id = $1", [c.job]);
    });
    expect((await pgError(asUser(manager.id, (q) => q("select public.undo_import($1, $2)", [org, c.job])))).hint).toBe("import_undo:expired");
    expect(await live(c.ids)).toBe(1);
    expect(await jobStatus(c.job)).toBe("done");

    // records the importer may edit but not move to the recycle bin (a member with the import permission, who
    // calls this directly instead of undo_own_import): the count, not a plain 42501 from guard_soft_delete
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, member.id, ["import"]]));
    const d = await asUser(member.id, async (q) => {
      const job = (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'm.csv', 'skip') returning id", [org])).rows[0].id;
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        ids.push((await q<{ id: string }>("insert into public.leads (organization_id, full_name, status_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `של חבר ${i}`, status, job])).rows[0].id);
      }
      await q("update public.import_jobs set status = 'done' where id = $1", [job]);
      return { job, ids };
    });
    let ownDetail: string | undefined;
    const own = await asUser(member.id, (q) => q("select public.undo_import($1, $2)", [org, d.job])).then(
      () => null,
      (e: { code?: string; hint?: string; detail?: string }) => {
        ownDetail = e.detail;
        return e;
      },
    );
    expect(own?.hint).toBe("import_undo:left");
    expect(ownDetail).toBe("2");
    expect(await live(d.ids)).toBe(2);
    expect(await jobStatus(d.job)).toBe("done");
  });

  it("a contacts import takes with it the companies it made that no live contact uses", async () => {
    const { job, kept, gone } = await asUser(owner.id, async (q) => {
      const j = (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'c.csv', 'skip') returning id", [org])).rows[0].id;
      const company = async (name: string) => (await q<{ id: string }>("insert into public.companies (organization_id, name, import_job_id) values ($1, $2, $3) returning id", [org, name, j])).rows[0].id;
      const used = await company("בשימוש");
      const unused = await company("לבד");
      await q("insert into public.contacts (organization_id, first_name, company_id, import_job_id) values ($1, 'מיובא', $2, $3)", [org, unused, j]);
      await q("update public.import_jobs set status = 'done' where id = $1", [j]);
      return { job: j, kept: used, gone: unused };
    });
    // someone outside the import works with the first company
    await asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name, company_id) values ($1, 'אמיתי', $2)", [org, kept]));
    await asUser(owner.id, (q) => q("select public.undo_import($1, $2)", [org, job]));
    const liveCompany = (id: string) => asAdmin((q) => count(q, "select 1 from public.companies where id = $1 and deleted_at is null", [id]));
    expect(await liveCompany(kept)).toBe(1);
    expect(await liveCompany(gone)).toBe(0);
  });

  it("the helper counts only for the importer, and nothing is open to anonymous callers", async () => {
    const grants = await asAdmin(
      async (q) =>
        (await q<{ a: boolean; b: boolean; c: boolean; d: boolean }>(
          `select has_function_privilege('anon', 'public.set_default_pipeline(uuid, uuid)', 'execute') as a,
                  has_function_privilege('anon', 'public.reorder_positions(text, uuid, uuid[])', 'execute') as b,
                  has_function_privilege('anon', 'public.undo_import(uuid, uuid)', 'execute') as c,
                  has_function_privilege('anon', 'app.import_rows_left(uuid, uuid)', 'execute') as d`,
        )).rows[0],
    );
    expect(grants).toEqual({ a: false, b: false, c: false, d: false });
  });
});
