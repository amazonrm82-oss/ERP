import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Case = { name: string; conditions: unknown; records: unknown; ctx: unknown; expected: boolean | "error" };

const CASES = JSON.parse(readFileSync("tests/unit/fixtures/automation-conditions.json", "utf8")) as Case[];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * AUT-05: automation conditions with "or" groups, a condition on a linked record, working hours and the weekday. The SQL
 * rule runs the cases the TS mirror runs (one fixture file); the engine reads only the linked records the conditions name,
 * in the record's own business; hours follow app.member_in_hours (the owner's, else the business's), the weekday the
 * business's zone; a person's write is refused when its shape is unknown.
 */
describe("automation conditions (AUT-05)", () => {
  let owner: U, rep: U;
  let org: string, otherOrg: string;
  let pipelineId: string, openStage: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const own = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const insert = (sql: string, params: unknown[]) => own(async (q) => (await one<{ id: string }>(q, sql, params)).id);
  // a rule nobody else runs (inactive), whose step always works
  const rule = (entity: string, conditions: unknown) =>
    insert(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, conditions, actions, is_active)
       values ($1, $2, $3, 'created', $4, $5, false) returning id`,
      [org, `כלל ${++n}`, entity, JSON.stringify(conditions), JSON.stringify([{ type: "notify", to: "owner", title: `תנאים ${n}` }])],
    );
  // whether the rule ran on the record (null = its conditions did not hold)
  const runs = (auto: string, record: string) =>
    asAdmin(async (q) =>
      (await one<{ r: string | null }>(q, "select app.execute_automation(a, $2, $3) as r from public.automations a where a.id = $1", [auto, record, `event:aut05-${++n}`])).r,
    );
  const holds = async (auto: string, record: string) => (await runs(auto, record)) !== null;
  const contact = async (fields: { owner?: null; tags?: string[] } = {}) => {
    const id = await insert("insert into public.contacts (organization_id, first_name, owner_id, tag_ids) values ($1, $2, $3, $4) returning id", [
      org,
      `איש ${++n}`,
      owner.id,
      fields.tags ?? [],
    ]);
    // a person's insert always gets an owner; "no owner" is written as stored data
    if (fields.owner === null) await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [id]));
    return id;
  };
  const company = () => insert("insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, `חברה ${++n}`, owner.id]);
  const deal = (contactId: string | null, companyId: string | null = null, ownerId: string | null = owner.id) =>
    insert(
      "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id, company_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [org, `עסקה ${++n}`, pipelineId, openStage, ownerId, contactId, companyId],
    );
  const tag = (name: string) => insert("insert into public.tags (organization_id, name) values ($1, $2) returning id", [org, name]);
  const setCalendar = (hours: Record<string, unknown> | null) =>
    own((q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false,
           rest_occasions = '{}', working_hours = excluded.working_hours`,
        [org, hours === null ? null : JSON.stringify(hours)],
      ),
    );
  const setProfile = (user: U, hours: Record<string, unknown> | null) =>
    asAdmin((q) => q("update public.profiles set working_hours = $2, timezone = null where id = $1", [user.id, hours === null ? null : JSON.stringify(hours)]));
  const today = () =>
    asAdmin(async (q) => (await one<{ d: number }>(q, "select extract(dow from now() at time zone o.timezone)::int as d from public.organizations o where o.id = $1", [org])).d);
  const allDay = (days: number[]) => Object.fromEntries(days.map((d) => [DAYS[d], [{ start: "00:00", end: "23:59" }]]));

  beforeAll(async () => {
    owner = await createUser("ac-owner");
    org = await createOrg(owner.id, "עסק התנאים");
    rep = await addMember(org, owner.id, "member", "ac-rep");
    const otherOwner = await createUser("ac-other");
    otherOrg = await createOrg(otherOwner.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("the SQL rule gives what the TS mirror gives, case by case (shared fixture)", async () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    for (const c of CASES) {
      const result = await asAdmin(async (q) => {
        try {
          return (await one<{ r: boolean }>(q, "select app.automation_condition_tree($1::jsonb, $2::jsonb, $3::jsonb) as r", [
            JSON.stringify(c.conditions),
            JSON.stringify(c.records),
            JSON.stringify(c.ctx),
          ])).r;
        } catch {
          return "error" as const;
        }
      });
      expect(result, c.name).toBe(c.expected);
    }
  });

  it("old rules are judged as before, and an \"or\" group holds when one of its items does", async () => {
    const vip = await tag("VIP");
    const old = await rule("contact", [{ field: "tag_ids", op: "has_tag", value: vip }]);
    expect(await holds(old, await contact({ tags: [vip] }))).toBe(true);
    expect(await holds(old, await contact())).toBe(false);

    const either = await rule("contact", [{ any: [{ field: "tag_ids", op: "has_tag", value: vip }, { field: "owner_id", op: "empty" }] }]);
    expect(await holds(either, await contact({ tags: [vip] }))).toBe(true);
    expect(await holds(either, await contact({ owner: null }))).toBe(true);
    expect(await holds(either, await contact())).toBe(false);
  });

  it("a condition on a linked record: a deal on its contact and company, a task on its deal", async () => {
    const vip = await tag("לקוח חשוב");
    const onContact = await rule("deal", [{ on: "contact", field: "tag_ids", op: "has_tag", value: vip }]);
    expect(await holds(onContact, await deal(await contact({ tags: [vip] })))).toBe(true);
    expect(await holds(onContact, await deal(await contact()))).toBe(false);
    // no contact, or a contact in the recycle bin: the condition does not hold, an "is empty" one neither (lead's choice (א))
    expect(await holds(onContact, await deal(null))).toBe(false);
    const binned = await contact({ tags: [vip] });
    const binnedDeal = await deal(binned);
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect(await holds(onContact, binnedDeal)).toBe(false);
    const contactNoOwner = await rule("deal", [{ on: "contact", field: "owner_id", op: "empty" }]);
    expect(await holds(contactNoOwner, await deal(null))).toBe(false);
    expect(await holds(contactNoOwner, await deal(await contact({ owner: null })))).toBe(true);

    const onCompany = await rule("deal", [{ on: "company", field: "owner_id", op: "not_empty" }]);
    expect(await holds(onCompany, await deal(null, await company()))).toBe(true);
    expect(await holds(onCompany, await deal(null, null))).toBe(false);

    const onDeal = await rule("task", [{ on: "deal", field: "pipeline_id", op: "eq", value: pipelineId }]);
    const linked = await insert("insert into public.tasks (organization_id, title, owner_id, deal_id) values ($1, 'משימה', $2, $3) returning id", [
      org,
      owner.id,
      await deal(null),
    ]);
    expect(await holds(onDeal, linked)).toBe(true);
    const lone = await insert("insert into public.tasks (organization_id, title, owner_id) values ($1, 'משימה בודדת', $2) returning id", [org, owner.id]);
    expect(await holds(onDeal, lone)).toBe(false);
  });

  it("a linked read never reaches another business", async () => {
    // a record whose link names a row of another business (the composite keys forbid it in real rows; built here by hand)
    const foreign = await asUser(
      (await asAdmin(async (q) => (await one<{ user_id: string }>(q, "select user_id from public.memberships where organization_id = $1 and role = 'owner'", [otherOrg])).user_id)) as string,
      async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, tag_ids) values ($1, 'זר', '{}') returning id", [otherOrg])).id,
    );
    const r = await asAdmin(async (q) =>
      (
        await one<{ r: boolean }>(q, "select app.automation_conditions_match($1::jsonb, $2::jsonb) as r", [
          JSON.stringify({ organization_id: org, id: "00000000-0000-4000-8000-000000000001", contact_id: foreign }),
          JSON.stringify([{ on: "contact", field: "first_name", op: "eq", value: "זר" }]),
        ])
      ).r,
    );
    expect(r).toBe(false);
    // the same record in its own business is found
    const own_ = await asAdmin(async (q) =>
      (
        await one<{ r: boolean }>(q, "select app.automation_conditions_match($1::jsonb, $2::jsonb) as r", [
          JSON.stringify({ organization_id: otherOrg, id: "00000000-0000-4000-8000-000000000001", contact_id: foreign }),
          JSON.stringify([{ on: "contact", field: "first_name", op: "eq", value: "זר" }]),
        ])
      ).r,
    );
    expect(own_).toBe(true);
  });

  it("working hours: the owner's own hours, else the business's; no hours anywhere = always within; no owner = the business's", async () => {
    const d = await today();
    const other = (d + 3) % 7;
    const inHours = await rule("lead", [{ kind: "hours", value: "in" }]);
    const outHours = await rule("lead", [{ kind: "hours", value: "out" }]);
    const lead = await insertLead(owner.id, org, { full_name: "ליד שעות", owner_id: rep.id });
    const ownerless = await insertLead(owner.id, org, { full_name: "ליד בלי אחראי", owner_id: null });
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [ownerless]));

    // nothing set: no limit
    await setCalendar(null);
    await setProfile(rep, null);
    expect([await holds(inHours, lead), await holds(outHours, lead), await holds(inHours, ownerless)]).toEqual([true, false, true]);

    // the business works today, the rep's own hours do not include today: the rep's hours decide
    await setCalendar(allDay([d]));
    await setProfile(rep, allDay([other]));
    expect([await holds(inHours, lead), await holds(outHours, lead)]).toEqual([false, true]);
    // no owner: the business's hours
    expect(await holds(inHours, ownerless)).toBe(true);

    // the rep has no hours of their own: the business's
    await setProfile(rep, null);
    expect(await holds(inHours, lead)).toBe(true);
    await setCalendar(allDay([other]));
    expect([await holds(inHours, lead), await holds(inHours, ownerless), await holds(outHours, ownerless)]).toEqual([false, false, true]);

    // a rest day is outside the hours (CAP-03 settings)
    await setCalendar(allDay([0, 1, 2, 3, 4, 5, 6]));
    await own((q) => q("update public.org_calendar_settings set rest_weekdays = $2 where organization_id = $1", [org, [d]]));
    expect(await holds(inHours, ownerless)).toBe(false);
    await own((q) => q("update public.org_calendar_settings set rest_weekdays = '{}' where organization_id = $1", [org]));
    expect(await holds(inHours, ownerless)).toBe(true);

    // the owner on leave today is outside the hours (lead's choice (א), as app.member_in_hours)
    await asAdmin((q) =>
      q(
        "insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date - 1, (now() at time zone 'Asia/Jerusalem')::date + 1)",
        [org, rep.id],
      ),
    );
    expect([await holds(inHours, lead), await holds(outHours, lead)]).toEqual([false, true]);
    await setCalendar(null);
  });

  it("the weekday is counted in the business's time zone", async () => {
    const d = await today();
    const lead = await insertLead(owner.id, org, { full_name: "ליד יום" });
    expect(await holds(await rule("lead", [{ kind: "weekday", days: [d] }]), lead)).toBe(true);
    expect(await holds(await rule("lead", [{ kind: "weekday", days: [(d + 1) % 7, (d + 2) % 7] }]), lead)).toBe(false);
    // the same moment in a zone 14 hours away can be another day; the rule follows the business's zone
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Kiritimati' where id = $1", [org]));
    try {
      const there = await today();
      expect(await holds(await rule("lead", [{ kind: "weekday", days: [there] }]), lead)).toBe(true);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("a person may save only shapes the engine knows; a stored unknown shape does not hold and never raises", async () => {
    const bad = [
      { field: "a", op: "like", value: "x" },
      { on: "order", field: "a", op: "eq", value: "x" },
      { any: [{ field: "a", op: "eq", value: "1" }] },
      { any: [{ any: [] }, { field: "a", op: "eq", value: "1" }] },
      { kind: "hours", value: "maybe" },
      { kind: "weekday", days: [7] },
      { kind: "weekday", days: [1, 1] },
      { kind: "weekday", days: [] },
      { kind: "moon" },
      "source_id",
      // a number comparison needs a number (review low 1); a value is text
      { field: "amount_agorot", op: "gte", value: "abc" },
      { field: "amount_agorot", op: "lte", value: "1.2.3" },
      { field: "amount_agorot", op: "gte" },
      { field: "amount_agorot", op: "gte", value: 5 },
      { field: "source_id", op: "eq", value: 1.0 },
    ];
    for (const item of bad) {
      const err = await own((q) =>
        q("insert into public.automations (organization_id, name, entity_type, trigger_type, conditions, actions, is_active) values ($1, 'רע', 'lead', 'created', $2, $3, false)", [
          org,
          JSON.stringify([item]),
          JSON.stringify([{ type: "notify", to: "owner", title: "x" }]),
        ]),
      ).catch((e: { hint?: string }) => e);
      expect((err as { hint?: string }).hint, JSON.stringify(item)).toBe("automation:conditions");
    }
    // too many items, too many leaves
    const leaf = { field: "owner_id", op: "empty" };
    for (const conditions of [Array(11).fill(leaf), Array(3).fill({ any: Array(10).fill(leaf) })]) {
      const err = await own((q) =>
        q("insert into public.automations (organization_id, name, entity_type, trigger_type, conditions, actions, is_active) values ($1, 'רע', 'lead', 'created', $2, $3, false)", [
          org,
          JSON.stringify(conditions),
          JSON.stringify([{ type: "notify", to: "owner", title: "x" }]),
        ]),
      ).catch((e: { hint?: string }) => e);
      expect((err as { hint?: string }).hint).toBe("automation:conditions");
    }
    // a good shape with every kind is saved
    const good = await rule("deal", [
      { field: "owner_id", op: "not_empty" },
      { field: "amount_agorot", op: "gte", value: "-100000.50" },
      { any: [{ on: "contact", field: "owner_id", op: "empty" }, { on: "company", field: "tag_ids", op: "has_tag", value: "x" }, { kind: "hours", value: "in" }] },
      { kind: "weekday", days: [0, 1, 2, 3, 4, 5, 6] },
    ]);
    expect(good).toBeTruthy();
    // a stored unknown item (a server write, past the check): the rule does not run, nothing raises
    const stored = await rule("lead", []);
    await asAdmin((q) => q("update public.automations set conditions = $2 where id = $1", [stored, JSON.stringify([{ kind: "moon" }])]));
    expect(await holds(stored, await insertLead(owner.id, org, { full_name: "ליד ירח" }))).toBe(false);
    // renaming a rule with old conditions is not re-checked
    await own((q) => q("update public.automations set name = 'שם חדש' where id = $1", [stored]));
  });

  it("an AUT-06 retry judges the conditions again, at retry time", async () => {
    const auto = await insert(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, conditions, actions, is_active)
       values ($1, 'ניסיון חוזר', 'deal', 'created', $2, $3, true) returning id`,
      [org, JSON.stringify([{ on: "contact", field: "owner_id", op: "not_empty" }]), JSON.stringify([{ type: "add_tag", tag_id: "00000000-0000-4000-8000-0000000000aa" }])],
    );
    const c = await contact();
    const d = await deal(c);
    const key = `event:aut05-retry-${++n}`;
    await asAdmin((q) => q("select app.execute_automation(a, $2, $3) from public.automations a where a.id = $1", [auto, d, key]));
    const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.automation_runs where automation_id = $1 and run_key = $2", [auto, key])).id);
    // the contact loses its owner before the retry: the linked condition no longer holds
    await own((q) => q("update public.contacts set owner_id = null where id = $1", [c]));
    await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [id]));
    await asAdmin((q) => q("select app.retry_automation_runs(500)"));
    const r = await asAdmin((q) => one<{ retry_note: string | null; retry_count: number }>(q, "select retry_note, retry_count from public.automation_runs where id = $1", [id]));
    expect(r).toEqual({ retry_note: "conditions", retry_count: 0 });
    await own((q) => q("update public.automations set is_active = false where id = $1", [auto]));
  });

  it("the new functions are internal: no role may run them", async () => {
    for (const fn of [
      "app.automation_condition_tree(jsonb, jsonb, jsonb)",
      "app.automation_conditions_match(jsonb, jsonb)",
      "app.automation_org_in_hours(uuid, timestamptz)",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const ok = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok);
        expect(ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
