import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

// AUT-03: "X days before or after a date" triggers ('date_reached'), run by app.run_date_automations() (pg_cron
// crm-date-automations): once per record and date, on the day in the business's time zone, from the trigger hour.
describe("automations on a date (AUT-03)", () => {
  let owner: U, stranger: U;
  let org: string, otherOrg: string, pipeline: string, openStage: string, wonStage: string, status: string;

  // the business's today, as the engine sees it
  const today = async () =>
    asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone 'Asia/Jerusalem')::date, 'YYYY-MM-DD') as d")).rows[0].d);
  const day = async (offset: number) =>
    asAdmin(async (q) =>
      (await q<{ d: string }>("select to_char((now() at time zone 'Asia/Jerusalem')::date + $1::int, 'YYYY-MM-DD') as d", [offset])).rows[0].d,
    );
  // runs the date rules with the trigger hour at 0 (any time of day); returns how many ran
  const runDates = (extra: (q: Query) => Promise<unknown> = async () => undefined) =>
    asAdmin(async (q) => {
      await q("select set_config('app.date_trigger_hour', '0', true)");
      await extra(q);
      return (await q<{ n: number }>("select app.run_date_automations() as n")).rows[0].n;
    });
  const rule = (entity: string, config: Record<string, unknown>, extra: { conditions?: unknown[]; active?: boolean; o?: string; who?: U } = {}) =>
    asUser((extra.who ?? owner).id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'תאריך', $2, 'date_reached', $3, $4, '[{"type": "notify", "to": "admins", "title": "הגיע התאריך: {{name}}"}]', $5)
           returning id`,
          [extra.o ?? org, entity, JSON.stringify(config), JSON.stringify(extra.conditions ?? []), extra.active ?? true],
        )
      ).rows[0].id,
    );
  const runsOf = (ruleId: string) =>
    asAdmin(async (q) => (await q<{ entity_id: string }>("select entity_id from public.automation_runs where automation_id = $1 order by entity_id", [ruleId])).rows.map((r) => r.entity_id));
  const off = (ruleId: string) => asAdmin((q) => q("update public.automations set is_active = false where id = $1", [ruleId]));
  const lead = (name: string, createdDaysAgo: number) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.leads (organization_id, full_name, owner_id, status_id, created_at) values ($1, $2, $3, $4, now() - make_interval(days => $5)) returning id",
          [org, name, owner.id, status, createdDaysAgo],
        )
      ).rows[0].id,
    );
  const deal = (name: string, fields: Record<string, unknown>) =>
    asAdmin(async (q) => {
      const row: Record<string, unknown> = { organization_id: org, name, pipeline_id: pipeline, stage_id: openStage, owner_id: owner.id, ...fields };
      const cols = Object.keys(row);
      return (await q<{ id: string }>(`insert into public.deals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).rows[0].id;
    });

  beforeAll(async () => {
    owner = await createUser("adt-owner");
    org = await createOrg(owner.id, "עסק תאריכים");
    stranger = await createUser("adt-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id in ($1, $2)", [org, otherOrg]));
    const main = await defaultPipeline(org);
    pipeline = main.pipelineId;
    openStage = main.stages.find((s) => s.kind === "open")!.id;
    wonStage = main.stages.find((s) => s.kind === "won")!.id;
    status = await defaultLeadStatus(org);
  });

  it("runs on the day the date plus the days is today, once per record and date; converted and binned leads never", async () => {
    const r = await rule("lead", { field: "created_at", days: 3, direction: "after" });
    const due = await lead("לפני שלושה ימים", 3);
    const early = await lead("לפני יומיים", 2);
    const converted = await lead("הומר", 3);
    const binned = await lead("במחזור", 3);
    await asAdmin((q) => q("update public.leads set converted_at = now() where id = $1", [converted]));
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    await runDates();
    expect(await runsOf(r)).toEqual([due]);
    expect(early).not.toBe(due);
    // the same date never runs twice
    await runDates();
    expect(await runsOf(r)).toEqual([due]);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title like 'הגיע התאריך: לפני שלושה ימים'", [org]))).toBe(1);
    await off(r);
  });

  it("before a deal's renewal and its expected close date; the close date only while the deal is open", async () => {
    const renewal = await rule("deal", { field: "renewal_date", days: 30, direction: "before" });
    const closing = await rule("deal", { field: "expected_close_date", days: 3, direction: "before" });
    const start = await day(-400);
    const renewWon = await deal("חידוש", {
      stage_id: wonStage,
      billing_kind: "yearly",
      recurring_amount_agorot: 100000,
      recurring_start_date: start,
      renewal_date: await day(30),
    });
    const renewLater = await deal("חידוש מאוחר", { billing_kind: "yearly", recurring_amount_agorot: 1, recurring_start_date: start, renewal_date: await day(31) });
    const closeOpen = await deal("נסגרת", { expected_close_date: await day(3) });
    const closeWon = await deal("כבר נסגרה", { expected_close_date: await day(3), stage_id: wonStage });
    await runDates();
    expect(await runsOf(renewal)).toEqual([renewWon]);
    expect(await runsOf(closing)).toEqual([closeOpen]);
    expect([renewLater, closeWon]).toHaveLength(2);
    await off(renewal);
    await off(closing);
  });

  it("custom date and date-and-time fields, by the business's day; a value that is not a date is skipped", async () => {
    await asAdmin((q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type) values
           ($1, 'contact', 'visit', 'ביקור', 'date'), ($1, 'contact', 'call_at', 'שיחה', 'datetime'), ($1, 'contact', 'note', 'הערה', 'text')`,
        [org],
      ),
    );
    const contact = (name: string, custom: Record<string, unknown>) =>
      asAdmin(async (q) =>
        (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, custom_fields) values ($1, $2, $3, $4) returning id", [org, name, owner.id, JSON.stringify(custom)])).rows[0].id,
      );
    const visit = await rule("contact", { field: "cf:visit", days: 0, direction: "after" });
    const calls = await rule("contact", { field: "cf:call_at", days: 1, direction: "before" });
    const text = await rule("contact", { field: "cf:note", days: 0, direction: "after" });
    const visitToday = await contact("ביקור היום", { visit: await today() });
    await contact("ביקור מחר", { visit: await day(1) });
    // 00:30 tomorrow in Israel is still today in UTC: the day counts in the business's zone
    const tomorrowEarly = await asAdmin(async (q) =>
      (await q<{ t: string }>("select (((now() at time zone 'Asia/Jerusalem')::date + 1) + time '00:30') at time zone 'Asia/Jerusalem' as t")).rows[0].t,
    );
    const callTomorrow = await contact("שיחה מחר", { call_at: new Date(tomorrowEarly).toISOString() });
    await contact("ערך שבור", { call_at: "not a date", visit: "2026-02-31" });
    // a text field holding today's date is still not a date field
    await contact("טקסט שנראה כמו תאריך", { note: await today() });
    await runDates();
    expect(await runsOf(visit)).toEqual([visitToday]);
    expect(await runsOf(calls)).toEqual([callTomorrow]);
    // a field that is not a date never runs
    expect(await runsOf(text)).toEqual([]);
    for (const r of [visit, calls, text]) await off(r);
  });

  it("a task's due date runs only while the task is open", async () => {
    const r = await rule("task", { field: "due_at", days: 1, direction: "before" });
    const task = (title: string, status: string) =>
      asAdmin(async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.tasks (organization_id, title, owner_id, status, due_at) values ($1, $2, $3, $4, (((now() at time zone 'Asia/Jerusalem')::date + 1) + time '10:00') at time zone 'Asia/Jerusalem') returning id",
            [org, title, owner.id, status],
          )
        ).rows[0].id,
      );
    const open = await task("משימת מועד פתוחה", "open");
    await task("משימת מועד שבוצעה", "done");
    await runDates();
    expect(await runsOf(r)).toEqual([open]);
    await off(r);
  });

  it("conditions apply; inactive rules, other businesses and read-only businesses do not run", async () => {
    const tag = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'חם') returning id", [org])).rows[0].id);
    const withTag = await rule("lead", { field: "created_at", days: 5, direction: "after" }, { conditions: [{ field: "tag_ids", op: "has_tag", value: tag }] });
    const inactive = await rule("lead", { field: "created_at", days: 5, direction: "after" }, { active: false });
    const foreign = await rule("lead", { field: "created_at", days: 5, direction: "after" }, { o: otherOrg, who: stranger });
    const tagged = await lead("מתויג", 5);
    await lead("לא מתויג", 5);
    await asAdmin((q) => q("update public.leads set tag_ids = array[$2::uuid] where id = $1", [tagged, tag]));
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await runDates();
      expect(await runsOf(withTag)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await runDates();
    expect(await runsOf(withTag)).toEqual([tagged]);
    expect(await runsOf(inactive)).toEqual([]);
    // the other business's rule never reaches this business's leads
    expect(await runsOf(foreign)).toEqual([]);
    for (const r of [withTag, inactive, foreign]) await off(r);
  });

  it("waits for the trigger hour in the business's zone", async () => {
    const hour = await asAdmin(async (q) => (await q<{ h: number }>("select extract(hour from now() at time zone 'Asia/Jerusalem')::int as h")).rows[0].h);
    const r = await rule("lead", { field: "created_at", days: 6, direction: "after" });
    const due = await lead("שעה", 6);
    if (hour < 23) {
      await runDates((q) => q("select set_config('app.date_trigger_hour', $1, true)", [String(hour + 1)]));
      expect(await runsOf(r)).toEqual([]);
    }
    await runDates((q) => q("select set_config('app.date_trigger_hour', $1, true)", [String(hour)]));
    expect(await runsOf(r)).toEqual([due]);
    // the default hour is 8, and a bad setting falls back to it
    expect(await asAdmin(async (q) => (await q<{ h: number }>("select app.date_trigger_hour() as h")).rows[0].h)).toBe(8);
    expect(await asAdmin(async (q) => (await q("select set_config('app.date_trigger_hour', '99', true)"), (await q<{ h: number }>("select app.date_trigger_hour() as h")).rows[0].h))).toBe(8);
    await off(r);
  });

  it("goes on from its cursor when the scan limit cuts a run", async () => {
    const r = await rule("lead", { field: "created_at", days: 7, direction: "after" });
    const ids = [await lead("א", 7), await lead("ב", 7), await lead("ג", 7)].sort();
    await runDates((q) => q("select set_config('app.scheduled_scan_limit', '2', true)"));
    expect(await runsOf(r)).toHaveLength(2);
    await runDates((q) => q("select set_config('app.scheduled_scan_limit', '2', true)"));
    expect(await runsOf(r)).toEqual(ids);
    await off(r);

    // records that fail the conditions are passed over, not scanned again from the start
    const tag = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'סמן') returning id", [org])).rows[0].id);
    const tagged = await rule("lead", { field: "created_at", days: 8, direction: "after" }, { conditions: [{ field: "tag_ids", op: "has_tag", value: tag }] });
    const three = [await lead("ד", 8), await lead("ה", 8), await lead("ו", 8)].sort();
    await asAdmin((q) => q("update public.leads set tag_ids = array[$2::uuid] where id = $1", [three[2], tag]));
    await runDates((q) => q("select set_config('app.scheduled_scan_limit', '2', true)"));
    expect(await runsOf(tagged)).toEqual([]);
    await runDates((q) => q("select set_config('app.scheduled_scan_limit', '2', true)"));
    expect(await runsOf(tagged)).toEqual([three[2]]);
    await off(tagged);
  });

  // a lead with a chosen id, so a test can put it first or last in the scan (ids are scanned in order)
  const leadWithId = (o: string, id: string, name: string, createdDaysAgo: number, statusId: string, ownerId: string) =>
    asAdmin((q) =>
      q(
        "insert into public.leads (id, organization_id, full_name, owner_id, status_id, created_at) values ($1, $2, $3, $4, $5, now() - make_interval(days => $6))",
        [id, o, name, ownerId, statusId, createdDaysAgo],
      ),
    );

  it("another business's records and records in the bin are never scanned, so they take no place in the scan limit", async () => {
    const r = await rule("lead", { field: "created_at", days: 9, direction: "after" });
    const otherStatus = await defaultLeadStatus(otherOrg);
    // first in id order: a matching lead of another business and one of ours in the bin
    await leadWithId(otherOrg, "00000000-0000-4000-8000-000000000901", "של עסק אחר", 9, otherStatus, stranger.id);
    await leadWithId(org, "00000000-0000-4000-8000-000000000902", "במחזור", 9, status, owner.id);
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", ["00000000-0000-4000-8000-000000000902"]));
    const ours = "ffffffff-ffff-4fff-8fff-000000000903";
    await leadWithId(org, ours, "שלנו", 9, status, owner.id);
    // one record per run: ours is the first the scan may take
    await runDates((q) => q("select set_config('app.scheduled_scan_limit', '1', true)"));
    expect(await runsOf(r)).toEqual([ours]);
    await off(r);
  });

  it("a date that moves to a new day runs again; the same date never runs twice", async () => {
    // a business of its own whose time zone the test moves: today there is a different day in each zone
    const o = await createOrg(owner.id, "עסק שזז");
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Pago_Pago' where id = $1", [o]));
    await asAdmin((q) => q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'contact', 'visit', 'ביקור', 'date')", [o]));
    const r = await rule("contact", { field: "cf:visit", days: 0, direction: "after" }, { o });
    const localToday = (zone: string) =>
      asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d", [zone])).rows[0].d);
    const first = await localToday("Pacific/Pago_Pago");
    const c = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, custom_fields) values ($1, 'זזה', $2, $3) returning id", [o, owner.id, JSON.stringify({ visit: first })])).rows[0].id,
    );
    const runs = () => asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [r, c]));
    await runDates();
    expect(await runs()).toBe(1);
    await runDates();
    expect(await runs()).toBe(1);
    // a day later there (the business moves 25 hours ahead), the visit moved to that day: a new occasion
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Kiritimati' where id = $1", [o]));
    const second = await localToday("Pacific/Kiritimati");
    expect(second > first).toBe(true);
    await asAdmin((q) => q("update public.contacts set custom_fields = $2 where id = $1", [c, JSON.stringify({ visit: second })]));
    await runDates();
    expect(await runs()).toBe(2);
    await runDates();
    expect(await runs()).toBe(2);
    await off(r);
  });

  it("a rule that fails as a whole does not stop the other rules", async () => {
    // a broken condition value ("1.2.3" is not a number) fails the rule when it is checked, not a step
    const broken = await rule("lead", { field: "created_at", days: 11, direction: "after" }, { conditions: [{ field: "score", op: "gte", value: "1.2.3" }] });
    const good = await rule("lead", { field: "created_at", days: 11, direction: "after" });
    const due = await lead("אחת עשרה", 11);
    await runDates();
    expect(await runsOf(good)).toEqual([due]);
    expect(await runsOf(broken)).toEqual([]);
    await off(broken);
    await off(good);
  });

  it("a custom field counts only when it is an active date field of this business and this record type", async () => {
    const today_ = await today();
    await asAdmin((q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, is_active) values
           ($2, 'contact', 'foreign_day', 'של עסק אחר', 'date', true),
           ($1, 'lead', 'lead_day', 'של ליד', 'date', true),
           ($1, 'contact', 'old_day', 'ישן', 'date', false)`,
        [org, otherOrg],
      ),
    );
    // the values are written by the server (a person's write would be refused for these keys)
    const c = await asAdmin(async (q) =>
      (
        await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, custom_fields) values ($1, 'שדות זרים', $2, $3) returning id", [
          org,
          owner.id,
          JSON.stringify({ foreign_day: today_, lead_day: today_, old_day: today_ }),
        ])
      ).rows[0].id,
    );
    const rules = [
      await rule("contact", { field: "cf:foreign_day", days: 0, direction: "after" }),
      await rule("contact", { field: "cf:lead_day", days: 0, direction: "after" }),
      await rule("contact", { field: "cf:old_day", days: 0, direction: "after" }),
    ];
    await runDates();
    for (const r of rules) expect(await runsOf(r)).toEqual([]);
    expect(c).toBeTruthy();
    for (const r of rules) await off(r);
  });

  it("a built-in date column outside the list is never read", async () => {
    // contacts.birth_date is a date column, but the birthday trigger owns it
    const r = await rule("contact", { field: "birth_date", days: 0, direction: "after" });
    await asAdmin(async (q) =>
      q("insert into public.contacts (organization_id, first_name, owner_id, birth_date) values ($1, 'יום הולדת', $2, (now() at time zone 'Asia/Jerusalem')::date)", [org, owner.id]),
    );
    await runDates();
    expect(await runsOf(r)).toEqual([]);
    await off(r);
  });

  it("a setting the engine does not know runs nothing", async () => {
    const bad = [
      { field: "created_at", days: 400, direction: "after" },
      { field: "created_at", days: -1, direction: "after" },
      { field: "created_at", days: "3", direction: "after" },
      { field: "created_at", days: 3, direction: "around" },
      { field: "full_name", days: 3, direction: "after" },
      { field: "cf:missing", days: 3, direction: "after" },
      { days: 3, direction: "after" },
    ];
    const rules = [];
    for (const config of bad) rules.push(await rule("lead", config));
    await lead("לכל הכללים", 3);
    // what 400 days after, or "-1" days after (tomorrow), would match if the days were not checked
    await lead("לפני 400 ימים", 400);
    await lead("מחר", -1);
    await runDates();
    for (const r of rules) expect(await runsOf(r)).toEqual([]);
    for (const r of rules) await off(r);
    // and a type the database does not know is refused
    const refused = await asUser(owner.id, (q) =>
      q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'x', 'lead', 'date_moved', '[{\"type\": \"notify\", \"to\": \"admins\", \"title\": \"x\"}]')", [org]).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      ),
    );
    expect(refused).toBe("23514");
  });
});
