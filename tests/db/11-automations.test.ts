import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const processOutbox = () => asAdmin((q) => q("select app.process_outbox(5000)"));
const runScheduled = () => asAdmin((q) => q("select app.run_scheduled_automations()"));

describe("automations", () => {
  let owner: U, member: U, other: U;
  let org: string, otherOrg: string;
  let sourceId: string;
  let tagVip: string, otherOrgTag: string;
  let stages: { id: string; kind: string }[];
  let pipelineId: string;

  const createRule = (rule: Record<string, unknown>, as: U = owner) =>
    asUser(as.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            org,
            rule.name ?? "כלל",
            rule.entity_type,
            rule.trigger_type,
            JSON.stringify(rule.trigger_config ?? {}),
            JSON.stringify(rule.conditions ?? []),
            JSON.stringify(rule.actions),
          ],
        )
      ).rows[0].id,
    );
  const deactivate = (id: string) => asUser(owner.id, (q) => q("update public.automations set is_active = false where id = $1", [id]));
  const runsOf = (id: string) =>
    asAdmin(async (q) => (await q<{ status: string; steps: Array<{ status: string; error?: string }> }>("select status, steps from public.automation_runs where automation_id = $1 order by created_at", [id])).rows);

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "member");
    other = await createUser("other");
    otherOrg = await createOrg(other.id, "ארגון אחר");
    ({ pipelineId, stages } = await defaultPipeline(org));
    sourceId = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 and kind = 'facebook'", [org])).rows[0].id,
    );
    tagVip = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'VIP') returning id", [org])).rows[0].id,
    );
    otherOrgTag = await asUser(other.id, async (q) =>
      (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id,
    );
    await processOutbox(); // start from a clean queue
  });

  it("a new lead creates a task for its owner and notifies them, exactly once", async () => {
    const rule = await createRule({
      entity_type: "lead",
      trigger_type: "created",
      actions: [
        { type: "create_task", title: "לחזור ל{{name}}", due_in_minutes: 15, task_type: "call" },
        { type: "notify", to: "owner", title: "ליד חדש: {{name}}" },
      ],
    });
    const lead = await insertLead(member.id, org, { full_name: "שירה" });
    await processOutbox();
    await processOutbox();

    await asAdmin(async (q) => {
      const task = (
        await q<{ title: string; owner_id: string; task_type: string; minutes: number }>(
          "select title, owner_id, task_type, extract(epoch from (due_at - now())) / 60 as minutes from public.tasks where lead_id = $1",
          [lead],
        )
      ).rows;
      expect(task).toHaveLength(1);
      expect(task[0]).toMatchObject({ title: "לחזור לשירה", owner_id: member.id, task_type: "call" });
      expect(Number(task[0].minutes)).toBeGreaterThan(10);
      expect(await count(q, "select 1 from public.notifications where user_id = $1 and type = 'automation' and entity_id = $2", [member.id, lead])).toBe(1);
    });
    expect((await runsOf(rule)).map((r) => r.status)).toEqual(["success"]);
    await deactivate(rule);
  });

  it("conditions decide: a rule for Facebook leads ignores other leads", async () => {
    const rule = await createRule({
      entity_type: "lead",
      trigger_type: "created",
      conditions: [{ field: "source_id", op: "eq", value: sourceId }],
      actions: [{ type: "add_tag", tag_id: tagVip }],
    });
    const plain = await insertLead(member.id, org, { full_name: "בלי מקור" });
    const fromFb = await insertLead(member.id, org, { full_name: "מפייסבוק", source_id: sourceId });
    await processOutbox();
    await asAdmin(async (q) => {
      const tags = (await q<{ id: string; tag_ids: string[] }>("select id, tag_ids from public.leads where id in ($1, $2)", [plain, fromFb])).rows;
      expect(tags.find((r) => r.id === fromFb)?.tag_ids).toEqual([tagVip]);
      expect(tags.find((r) => r.id === plain)?.tag_ids).toEqual([]);
    });
    await deactivate(rule);
  });

  it("field change to a value: status 'did not answer' sets the next status and the run is logged", async () => {
    const statuses = await asAdmin(async (q) =>
      (await q<{ id: string; name: string }>("select id, name from public.lead_statuses where organization_id = $1", [org])).rows,
    );
    const noAnswer = statuses.find((s) => s.name === "לא ענה")!.id;
    const inProgress = statuses.find((s) => s.name === "בטיפול")!.id;
    const rule = await createRule({
      entity_type: "lead",
      trigger_type: "field_changed",
      trigger_config: { field: "status_id", to: noAnswer },
      actions: [{ type: "create_task", title: "ניסיון נוסף", due_in_days: 2 }, { type: "set_lead_status", status_id: inProgress }],
    });
    const lead = await insertLead(member.id, org, { full_name: "לא עונה" });
    await processOutbox();
    await asUser(member.id, (q) => q("update public.leads set status_id = $1 where id = $2", [noAnswer, lead]));
    await processOutbox();
    await processOutbox();
    await asAdmin(async (q) => {
      expect((await q<{ status_id: string }>("select status_id from public.leads where id = $1", [lead])).rows[0].status_id).toBe(inProgress);
      expect(await count(q, "select 1 from public.tasks where lead_id = $1 and title = 'ניסיון נוסף'", [lead])).toBe(1);
    });
    // the automation's own status change did not trigger it (or anything) again
    expect(await runsOf(rule)).toHaveLength(1);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1 and payload ->> 'origin' = 'automation'", [lead])),
    ).toBeGreaterThan(0);
    await deactivate(rule);
  });

  it("a failing step is logged and the next steps still run; ids of another organization are refused", async () => {
    const rule = await createRule({
      entity_type: "lead",
      trigger_type: "created",
      actions: [
        { type: "add_tag", tag_id: otherOrgTag },
        { type: "create_task", title: "עדיין נוצרה" },
      ],
    });
    const lead = await insertLead(member.id, org, { full_name: "בדיקת שגיאה" });
    await processOutbox();
    const runs = await runsOf(rule);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("partial");
    expect(runs[0].steps[0]).toMatchObject({ status: "error", error: "the tag no longer exists" });
    await asAdmin(async (q) => {
      expect((await q<{ tag_ids: string[] }>("select tag_ids from public.leads where id = $1", [lead])).rows[0].tag_ids).toEqual([]);
      expect(await count(q, "select 1 from public.tasks where lead_id = $1 and title = 'עדיין נוצרה'", [lead])).toBe(1);
    });
    await deactivate(rule);
  });

  it("a won deal asks for a review three days later", async () => {
    const rule = await createRule({
      entity_type: "deal",
      trigger_type: "deal_won",
      actions: [{ type: "create_task", title: "לבקש חוות דעת מ{{name}}", due_in_days: 3 }],
    });
    const open = stages.find((s) => s.kind === "open")!.id;
    const won = stages.find((s) => s.kind === "won")!.id;
    const deal = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'שיפוץ', $2, $3) returning id", [org, pipelineId, open]))
        .rows[0].id,
    );
    await processOutbox();
    await asUser(member.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [won, deal]));
    await processOutbox();
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where deal_id = $1 and title = 'לבקש חוות דעת משיפוץ' and due_at > now() + interval '2 days'", [deal]))).toBe(1);
    await deactivate(rule);
  });

  it("time-based rules: stuck deal, birthday, task due soon, no activity; each occasion runs once", async () => {
    const open = stages.find((s) => s.kind === "open")!.id;
    const stuckRule = await createRule({ entity_type: "deal", trigger_type: "stuck_in_stage", trigger_config: { days: 10 }, actions: [{ type: "notify", to: "admins", title: "עסקה תקועה: {{name}}" }] });
    const bdayRule = await createRule({ entity_type: "contact", trigger_type: "birthday", actions: [{ type: "create_task", title: "לברך את {{name}}" }] });
    const dueRule = await createRule({
      entity_type: "task",
      trigger_type: "task_due_soon",
      trigger_config: { minutes: 60 },
      conditions: [{ field: "task_type", op: "eq", value: "meeting" }],
      actions: [{ type: "notify", to: "owner", title: "תזכורת: {{name}}" }],
    });
    const quietRule = await createRule({ entity_type: "lead", trigger_type: "no_activity", trigger_config: { days: 3 }, actions: [{ type: "notify", to: "owner", title: "אין פעילות: {{name}}" }] });

    const deal = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'תקועה', $2, $3) returning id", [org, pipelineId, open])).rows[0].id,
    );
    const contact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, birth_date) values ($1, 'חוגג', (now() at time zone 'Asia/Jerusalem')::date - interval '30 years') returning id", [org])).rows[0].id,
    );
    const meeting = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, task_type, due_at) values ($1, 'פגישה עם יעל', 'meeting', now() + interval '30 minutes') returning id", [org])).rows[0].id,
    );
    const todo = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, due_at) values ($1, 'סתם משימה', now() + interval '30 minutes') returning id", [org])).rows[0].id,
    );
    const quiet = await insertLead(member.id, org, { full_name: "שקט" });
    await asAdmin(async (q) => {
      await q("update public.deals set stage_entered_at = now() - interval '20 days' where id = $1", [deal]);
      // touch_row keeps created_at as it was; skip triggers to age the leads for this test
      await q("set local session_replication_role = replica");
      await q("update public.leads set created_at = now() - interval '5 days' where organization_id = $1", [org]);
      await q("set local session_replication_role = origin");
    });
    await processOutbox();
    await runScheduled();
    await runScheduled();

    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.notifications where user_id = $1 and entity_id = $2 and title = 'עסקה תקועה: תקועה'", [owner.id, deal])).toBe(1);
      expect(await count(q, "select 1 from public.tasks where contact_id = $1 and title = 'לברך את חוגג'", [contact])).toBe(1);
      expect(await count(q, "select 1 from public.notifications where entity_id = $1 and title = 'תזכורת: פגישה עם יעל'", [meeting])).toBe(1);
      expect(await count(q, "select 1 from public.notifications where entity_id = $1", [todo])).toBe(0);
      expect(await count(q, "select 1 from public.notifications where entity_id = $1 and title = 'אין פעילות: שקט'", [quiet])).toBe(1);
    });
    for (const rule of [stuckRule, bdayRule, dueRule]) {
      expect((await runsOf(rule)).length, rule).toBe(1);
      await deactivate(rule);
    }
    await deactivate(quietRule);
  });

  it("test run from the screen: admins only, conditions ignored, logged", async () => {
    const rule = await createRule({
      entity_type: "lead",
      trigger_type: "created",
      conditions: [{ field: "source_id", op: "eq", value: sourceId }],
      actions: [{ type: "add_tag", tag_id: tagVip }],
    });
    await deactivate(rule);
    const lead = await insertLead(member.id, org, { full_name: "בדיקה ידנית" });
    const denied = await pgError(asUser(member.id, (q) => q("select public.run_automation_now($1, $2)", [rule, lead])));
    expect(denied.code).toBe("P0002");
    const result = await asUser(owner.id, async (q) =>
      (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, lead])).rows[0].r,
    );
    expect(result.status).toBe("success");
    expect((await asAdmin(async (q) => (await q<{ tag_ids: string[] }>("select tag_ids from public.leads where id = $1", [lead])).rows[0].tag_ids))).toEqual([tagVip]);
  });

  it("rules and their runs are for admins; clients cannot call the engine", async () => {
    await asUser(member.id, async (q) => {
      expect(await count(q, "select 1 from public.automations where organization_id = $1", [org])).toBe(0);
      expect(await count(q, "select 1 from public.automation_runs where organization_id = $1", [org])).toBe(0);
    });
    const insert = await pgError(
      asUser(member.id, (q) => q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'x', 'lead', 'created', '[{\"type\":\"notify\"}]')", [org])),
    );
    expect(insert.code).toBe("42501");
    await asUser(member.id, async (q) => {
      expect((await q("update public.automations set name = 'x' where organization_id = $1", [org])).rowCount).toBe(0);
      expect((await q("delete from public.automations where organization_id = $1", [org])).rowCount).toBe(0);
    });
    await asUser(other.id, async (q) => {
      expect((await q("update public.automations set name = 'x' where organization_id = $1", [org])).rowCount).toBe(0);
      expect((await q("delete from public.automations where organization_id = $1", [org])).rowCount).toBe(0);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.automations where organization_id = $1 and name = 'x'", [org]))).toBe(0);
    for (const fn of ["app.process_outbox(1)", "app.run_scheduled_automations()"]) {
      const err = await pgError(asUser(owner.id, (q) => q(`select ${fn}`)));
      expect(err.code, fn).toBe("42501");
    }
  });

  it("plan limit: the free plan has three active automations", async () => {
    const freeOwner = await createUser("free");
    const freeOrg = await createOrg(freeOwner.id, "עסק חינמי");
    await asAdmin((q) => q("update public.subscriptions set plan_key = 'free', status = 'active' where organization_id = $1", [freeOrg]));
    const add = (active: boolean) =>
      asUser(freeOwner.id, (q) =>
        q(
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'x', 'lead', 'created', '[{\"type\":\"notify\"}]', $2) returning id",
          [freeOrg, active],
        ),
      );
    for (let i = 0; i < 3; i++) await add(true);
    expect((await pgError(add(true))).hint).toBe("limit:max_active_automations");
    const inactive = (await add(false)).rows[0].id as string;
    expect((await pgError(asUser(freeOwner.id, (q) => q("update public.automations set is_active = true where id = $1", [inactive])))).hint).toBe(
      "limit:max_active_automations",
    );
  });
});
