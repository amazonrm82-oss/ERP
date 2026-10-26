import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addBusinessDays } from "@/features/calendar-days/business-days";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings, type Weekday } from "@/features/calendar-days/holidays";
import { addDays } from "@/lib/calendar-grid";

import { asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; error?: string; warning?: string };

// AUT-01 part B (owner, 18 October 2026): the "set field" step also writes the preferred channel and language of leads and
// contacts and the expected close date of deals, and a date field may take a relative date ("in X days", "in X working
// days", 0..365; an invalid one = ok with a warning, the field unchanged). Names and phones stay out.
describe("automations set built-in fields and relative dates (AUT-01 part B)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const run = async (entity: string, actions: Array<Record<string, unknown>>, recordId: string) => {
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שדה', $2, 'created', '{}', '[]', $3, false) returning id`,
          [org, entity, JSON.stringify(actions)],
        )
      ).rows[0].id,
    );
    const result = await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, recordId])).rows[0].r);
    const run = await asAdmin(async (q) =>
      (
        await q<{ steps: Step[]; today: string; now_minute: string }>(
          `select steps, to_char(created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as today,
                  to_char(created_at at time zone 'Asia/Jerusalem', 'HH24:MI') as now_minute
             from public.automation_runs where automation_id = $1`,
          [rule],
        )
      ).rows[0],
    );
    return { status: result.status, steps: run.steps, today: run.today, nowMinute: run.now_minute };
  };
  const set = (field: string, value: unknown) => ({ type: "set_field", field, value });
  const rel = (days: unknown, unit: unknown) => ({ relative: { days, unit } });
  const row = <R extends Record<string, unknown>>(table: string, id: string, columns: string) =>
    asAdmin(async (q) => (await q<R>(`select ${columns} from public.${table} where id = $1`, [id])).rows[0]);
  const newContact = () =>
    asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id);
  const newDeal = () =>
    asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stageId]))
        .rows[0].id,
    );
  const newCompany = () =>
    asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה') returning id", [org])).rows[0].id);
  const newTask = () =>
    asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'משימה', $2) returning id", [org, owner.id])).rows[0].id,
    );
  const closeDate = async (deal: string) =>
    (await row<{ d: string | null }>("deals", deal, "to_char(expected_close_date, 'YYYY-MM-DD') as d")).d;
  const setCalendar = (s: CalendarSettings) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = excluded.holidays_rest,
           holiday_eves_rest = excluded.holiday_eves_rest, rest_occasions = excluded.rest_occasions`,
        [org, s.restWeekdays, s.holidaysRest, s.holidayEvesRest, s.restOccasions],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("asfb-owner");
    org = await createOrg(owner.id, "עסק שדות מובנים");
    const pipeline = await defaultPipeline(org);
    pipelineId = pipeline.pipelineId;
    stageId = pipeline.stages.find((s) => s.kind === "open")!.id;
    await asAdmin(async (q) => {
      for (const [object, key, type] of [
        ["lead", "visit", "date"],
        ["lead", "meet", "datetime"],
        ["lead", "note", "text"],
        ["deal", "kickoff", "date"],
      ]) {
        await q(
          `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options)
           values ($1, $2, $3, $3, $4, '[]')`,
          [org, object, key, type],
        );
      }
    });
  });

  it("sets and clears the preferred channel of a lead and a contact; a record with a source keeps it (option ג), one with none gets 'form' (answer ב)", async () => {
    const lead = await insertLead(owner.id, org);
    const contact = await newContact();
    for (const [entity, table, id] of [["lead", "leads", lead], ["contact", "contacts", contact]] as const) {
      // no channel and no source before: the source becomes 'form', so a later public form may replace it (owner, answer ב)
      const r = await run(entity, [set("preferred_channel", "whatsapp")], id);
      expect(r.status, entity).toBe("success");
      expect(r.steps[0], entity).toEqual({ action: "set_field", status: "ok" });
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: "whatsapp", preferred_channel_source: "form" });
      // a channel a public form set: the same channel or another one keeps the form as its source
      await asAdmin((q) => q(`update public.${table} set preferred_channel = 'sms', preferred_channel_source = 'form' where id = $1`, [id]));
      expect((await run(entity, [set("preferred_channel", "sms")], id)).steps[0].status).toBe("ok");
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: "sms", preferred_channel_source: "form" });
      expect((await run(entity, [set("preferred_channel", "phone")], id)).steps[0].status).toBe("ok");
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: "phone", preferred_channel_source: "form" });
      // a channel a person set: another one keeps 'manual'
      await asAdmin((q) => q(`update public.${table} set preferred_channel = 'sms', preferred_channel_source = 'manual' where id = $1`, [id]));
      expect((await run(entity, [set("preferred_channel", "email")], id)).steps[0].status).toBe("ok");
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: "email", preferred_channel_source: "manual" });
      // a channel with no source (older than the source): the same channel changes nothing, another one makes it 'form'
      await asAdmin((q) => q(`update public.${table} set preferred_channel = 'sms', preferred_channel_source = null where id = $1`, [id]));
      expect((await run(entity, [set("preferred_channel", "sms")], id)).steps[0].status).toBe("ok");
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: "sms", preferred_channel_source: null });
      expect((await run(entity, [set("preferred_channel", "email")], id)).steps[0].status).toBe("ok");
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: "email", preferred_channel_source: "form" });
      // a value off the list, or not a text, fails the step and changes nothing
      for (const value of ["fax", "WhatsApp", 3, ["phone"]]) {
        const bad = await run(entity, [set("preferred_channel", value)], id);
        expect(bad.steps[0], `${entity} ${JSON.stringify(value)}`).toEqual({ action: "set_field", status: "error", error: "the value does not fit the field" });
      }
      expect((await row<{ preferred_channel: string }>(table, id, "preferred_channel")).preferred_channel).toBe("email");
      // null clears the channel and its source
      expect((await run(entity, [set("preferred_channel", null)], id)).steps[0].status).toBe("ok");
      expect(await row(table, id, "preferred_channel, preferred_channel_source"), entity).toEqual({ preferred_channel: null, preferred_channel_source: null });
    }
  });

  it("sets and clears the preferred language of a lead and a contact, from the seven languages only", async () => {
    const lead = await insertLead(owner.id, org);
    const contact = await newContact();
    for (const [entity, table, id] of [["lead", "leads", lead], ["contact", "contacts", contact]] as const) {
      for (const locale of ["he", "ar", "en", "ru", "am", "fr", "es"]) {
        expect((await run(entity, [set("preferred_locale", locale)], id)).steps[0], `${entity} ${locale}`).toEqual({ action: "set_field", status: "ok" });
        expect((await row<{ preferred_locale: string }>(table, id, "preferred_locale")).preferred_locale).toBe(locale);
      }
      for (const value of ["de", "", 1]) {
        expect((await run(entity, [set("preferred_locale", value)], id)).steps[0].error, `${entity} ${JSON.stringify(value)}`).toBe("the value does not fit the field");
      }
      expect((await row<{ preferred_locale: string }>(table, id, "preferred_locale")).preferred_locale).toBe("es");
      expect((await run(entity, [{ type: "set_field", field: "preferred_locale" }], id)).steps[0].status).toBe("ok");
      expect((await row<{ preferred_locale: string | null }>(table, id, "preferred_locale")).preferred_locale).toBeNull();
    }
  });

  it("sets and clears a deal's expected close date; a date that does not exist fails the step", async () => {
    const deal = await newDeal();
    expect((await run("deal", [set("expected_close_date", "2026-12-31")], deal)).steps[0]).toEqual({ action: "set_field", status: "ok" });
    expect(await closeDate(deal)).toBe("2026-12-31");
    for (const value of ["2026-02-30", "31/12/2026", 20261231, true]) {
      expect((await run("deal", [set("expected_close_date", value)], deal)).steps[0].error, JSON.stringify(value)).toBe("the value does not fit the field");
    }
    expect(await closeDate(deal)).toBe("2026-12-31");
    expect((await run("deal", [set("expected_close_date", null)], deal)).steps[0].status).toBe("ok");
    expect(await closeDate(deal)).toBeNull();
  });

  it("refuses each new field on a record type it does not belong to", async () => {
    const lead = await insertLead(owner.id, org);
    const deal = await newDeal();
    const company = await newCompany();
    const task = await newTask();
    const cases: Array<[string, string, string, unknown]> = [
      ["deal", deal, "preferred_channel", "phone"],
      ["deal", deal, "preferred_locale", "he"],
      ["company", company, "preferred_channel", "phone"],
      ["company", company, "preferred_locale", "he"],
      ["task", task, "preferred_channel", "phone"],
      ["lead", lead, "expected_close_date", "2026-12-31"],
      ["company", company, "expected_close_date", "2026-12-31"],
      ["task", task, "expected_close_date", rel(1, "calendar")],
    ];
    for (const [entity, id, field, value] of cases) {
      expect((await run(entity, [set(field, value)], id)).steps[0], `${entity} ${field}`).toEqual({
        action: "set_field",
        status: "error",
        error: "the field does not fit this record",
      });
    }
  });

  it("never rewrites names, phones or emails", async () => {
    const lead = await insertLead(owner.id, org);
    const contact = await newContact();
    const deal = await newDeal();
    const company = await newCompany();
    const cases: Array<[string, string, string[]]> = [
      ["lead", lead, ["full_name", "phone", "phone_e164", "email", "company_name"]],
      ["contact", contact, ["first_name", "last_name", "phone", "email", "phone_e164"]],
      ["deal", deal, ["name"]],
      ["company", company, ["name", "phone", "email"]],
    ];
    for (const [entity, id, fields] of cases) {
      for (const field of fields) {
        expect((await run(entity, [set(field, "שם חדש")], id)).steps[0].error, `${entity} ${field}`).toBe("the field does not fit this record");
      }
    }
    expect((await row<{ first_name: string }>("contacts", contact, "first_name")).first_name).toBe("דנה");
    expect((await row<{ name: string }>("deals", deal, "name")).name).toBe("עסקה");
  });

  it("a relative date in calendar days: today plus X in the business's zone, on the close date and on date and datetime fields", async () => {
    const deal = await newDeal();
    for (const days of [0, 1, 10, 365]) {
      const r = await run("deal", [set("expected_close_date", rel(days, "calendar")), set("cf:kickoff", rel(days, "calendar"))], deal);
      expect(r.status, String(days)).toBe("success");
      expect(r.steps, String(days)).toEqual([
        { action: "set_field", status: "ok" },
        { action: "set_field", status: "ok" },
      ]);
      expect(await closeDate(deal)).toBe(addDays(r.today, days));
      expect((await row<{ c: Record<string, unknown> }>("deals", deal, "custom_fields as c")).c.kickoff).toBe(addDays(r.today, days));
    }
    const lead = await insertLead(owner.id, org);
    const r = await run("lead", [set("cf:visit", rel(3, "calendar")), set("cf:meet", rel(2, "calendar"))], lead);
    expect(r.status).toBe("success");
    const stored = await asAdmin(async (q) =>
      (
        await q<{ visit: string; meet: string; meet_day: string; meet_time: string }>(
          `select custom_fields ->> 'visit' as visit, custom_fields ->> 'meet' as meet,
                  to_char((custom_fields ->> 'meet')::timestamptz at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as meet_day,
                  to_char((custom_fields ->> 'meet')::timestamptz at time zone 'Asia/Jerusalem', 'HH24:MI') as meet_time
             from public.leads where id = $1`,
          [lead],
        )
      ).rows[0],
    );
    expect(stored.visit).toBe(addDays(r.today, 3));
    // a datetime keeps the current local time, to the minute, written as the app writes one (ISO, UTC)
    expect(stored.meet).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(stored.meet_day).toBe(addDays(r.today, 2));
    expect(stored.meet_time).toBe(r.nowMinute);
  });

  it("a relative date in working days skips the business's rest days (a weekend made of today and tomorrow)", async () => {
    const deal = await newDeal();
    try {
      // rest days: today's weekday and tomorrow's, no holidays; 0 = the next working day, the day after tomorrow
      const today = (await asAdmin(async (q) => (await q<{ d: string }>("select to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d")).rows[0])).d;
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() as Weekday;
      const weekend: CalendarSettings = { restWeekdays: [weekday, ((weekday + 1) % 7) as Weekday], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };
      await setCalendar(weekend);
      for (const days of [0, 1, 5]) {
        const r = await run("deal", [set("expected_close_date", rel(days, "business"))], deal);
        expect(r.steps[0], String(days)).toEqual({ action: "set_field", status: "ok" });
        expect(await closeDate(deal), String(days)).toBe(addBusinessDays(weekend, r.today, days));
        if (r.today === today) {
          if (days === 0) expect(await closeDate(deal)).toBe(addDays(today, 2));
          // counted after today: from a rest day the first working day is the day after tomorrow, as for 0
          if (days === 1) expect(await closeDate(deal)).toBe(addDays(today, 2));
        }
      }
      // the default calendar (Friday and Saturday, holidays as rest) agrees with the app's mirror; 3.0 is a whole number
      await setCalendar(DEFAULT_CALENDAR_SETTINGS);
      for (const days of [0, 1, 7, 365]) {
        const r = await run("deal", [set("expected_close_date", rel(days, "business"))], deal);
        expect(r.steps[0], String(days)).toEqual({ action: "set_field", status: "ok" });
        expect(await closeDate(deal), String(days)).toBe(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, r.today, days));
      }
      const lead = await insertLead(owner.id, org);
      const raw = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'שדה', 'lead', 'created', '{}', '[]', '[{"type": "set_field", "field": "cf:visit", "value": {"relative": {"days": 3.0, "unit": "business"}}}]', false)
             returning id`,
            [org],
          )
        ).rows[0].id,
      );
      await asUser(owner.id, (q) => q("select public.run_automation_now($1, $2)", [raw, lead]));
      const runDay = (await asAdmin(async (q) =>
        (await q<{ d: string }>("select to_char(created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d from public.automation_runs where automation_id = $1", [raw])).rows[0],
      )).d;
      expect((await row<{ c: Record<string, unknown> }>("leads", lead, "custom_fields as c")).c.visit).toBe(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, runDay, 3));
    } finally {
      await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    }
  });

  it("an invalid relative date runs as ok with a warning and leaves the field as it is", async () => {
    const deal = await newDeal();
    const lead = await insertLead(owner.id, org);
    await run("deal", [set("expected_close_date", "2026-12-31")], deal);
    await run("lead", [set("cf:visit", "2026-11-01")], lead);
    const bad: unknown[] = [
      rel(366, "calendar"),
      rel(-1, "business"),
      rel(2.5, "calendar"),
      rel("3", "calendar"),
      rel(null, "business"),
      rel(3, "weeks"),
      rel(3, null),
      { relative: 3 },
      { relative: {} },
    ];
    for (const value of bad) {
      const r = await run("deal", [set("expected_close_date", value), set("cf:kickoff", value)], deal);
      expect(r.status, JSON.stringify(value)).toBe("success");
      expect(r.steps, JSON.stringify(value)).toEqual([
        { action: "set_field", status: "ok", warning: "the relative date is invalid" },
        { action: "set_field", status: "ok", warning: "the relative date is invalid" },
      ]);
      const onLead = await run("lead", [set("cf:visit", value)], lead);
      expect(onLead.steps[0], JSON.stringify(value)).toEqual({ action: "set_field", status: "ok", warning: "the relative date is invalid" });
    }
    expect(await closeDate(deal)).toBe("2026-12-31");
    expect((await row<{ c: Record<string, unknown> }>("deals", deal, "custom_fields as c")).c).not.toHaveProperty("kickoff");
    expect((await row<{ c: Record<string, unknown> }>("leads", lead, "custom_fields as c")).c.visit).toBe("2026-11-01");
    // a later step of the same run still runs, and a step without a warning carries none
    const r = await run("deal", [set("expected_close_date", rel(400, "calendar")), set("expected_close_date", rel(0, "calendar"))], deal);
    expect(r.steps[1]).toEqual({ action: "set_field", status: "ok" });
    expect(await closeDate(deal)).toBe(r.today);
  });

  it("a relative date on a field that is not a date fails the step", async () => {
    const lead = await insertLead(owner.id, org);
    for (const field of ["cf:note", "preferred_channel", "preferred_locale"]) {
      expect((await run("lead", [set(field, rel(1, "calendar"))], lead)).steps[0], field).toEqual({
        action: "set_field",
        status: "error",
        error: "the value does not fit the field",
      });
    }
    expect((await row<{ c: Record<string, unknown> }>("leads", lead, "custom_fields as c")).c).toEqual({});
  });

  it("the helper is the engine's only: no client role may call it", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ r: string }>(
          `select r from unnest(array['public', 'anon', 'authenticated', 'service_role']) r
            where r <> 'public' and has_function_privilege(r, 'app.automation_relative_date(uuid, jsonb)', 'execute')`,
        )
      ).rows,
    );
    expect(grants).toEqual([]);
  });
});
