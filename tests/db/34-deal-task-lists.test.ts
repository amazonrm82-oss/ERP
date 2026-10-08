import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

describe("deals and tasks as lists (LST-09)", () => {
  let owner: { id: string }, avi: { id: string }, rep: { id: string };
  let org: string;
  let stages: { id: string; kind: string }[];
  let pipelineId: string;

  beforeAll(async () => {
    owner = await createUser("dt-owner");
    org = await createOrg(owner.id);
    avi = await addMember(org, owner.id, "admin", "אבי");
    rep = await addMember(org, owner.id, "member", "dt-rep");
    await asAdmin((q) => q("update public.profiles set full_name = 'תמר' where id = $1", [owner.id]));
    ({ pipelineId, stages } = await defaultPipeline(org));
  });

  const insertDeal = (fields: Record<string, unknown>) =>
    asUser(owner.id, async (q) => {
      const keys = Object.keys(fields);
      const sql = `insert into public.deals (organization_id, pipeline_id, ${keys.join(", ")}) values ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [org, pipelineId, ...Object.values(fields)])).rows[0].id;
    });

  it("deals order by stage position, contact, company and owner", async () => {
    const [x, y] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'זית') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'אלון') returning id", [org])).rows[0].id,
    ]);
    const [c1, c2] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'רות') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דן') returning id", [org])).rows[0].id,
    ]);
    const a = await insertDeal({ name: "א", stage_id: stages[1].id, contact_id: c1, company_id: x, owner_id: owner.id });
    const b = await insertDeal({ name: "ב", stage_id: stages[0].id, contact_id: c2, company_id: y, owner_id: avi.id });
    const order = (by: string) =>
      asUser(owner.id, async (q) => (await q<{ id: string }>(`select d.id from public.deals d where d.id = any ($1) order by public.${by}(d), d.id`, [[a, b]])).rows.map((r) => r.id));
    expect(await order("sort_stage")).toEqual([b, a]);
    expect(await order("sort_contact")).toEqual([b, a]); // דן < רות
    expect(await order("sort_company")).toEqual([b, a]); // אלון < זית
    expect(await order("sort_owner")).toEqual([b, a]); // אבי < תמר
  });

  it("tasks order by owner name", async () => {
    const [t1, t2] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'ראשונה', $2) returning id", [org, owner.id])).rows[0].id,
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'שנייה', $2) returning id", [org, avi.id])).rows[0].id,
    ]);
    const ids = await asUser(owner.id, async (q) => (await q<{ id: string }>("select t.id from public.tasks t where t.id = any ($1) order by public.sort_owner(t)", [[t1, t2]])).rows.map((r) => r.id));
    expect(ids).toEqual([t2, t1]);
  });

  it("the sort fields read with the caller's rights: another organization's names stay hidden", async () => {
    const outsider = await createUser("dt-outsider");
    const otherOrg = await createOrg(outsider.id);
    const theirCompany = await asUser(
      outsider.id,
      async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'סודי') returning id", [otherOrg])).rows[0].id,
    );
    const deal = await insertDeal({ name: "ג", stage_id: stages[0].id });
    const shown = await asUser(owner.id, async (q) =>
      (
        await q<{ name: string | null }>(
          "select public.sort_company(jsonb_populate_record(d, jsonb_build_object('organization_id', $2::uuid, 'company_id', $3::uuid))) as name from public.deals d where d.id = $1",
          [deal, otherOrg, theirCompany],
        )
      ).rows[0].name,
    );
    expect(shown).toBeNull();
    expect((await pgError(asAnon((q) => q("select public.sort_stage(d) from public.deals d limit 1")))).code).toBe("42501");
  });

  it("columns can be saved for the deals and tasks lists, and nothing else new", async () => {
    await asUser(rep.id, (q) =>
      q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'deal', '[]'), ($1, 'task', '[]')", [org]),
    );
    const saved = await asUser(rep.id, async (q) => (await q<{ object_type: string }>("select object_type from public.list_preferences order by 1")).rows.map((r) => r.object_type));
    expect(saved).toEqual(["deal", "task"]);
    expect((await pgError(asUser(rep.id, (q) => q("insert into public.list_preferences (organization_id, object_type) values ($1, 'note')", [org])))).code).toBe("23514");
  });

  it("exporting the deals or tasks list is logged", async () => {
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'deal', 'xlsx', 2, 'filtered', '{}'), public.log_list_export($1, 'task', 'csv', 1, 'selected', '{}')", [org]));
    const logged = await asAdmin(
      async (q) => (await q<{ entity_type: string }>("select entity_type from public.audit_log where organization_id = $1 and action = 'export' order by id", [org])).rows.map((r) => r.entity_type),
    );
    expect(logged).toEqual(["deals", "tasks"]);
    expect((await pgError(asUser(rep.id, (q) => q("select public.log_list_export($1, 'deal', 'csv', 1, 'filtered', '{}')", [org])))).code).toBe("42501");
  });
});
