import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TRIGGERS } from "../../src/features/automations/definitions";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Run = { status: string; retry_count: number; next_retry_at: Date | null; retry_note: string | null; steps: Array<Record<string, unknown>> };

/**
 * AUT-06 (owner's answer of 18 October 2026): the failed steps of a run are tried again, up to 3 times (15 minutes, 1 hour,
 * 6 hours), only while the rule is on and unchanged and the record still exists and meets the conditions; a step that
 * worked is never run twice; a retry is part of the same run (no AUT-07 count). Failures are told to the owners and admins,
 * and to the rule's creator when they are neither, once a day per rule.
 */
describe("retrying failed automation steps (AUT-06)", () => {
  let owner: U, admin: U, creator: U;
  let org: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // a rule whose first step works (a notice to the owner) and whose second adds a tag that does not exist yet
  const makeRule = async (tag: string) => {
    const id = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
           values ($1, 'כלל עם תגית', 'lead', 'field_changed', $2, $3) returning id`,
          [
            org,
            // a status change of a lead of this business (none happens here), so only these tests run the rule; no target
            // value, so the event still holds at a retry (owner's answer 5)
            JSON.stringify({ field: "status_id" }),
            JSON.stringify([{ type: "notify", to: "owner", title: `הודעה ${++n}` }, { type: "add_tag", tag_id: tag }]),
          ],
        )
      ).id,
    );
    await setCreator(id, creator.id);
    return id;
  };
  // created_by and updated_at are kept by touch_row; written here as stored data, past the triggers
  const raw = (sql: string, params: unknown[]) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(sql, params);
    });
  const setCreator = (rule: string, user: string) => raw("update public.automations set created_by = $2 where id = $1", [rule, user]);
  const run = (rule: string, lead: string, key = `event:aut06-${++n}`) =>
    asAdmin(async (q) => {
      await q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [rule, lead, key]);
      return (await one<{ id: string }>(q, "select id from public.automation_runs where automation_id = $1 and run_key = $2", [rule, key])).id;
    });
  const runRow = (id: string) =>
    asAdmin((q) => one<Run>(q, "select status, retry_count, next_retry_at, retry_note, steps from public.automation_runs where id = $1", [id]));
  const due = (id: string) => asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [id]));
  const retryAll = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.retry_automation_runs(500) as n")).n);
  const minutesAhead = (at: Date | null) => (at ? Math.round((at.getTime() - Date.now()) / 60_000) : null);

  beforeAll(async () => {
    owner = await createUser("ar-owner");
    org = await createOrg(owner.id, "עסק הניסיונות");
    admin = await addMember(org, owner.id, "admin", "ar-admin");
    creator = await addMember(org, owner.id, "member", "ar-creator");
  });

  it("a failed step is tried again 15 minutes later; when it works, the run succeeds and the working step is not repeated", async () => {
    const tag = randomUUID();
    const rule = await makeRule(tag);
    const lead = await insertLead(owner.id, org, { full_name: "ליד לניסיון" });
    const id = await run(rule, lead);
    let r = await runRow(id);
    expect(r).toMatchObject({ status: "partial", retry_count: 0, retry_note: null });
    expect(minutesAhead(r.next_retry_at)).toBe(15);

    // the owners and admins are told, and the creator (a member), once
    const told = await asAdmin(async (q) =>
      (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 and type = 'automation_failed'", [rule])).rows.map((x) => x.user_id).sort(),
    );
    expect(told).toEqual([owner.id, admin.id, creator.id].sort());

    // not yet due: nothing happens
    expect(await retryAll()).toBe(0);
    // the tag appears, and the retry comes due
    await asUser(owner.id, (q) => q("insert into public.tags (id, organization_id, name) values ($1, $2, 'תגית שנוצרה')", [tag, org]));
    await due(id);
    expect(await retryAll()).toBeGreaterThanOrEqual(1);
    r = await runRow(id);
    expect(r).toMatchObject({ status: "success", retry_count: 1, next_retry_at: null, retry_note: null });
    expect(r.steps).toEqual([
      { action: "notify", status: "ok" },
      { action: "add_tag", status: "ok", attempt: 2 },
    ]);
    // the first step (a notice) ran once
    const notices = await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = $2", [org, `הודעה ${n - 1}`]));
    expect(notices).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and $2 = any (tag_ids)", [lead, tag]))).toBe(1);
  });

  it("three retries at most: 15 minutes, then 1 hour, then 6 hours, then no more", async () => {
    const rule = await makeRule(randomUUID());
    const lead = await insertLead(owner.id, org, { full_name: "ליד שנכשל" });
    const id = await run(rule, lead);
    const waits: Array<number | null> = [minutesAhead((await runRow(id)).next_retry_at)];
    for (let i = 0; i < 3; i += 1) {
      await due(id);
      await retryAll();
      waits.push(minutesAhead((await runRow(id)).next_retry_at));
    }
    expect(waits).toEqual([15, 60, 360, null]);
    const r = await runRow(id);
    expect(r).toMatchObject({ status: "partial", retry_count: 3, retry_note: null });
    expect(r.steps[1]).toMatchObject({ action: "add_tag", status: "error", attempt: 4 });
    // a fourth pass does nothing
    await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [id]));
    await retryAll();
    expect((await runRow(id)).retry_count).toBe(3);
  });

  it("the failed step and every later step that did not run go again, in order; a step that worked never does (owner's answer 3)", async () => {
    const tag = randomUUID();
    const rule = await makeRule(tag);
    const last = `אחרון ${++n}`;
    await raw("update public.automations set actions = actions || $2::jsonb where id = $1", [rule, JSON.stringify([{ type: "notify", to: "owner", title: last }])]);
    const lead = await insertLead(owner.id, org, { full_name: "ליד עם צעד שלא רץ" });
    // the engine runs every step, so a run that stopped after its failed step is written here as stored data: the first step
    // worked, the second failed, the third never ran (missing from the log)
    const id = await asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status, steps, next_retry_at, event_facts)
           values ($1, $2, 'lead', $3, $4, 'partial', $5, now() - interval '1 second',
                   (select jsonb_build_object('value', to_jsonb(l.status_id)) from public.leads l where l.id = $3)) returning id`,
          [org, rule, lead, `event:aut06-stopped-${++n}`, JSON.stringify([{ action: "notify", status: "ok" }, { action: "add_tag", status: "error", error: "the tag no longer exists" }])],
        )
      ).id,
    );
    await asUser(owner.id, (q) => q("insert into public.tags (id, organization_id, name) values ($1, $2, 'תגית שנייה')", [tag, org]));
    await retryAll();
    const r = await runRow(id);
    expect(r.status).toBe("success");
    expect(r.steps).toEqual([
      { action: "notify", status: "ok" },
      { action: "add_tag", status: "ok", attempt: 2 },
      { action: "notify", status: "ok", attempt: 2 },
    ]);
    // the last step ran once, in the retry; the first one (already done) did not run again
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = $2", [org, last]))).toBe(1);
  });

  it("a retry ends when the event that started the run no longer holds (owner's answer 5)", async () => {
    const pipe = await asAdmin((q) =>
      one<{ p: string; open: string; won: string }>(
        q,
        `select p.id as p,
                (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'open' order by s.position limit 1) as open,
                (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'won' order by s.position limit 1) as won
           from public.pipelines p where p.organization_id = $1 and p.is_default`,
        [org],
      ),
    );
    const rule = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'עסקה נסגרה', 'deal', 'deal_won', $2) returning id",
          [org, JSON.stringify([{ type: "add_tag", tag_id: randomUUID() }])],
        )
      ).id,
    );
    const deal = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipe.p,
          pipe.won,
          owner.id,
        ])
      ).id,
    );
    const key = `event:aut06-won-${++n}`;
    await asAdmin((q) => q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [rule, deal, key]));
    const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.automation_runs where automation_id = $1 and run_key = $2", [rule, key])).id);
    expect((await runRow(id)).status).toBe("failed");
    // the deal is reopened before the retry
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [deal, pipe.open]));
    await due(id);
    await retryAll();
    expect(await runRow(id)).toMatchObject({ retry_count: 0, next_retry_at: null, retry_note: "event_changed" });
  });

  it("a read-only or closed business's retries are cancelled, not left waiting (owner's answer 6)", async () => {
    const rule = await makeRule(randomUUID());
    const lead = await insertLead(owner.id, org, { full_name: "ליד בעסק סגור" });
    const id = await run(rule, lead);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await due(id);
      await retryAll();
      expect(await runRow(id)).toMatchObject({ retry_count: 0, next_retry_at: null, retry_note: "org_closed" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a retry that raises still counts: after three the retries end with the note 'error'", async () => {
    const rule = await makeRule(randomUUID());
    const lead = await insertLead(owner.id, org, { full_name: "ליד עם שגיאה" });
    const id = await run(rule, lead);
    // a stored condition the matcher cannot compare ("1.2.3" passes its number pattern but is no number), written past the
    // triggers so the rule does not count as edited: app.retry_automation_run raises on it
    await raw("update public.automations set conditions = $2 where id = $1", [rule, JSON.stringify([{ field: "score", op: "gte", value: "1.2.3" }])]);
    const waits: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      await due(id);
      await retryAll();
      const r = await runRow(id);
      expect(r.retry_count).toBe(i + 1);
      waits.push(minutesAhead(r.next_retry_at));
    }
    expect(waits).toEqual([60, 360, null]);
    expect((await runRow(id)).retry_note).toBe("error");
    // nothing picks it again
    expect(await retryAll()).toBe(0);
    expect((await runRow(id)).retry_count).toBe(3);
  });

  it("retries end with a note when the rule is off or changed, the record is gone, or it no longer meets the conditions", async () => {
    const cases: Array<[string, (rule: string, lead: string) => Promise<unknown>]> = [
      ["rule_off", (rule) => asAdmin((q) => q("update public.automations set is_active = false where id = $1", [rule]))],
      ["rule_changed", (rule) => asAdmin((q) => q("update public.automations set name = 'שם חדש', updated_at = now() + interval '1 second' where id = $1", [rule]))],
      ["record_gone", (_rule, lead) => asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [lead]))],
      [
        "conditions",
        // the conditions change without the rule counting as edited (only the record no longer meeting them is tested)
        (rule) => raw("update public.automations set conditions = $2 where id = $1", [rule, JSON.stringify([{ field: "owner_id", op: "empty" }])]),
      ],
    ];
    for (const [note, change] of cases) {
      const rule = await makeRule(randomUUID());
      const lead = await insertLead(owner.id, org, { full_name: `ליד ${note}` });
      const id = await run(rule, lead);
      await change(rule, lead);
      await due(id);
      await retryAll();
      expect(await runRow(id), note).toMatchObject({ retry_count: 0, next_retry_at: null, retry_note: note });
    }
  });

  it("a manual test run is not retried, and a retry is not a counted run (AUT-07)", async () => {
    const rule = await makeRule(randomUUID());
    const lead = await insertLead(owner.id, org, { full_name: "ליד ידני" });
    await asUser(owner.id, (q) => q("select public.run_automation_now($1, $2)", [rule, lead]));
    const manual = await asAdmin((q) =>
      one<Run>(q, "select status, retry_count, next_retry_at, retry_note, steps from public.automation_runs where automation_id = $1 and run_key like 'manual:%'", [rule]),
    );
    expect(manual).toMatchObject({ status: "partial", next_retry_at: null });

    await asAdmin((q) => q("update public.subscriptions set limit_overrides = $2 where organization_id = $1", [org, JSON.stringify({ max_automation_runs_per_month: 1000 })]));
    const id = await run(rule, lead);
    const counted = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.automation_runs_this_month($1) as n", [org])).n);
    const before = await counted();
    await due(id);
    await retryAll();
    expect((await runRow(id)).retry_count).toBe(1);
    expect(await counted()).toBe(before);
  });

  it("the creator is told only while they are an active member who is neither owner nor admin; nobody can run the retry job", async () => {
    const rule = await makeRule(randomUUID());
    await setCreator(rule, admin.id);
    const lead = await insertLead(owner.id, org, { full_name: "ליד יוצר" });
    await run(rule, lead);
    const told = await asAdmin(async (q) =>
      (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 and type = 'automation_failed'", [rule])).rows.map((x) => x.user_id).sort(),
    );
    // an admin creator is told once, as an admin
    expect(told).toEqual([owner.id, admin.id].sort());
    for (const role of ["anon", "authenticated"]) {
      const ok = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_function_privilege($1, 'app.retry_automation_runs(integer)', 'execute') as ok", [role])).ok);
      expect(ok, role).toBe(false);
    }
  });
});

/**
 * The owner's answer ב of 25 October 2026: before a retry the event that started the run must still hold, for every trigger
 * type, judged on the facts the run saw (automation_runs.event_facts); when it does not, the retries end with the note
 * event_changed; a trigger type without a decision is never retried.
 */
describe("the event check before a retry, per trigger type (AUT-06, answer ב)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string;
  let openStages: string[];
  let wonStage: string, lostStage: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const own = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const insert = (sql: string, params: unknown[]) => own(async (q) => (await one<{ id: string }>(q, sql, params)).id);
  // a rule whose only step always fails (a tag that does not exist; a task has no tags at all), so every run waits for a retry
  const rule = (entity: string, trigger: string, config: Record<string, unknown> = {}) =>
    insert(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [org, `כלל ${++n}`, entity, trigger, JSON.stringify(config), JSON.stringify([{ type: "add_tag", tag_id: randomUUID() }])],
    );
  const execute = (auto: string, record: string, key: string) =>
    asAdmin(async (q) => {
      await q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [auto, record, key]);
      return (await one<{ id: string }>(q, "select id from public.automation_runs where automation_id = $1 and run_key = $2", [auto, key])).id;
    });
  const sqlText = (sql: string, params: unknown[]) => asAdmin(async (q) => (await one<{ v: string }>(q, sql, params)).v);
  const runRow = (id: string) =>
    asAdmin((q) => one<Run & { event_facts: unknown }>(q, "select status, retry_count, next_retry_at, retry_note, steps, event_facts from public.automation_runs where id = $1", [id]));
  const retryNow = async (id: string) => {
    await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [id]));
    await asAdmin((q) => q("select app.retry_automation_runs(500)"));
    return runRow(id);
  };
  // holds: the retry ran (one more attempt, the next one waiting); changed: no attempt, the note event_changed
  const expectRetried = async (id: string, label: string) => {
    const r = await retryNow(id);
    expect(r, label).toMatchObject({ retry_count: 1, retry_note: null });
    expect(r.next_retry_at, label).not.toBeNull();
  };
  const expectEventChanged = async (id: string, label: string) => {
    expect(await retryNow(id), label).toMatchObject({ retry_count: 0, next_retry_at: null, retry_note: "event_changed" });
  };
  const newDeal = (stage: string) =>
    insert("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, $2, $3, $4, $5) returning id", [
      org,
      `עסקה ${++n}`,
      pipelineId,
      stage,
      owner.id,
    ]);
  const newTask = (due: string | null = null) =>
    insert("insert into public.tasks (organization_id, title, owner_id, due_at) values ($1, $2, $3, $4) returning id", [org, `משימה ${++n}`, owner.id, due]);
  const newContact = (birth: string | null = null) =>
    insert("insert into public.contacts (organization_id, first_name, owner_id, birth_date) values ($1, $2, $3, $4) returning id", [org, `איש ${++n}`, owner.id, birth]);

  beforeAll(async () => {
    owner = await createUser("ae-owner");
    org = await createOrg(owner.id, "עסק בדיקת האירוע");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ payments: true })]));
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStages = pipe.stages.filter((s) => s.kind === "open").map((s) => s.id);
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    lostStage = pipe.stages.find((s) => s.kind === "lost")!.id;
  });

  it("created: holds while the record exists (its creation cannot be undone)", async () => {
    const auto = await rule("lead", "created");
    const lead = await insertLead(owner.id, org, { full_name: "ליד חדש" });
    const id = await execute(auto, lead, `event:ae-${++n}`);
    expect((await runRow(id)).event_facts).toEqual({});
    await expectRetried(id, "created");
  });

  it("deal_won and deal_lost: the deal is still won / lost", async () => {
    for (const [trigger, stage] of [
      ["deal_won", wonStage],
      ["deal_lost", lostStage],
    ] as const) {
      const auto = await rule("deal", trigger);
      const holds = await newDeal(stage);
      await expectRetried(await execute(auto, holds, `event:ae-${++n}`), `${trigger} holds`);
      const changed = await newDeal(stage);
      const id = await execute(auto, changed, `event:ae-${++n}`);
      await own((q) => q("update public.deals set stage_id = $2 where id = $1", [changed, openStages[0]]));
      await expectEventChanged(id, `${trigger} reopened`);
    }
  });

  it("task_completed: the task is still done", async () => {
    const auto = await rule("task", "task_completed");
    const holds = await newTask();
    await own((q) => q("update public.tasks set status = 'done' where id = $1", [holds]));
    await expectRetried(await execute(auto, holds, `event:ae-${++n}`), "task_completed holds");
    const changed = await newTask();
    await own((q) => q("update public.tasks set status = 'done' where id = $1", [changed]));
    const id = await execute(auto, changed, `event:ae-${++n}`);
    await own((q) => q("update public.tasks set status = 'open' where id = $1", [changed]));
    await expectEventChanged(id, "task_completed reopened");
  });

  it("field_changed: with a target value the field still has it; without one, the value the run saw", async () => {
    const other = await sqlText("select id::text as v from public.lead_statuses where organization_id = $1 and not is_default order by position limit 1", [org]);
    const first = await sqlText("select id::text as v from public.lead_statuses where organization_id = $1 and is_default", [org]);
    for (const config of [{ field: "status_id" }, { field: "status_id", to: first }]) {
      const label = config.to ? "with a value" : "without a value";
      const auto = await rule("lead", "field_changed", config);
      const holds = await insertLead(owner.id, org, { full_name: "ליד" });
      const id = await execute(auto, holds, `event:ae-${++n}`);
      expect((await runRow(id)).event_facts, label).toEqual({ value: first });
      await expectRetried(id, `${label} holds`);
      const changed = await insertLead(owner.id, org, { full_name: "ליד שהשתנה" });
      const id2 = await execute(auto, changed, `event:ae-${++n}`);
      await own((q) => q("update public.leads set status_id = $2 where id = $1", [changed, other]));
      await expectEventChanged(id2, `${label} changed`);
    }
  });

  it("no_activity: still no activity after the one the scan saw (an automation note does not count)", async () => {
    const auto = await rule("lead", "no_activity", { days: 3 });
    // the key the scan builds (app.scheduled_no_activity): the newest activity that is not an automation note, else creation
    const keyOf = (lead: string) =>
      sqlText(
        `select 'noact:' || t.id || ':' || coalesce((select max(a.occurred_at) from public.activities a where a.lead_id = t.id and a.type <> 'automation_note'), t.created_at) as v
           from public.leads t where t.id = $1`,
        [lead],
      );
    const holds = await insertLead(owner.id, org, { full_name: "ליד שקט" });
    const id = await execute(auto, holds, await keyOf(holds));
    // an automation's own note is not activity, by the scan's rule
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'automation_note', 'הערה', $2)", [org, holds]));
    await expectRetried(id, "no_activity holds");
    const changed = await insertLead(owner.id, org, { full_name: "ליד שדיברו איתו" });
    const id2 = await execute(auto, changed, await keyOf(changed));
    await own((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, changed]));
    await expectEventChanged(id2, "no_activity: a call was logged");
  });

  it("no_activity: the run's own timeline entries count as seen; only later activity ends the retries (delta review)", async () => {
    const status = await sqlText(
      "select id::text as v from public.lead_statuses where organization_id = $1 and not is_default and kind = 'open' order by position limit 1",
      [org],
    );
    // step 1 changes the status (a timeline entry), step 2 always fails
    const auto = await insert(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
       values ($1, $2, 'lead', 'no_activity', '{"days": 3}', $3) returning id`,
      [org, `כלל ${++n}`, JSON.stringify([{ type: "set_lead_status", status_id: status }, { type: "add_tag", tag_id: randomUUID() }])],
    );
    const keyOf = (lead: string) =>
      sqlText(
        `select 'noact:' || t.id || ':' || coalesce((select max(a.occurred_at) from public.activities a where a.lead_id = t.id and a.type <> 'automation_note'), t.created_at) as v
           from public.leads t where t.id = $1`,
        [lead],
      );
    const entries = (lead: string) => asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and type <> 'automation_note'", [lead]));
    const holds = await insertLead(owner.id, org, { full_name: "ליד שהאוטומציה עדכנה" });
    const before = await entries(holds);
    const id = await execute(auto, holds, await keyOf(holds));
    const r = await runRow(id);
    expect(r.status).toBe("partial");
    // the status step wrote a timeline entry, and the run still waits for its retry
    expect(await entries(holds)).toBeGreaterThan(before);
    expect(r.next_retry_at).not.toBeNull();
    await expectRetried(id, "no_activity with its own entry");

    const later = await insertLead(owner.id, org, { full_name: "ליד שהתקשרו אליו אחר כך" });
    const id2 = await execute(auto, later, await keyOf(later));
    await own((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, later]));
    await expectEventChanged(id2, "no_activity: a later call");
  });

  it("stuck_in_stage: the deal is still open, in the same stage it entered at the same time", async () => {
    const auto = await rule("deal", "stuck_in_stage", { days: 14 });
    const keyOf = (deal: string) => sqlText("select 'stuck:' || id || ':' || stage_entered_at as v from public.deals where id = $1", [deal]);
    const holds = await newDeal(openStages[0]);
    const id = await execute(auto, holds, await keyOf(holds));
    expect((await runRow(id)).event_facts).toMatchObject({ stage_id: openStages[0] });
    await expectRetried(id, "stuck holds");
    const moved = await newDeal(openStages[0]);
    const id2 = await execute(auto, moved, await keyOf(moved));
    await own((q) => q("update public.deals set stage_id = $2 where id = $1", [moved, openStages[1]]));
    await expectEventChanged(id2, "stuck: moved to another stage");
    const closed = await newDeal(openStages[0]);
    const id3 = await execute(auto, closed, await keyOf(closed));
    await own((q) => q("update public.deals set stage_id = $2 where id = $1", [closed, wonStage]));
    await expectEventChanged(id3, "stuck: won");
  });

  it("task_due_soon: the task is still open and its due time did not change", async () => {
    const auto = await rule("task", "task_due_soon", { minutes: 60 });
    const keyOf = (task: string) => sqlText("select 'due:' || id || ':' || due_at as v from public.tasks where id = $1", [task]);
    const soon = () => new Date(Date.now() + 30 * 60_000).toISOString();
    const holds = await newTask(soon());
    await expectRetried(await execute(auto, holds, await keyOf(holds)), "due holds");
    const moved = await newTask(soon());
    const id = await execute(auto, moved, await keyOf(moved));
    await own((q) => q("update public.tasks set due_at = due_at + interval '1 day' where id = $1", [moved]));
    await expectEventChanged(id, "due: moved");
    const done = await newTask(soon());
    const id2 = await execute(auto, done, await keyOf(done));
    await own((q) => q("update public.tasks set status = 'done' where id = $1", [done]));
    await expectEventChanged(id2, "due: done");
  });

  it("birthday: the contact's birth date did not change", async () => {
    const auto = await rule("contact", "birthday");
    const holds = await newContact("1990-05-17");
    const id = await execute(auto, holds, `bday:${holds}:2026`);
    expect((await runRow(id)).event_facts).toEqual({ birth_date: "1990-05-17" });
    await expectRetried(id, "birthday holds");
    const changed = await newContact("1990-05-17");
    const id2 = await execute(auto, changed, `bday:${changed}:2026`);
    await own((q) => q("update public.contacts set birth_date = '1990-06-17' where id = $1", [changed]));
    await expectEventChanged(id2, "birthday changed");
  });

  it("date_reached: the date (built-in or a custom field) is still the day the scan matched", async () => {
    // a built-in date: a task's due time, by its day in the business's zone
    const auto = await rule("task", "date_reached", { field: "due_at", days: 0, direction: "before" });
    const keyOf = (task: string) =>
      sqlText("select 'date:due_at:before:0:' || t.id || ':' || (t.due_at at time zone o.timezone)::date as v from public.tasks t join public.organizations o on o.id = t.organization_id where t.id = $1", [task]);
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const holds = await newTask(at);
    await expectRetried(await execute(auto, holds, await keyOf(holds)), "date holds");
    const moved = await newTask(at);
    const id = await execute(auto, moved, await keyOf(moved));
    await own((q) => q("update public.tasks set due_at = due_at + interval '2 days' where id = $1", [moved]));
    await expectEventChanged(id, "date moved");

    // a custom date field of a lead
    await own((q) => q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'renewal', 'חידוש', 'date')", [org]));
    const cfAuto = await rule("lead", "date_reached", { field: "cf:renewal", days: 0, direction: "after" });
    const cfHolds = await insertLead(owner.id, org, { full_name: "ליד עם תאריך", custom_fields: JSON.stringify({ renewal: "2026-11-01" }) });
    const cfId = await execute(cfAuto, cfHolds, `date:cf:renewal:after:0:${cfHolds}:2026-11-01`);
    expect((await runRow(cfId)).event_facts).toEqual({ day: "2026-11-01" });
    await expectRetried(cfId, "cf date holds");
    const cfMoved = await insertLead(owner.id, org, { full_name: "ליד שתאריכו זז", custom_fields: JSON.stringify({ renewal: "2026-11-01" }) });
    const cfId2 = await execute(cfAuto, cfMoved, `date:cf:renewal:after:0:${cfMoved}:2026-11-01`);
    await own((q) => q("update public.leads set custom_fields = $2 where id = $1", [cfMoved, JSON.stringify({ $merge: { renewal: "2026-12-01" } })]));
    await expectEventChanged(cfId2, "cf date moved");
  });

  it("payment_received: the payment was not cancelled, failed or refunded", async () => {
    const auto = await rule("deal", "payment_received");
    const payOn = async (deal: string) => {
      const payment = await insert("insert into public.payments (organization_id, deal_id, amount_agorot, method) values ($1, $2, 5000, 'cash') returning id", [org, deal]);
      const event = await sqlText(
        "select id::text as v from public.outbox_events where organization_id = $1 and event_type = 'payment_received' and entity_id = $2 and payload ->> 'payment_id' = $3",
        [org, deal, payment],
      );
      return { payment, key: `event:${event}` };
    };
    const holdsDeal = await newDeal(openStages[0]);
    const holds = await payOn(holdsDeal);
    const id = await execute(auto, holdsDeal, holds.key);
    expect((await runRow(id)).event_facts).toEqual({ payment_id: holds.payment });
    await expectRetried(id, "payment holds");
    for (const set of ["status = 'failed'", "status = 'refunded'", "status = 'cancelled', cancel_reason = 'בוטל'"]) {
      const deal = await newDeal(openStages[0]);
      const p = await payOn(deal);
      const pid = await execute(auto, deal, p.key);
      await own((q) => q(`update public.payments set ${set} where id = $1`, [p.payment]));
      await expectEventChanged(pid, `payment: ${set}`);
    }
  });

  it("payment_confirmed: the payment is still confirmed (PAY-07 answer 3)", async () => {
    const auto = await rule("contact", "payment_confirmed");
    const confirmOn = async (contact: string) => {
      const payment = await insert("insert into public.payments (organization_id, contact_id, amount_agorot, method, status) values ($1, $2, 5000, 'cash', 'confirmed') returning id", [
        org,
        contact,
      ]);
      const event = await sqlText(
        "select id::text as v from public.outbox_events where organization_id = $1 and event_type = 'payment_confirmed' and entity_id = $2 and payload ->> 'payment_id' = $3",
        [org, contact, payment],
      );
      return { payment, key: `event:${event}` };
    };
    const holdsContact = await newContact();
    const holds = await confirmOn(holdsContact);
    const id = await execute(auto, holdsContact, holds.key);
    expect((await runRow(id)).event_facts).toEqual({ payment_id: holds.payment });
    await expectRetried(id, "payment_confirmed holds");
    // moved back to recorded: the confirmation no longer holds
    const contact = await newContact();
    const p = await confirmOn(contact);
    const id2 = await execute(auto, contact, p.key);
    await own((q) => q("update public.payments set status = 'recorded' where id = $1", [p.payment]));
    await expectEventChanged(id2, "payment_confirmed moved back");
  });

  it("a trigger type without a decision keeps no facts and is never retried", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד לסוג לא מוכר" });
    const facts = await asAdmin((q) =>
      one<{ f: unknown }>(q, "select app.automation_run_facts('form_submitted', '{}', 'lead', $1, $2, 'event:1') as f", [org, lead]),
    );
    expect(facts.f).toBeNull();
    const holds = await asAdmin((q) =>
      one<{ h: boolean }>(
        q,
        "select app.automation_event_still_holds('form_submitted', '{}', 'lead', $1, $2, (select to_jsonb(l) from public.leads l where l.id = $2), '{}') as h",
        [org, lead],
      ),
    );
    expect(holds.h).toBe(false);
    // and a run whose facts could not be read (a key the type does not know) waits for no retry
    const auto = await rule("contact", "birthday");
    const contact = await newContact(null);
    const id = await execute(auto, contact, `bday:${contact}:2026`);
    expect(await runRow(id)).toMatchObject({ status: "failed", next_retry_at: null, event_facts: null });
  });

  it("every trigger type the builder or the database knows has a decision in both the facts and the check", async () => {
    const defs = await asAdmin((q) =>
      one<{ facts: string; check: string; types: string }>(
        q,
        `select pg_get_functiondef('app.automation_run_facts(text, jsonb, text, uuid, uuid, text)'::regprocedure) as facts,
                pg_get_functiondef('app.automation_event_still_holds(text, jsonb, text, uuid, uuid, jsonb, jsonb)'::regprocedure) as check,
                pg_get_constraintdef(c.oid) as types
           from pg_constraint c where c.conname = 'automations_trigger_type_check'`,
      ),
    );
    const decided = (body: string) =>
      new Set(
        body
          .split("\n")
          .filter((line) => /^\s*when\s+'/.test(line))
          .flatMap((line) => [...line.replace(/\sthen.*$/, "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])),
      );
    const known = new Set([...TRIGGERS.map((t) => t.type), ...[...defs.types.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])]);
    expect(known.size).toBeGreaterThanOrEqual(11);
    for (const [name, body] of [
      ["facts", defs.facts],
      ["check", defs.check],
    ] as const) {
      const has = decided(body);
      const missing = [...known].filter((t) => !has.has(t));
      expect(missing, `${name}: trigger types without a decision`).toEqual([]);
    }
  });
});
