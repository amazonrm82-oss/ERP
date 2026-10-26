import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * AUT-03 (rest): "a field changed" on any column or custom field, "form submitted" from intake, a fixed schedule and the
 * card's manual button.
 */
describe("automation triggers: any field, form, schedule, manual (AUT-03)", () => {
  let owner: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const own = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  // a user may own at most 5 businesses: each further test business gets its own owner
  const owners = new Map<string, string>();
  const ownerOf = (orgId: string) => owners.get(orgId) ?? owner.id;
  const newOrg = async (name: string) => {
    const user = await createUser("m3-org-owner");
    const id = await createOrg(user.id, name);
    owners.set(id, user.id);
    return id;
  };
  const rule = (entity: string, trigger: string, config: Record<string, unknown> = {}, conditions: unknown[] = [], orgId?: string, userId?: string) =>
    asUser(userId ?? ownerOf(orgId ?? org), async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [orgId ?? org, `כלל ${++n}`, entity, trigger, JSON.stringify(config), JSON.stringify(conditions), JSON.stringify([{ type: "notify", to: "owner", title: `אוטומציה ${n}` }])],
        )
      ).id,
    );
  const runs = (auto: string, record?: string) =>
    asAdmin((q) =>
      record
        ? count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, record])
        : count(q, "select 1 from public.automation_runs where automation_id = $1", [auto]),
    );
  const drain = async () => {
    for (let i = 0; i < 50; i += 1) {
      await asAdmin((q) => q("select app.process_outbox(5000)"));
      const left = await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and processed_at is null", [org]));
      if (left === 0) return;
      await asAdmin((q) => q("select pg_sleep(0.1)"));
    }
    throw new Error("events were not processed");
  };
  const lastChanged = (id: string) =>
    asAdmin(async (q) => (await one<{ c: string[] }>(q, "select payload -> 'changed' as c from public.outbox_events where entity_id = $1 and event_type like '%.updated' order by id desc limit 1", [id])).c);

  beforeAll(async () => {
    owner = await createUser("m3-owner");
    org = await createOrg(owner.id, "עסק הטריגרים החדשים");
    member = await addMember(org, owner.id, "member", "m3-member");
    other = await addMember(org, owner.id, "member", "m3-other");
    viewer = await addMember(org, owner.id, "viewer", "m3-viewer");
    outsider = await createUser("m3-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await own((q) =>
      q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'level', 'רמה', 'text')", [org]),
    );
  });

  describe("a field changed", () => {
    it("an update lists each changed custom field as cf:<key>, beside the columns", async () => {
      const lead = await insertLead(owner.id, org, { full_name: "ליד שדות" });
      await own((q) => q(`update public.leads set custom_fields = '{"$merge": {"level": "חם"}}', email = 'a@b.co' where id = $1`, [lead]));
      expect((await lastChanged(lead)).sort()).toEqual(["cf:level", "custom_fields", "email"]);
      // a change of another column alone lists no custom field
      await own((q) => q("update public.leads set phone = '0501234567' where id = $1", [lead]));
      expect(await lastChanged(lead)).toEqual(["phone"]);
    });

    it("a rule on a custom field runs when it changes to the value, and not on an automation's own change", async () => {
      const auto = await rule("lead", "field_changed", { field: "cf:level", to: "קר" });
      const any = await rule("lead", "field_changed", { field: "cf:level" });
      const lead = await insertLead(owner.id, org, { full_name: "ליד רמה" });
      await own((q) => q(`update public.leads set custom_fields = '{"$merge": {"level": "חם"}}' where id = $1`, [lead]));
      await drain();
      expect(await runs(auto, lead)).toBe(0);
      expect(await runs(any, lead)).toBe(1);
      await own((q) => q(`update public.leads set custom_fields = '{"$merge": {"level": "קר"}}' where id = $1`, [lead]));
      await drain();
      expect(await runs(auto, lead)).toBe(1);
      expect(await runs(any, lead)).toBe(2);
      // the same change made while an automation runs starts nothing
      await asAdmin(async (q) => {
        await q("select set_config('app.automation_running', 'on', true)");
        await q(`update public.leads set custom_fields = custom_fields || '{"level": "פושר"}' where id = $1`, [lead]);
      });
      await drain();
      expect(await runs(any, lead)).toBe(2);
      // another field of the lead does not start it
      await own((q) => q("update public.leads set email = 'z@z.co' where id = $1", [lead]));
      await drain();
      expect(await runs(any, lead)).toBe(2);
    });

    it("a rule on a built-in column of a contact runs on its change", async () => {
      const auto = await rule("contact", "field_changed", { field: "city", to: "חיפה" });
      const contact = await own(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, city) values ($1, 'איש', 'תל אביב') returning id", [org])).id);
      await drain();
      await own((q) => q("update public.contacts set city = 'חיפה' where id = $1", [contact]));
      await drain();
      expect(await runs(auto, contact)).toBe(1);
    });

    it("retry facts and the check read the custom field's value", async () => {
      const lead = await insertLead(owner.id, org, { full_name: "ליד ניסיון", custom_fields: { level: "חם" } });
      const facts = await asAdmin((q) =>
        one<{ f: Record<string, unknown> }>(q, "select app.automation_run_facts('field_changed', '{\"field\": \"cf:level\"}', 'lead', $1, $2, 'event:1') as f", [org, lead]),
      );
      expect(facts.f).toEqual({ value: "חם" });
      const holds = (config: string, value: string) =>
        asAdmin(async (q) =>
          (
            await one<{ h: boolean }>(
              q,
              "select app.automation_event_still_holds('field_changed', $3::jsonb, 'lead', $1, $2, (select to_jsonb(l) from public.leads l where l.id = $2), $4::jsonb) as h",
              [org, lead, config, JSON.stringify({ value })],
            )
          ).h,
        );
      expect(await holds('{"field": "cf:level"}', "חם")).toBe(true);
      expect(await holds('{"field": "cf:level"}', "קר")).toBe(false);
      expect(await holds('{"field": "cf:level", "to": "חם"}', "x")).toBe(true);
      expect(await holds('{"field": "cf:level", "to": "קר"}', "x")).toBe(false);
    });
  });

  describe("form submitted", () => {
    let form: { id: string; token: string }, form2: { id: string; token: string };
    const submit = (token: string, payload: Record<string, unknown>, spam = false) =>
      asService(async (q) => (await one<{ r: { status: string; lead_id?: string; contact_id?: string } }>(q, "select public.intake_submit($1, 'form', $2, null, null, $3) as r", [token, JSON.stringify(payload), spam])).r);
    const formEvents = (record: string) =>
      asAdmin(async (q) => (await q<{ payload: Record<string, unknown> }>("select payload from public.outbox_events where event_type = 'form_submitted' and entity_id = $1 order by id", [record])).rows.map((r) => r.payload));

    beforeAll(async () => {
      const make = (name: string) =>
        own(async (q) => one<{ id: string; token: string }>(q, "insert into public.forms (organization_id, name, owner_id) values ($1, $2, $3) returning id, token", [org, name, owner.id]));
      form = await make("טופס ראשון");
      form2 = await make("טופס שני");
    });

    it("a new lead writes one event with the form; a rule on that form runs, a rule on another does not", async () => {
      const any = await rule("lead", "form_submitted");
      const mine = await rule("lead", "form_submitted", { form_id: form.id });
      const others = await rule("lead", "form_submitted", { form_id: form2.id });
      const result = await submit(form.token, { full_name: "פונה חדש", phone: "0521110001" });
      expect(result.status).toBe("accepted");
      const lead = result.lead_id!;
      expect(await formEvents(lead)).toEqual([{ form_id: form.id, submission: "new" }]);
      await drain();
      expect(await runs(any, lead)).toBe(1);
      expect(await runs(mine, lead)).toBe(1);
      expect(await runs(others, lead)).toBe(0);
      // a repeat inquiry from the same phone through the second form: one more event on the matched lead
      const again = await submit(form2.token, { full_name: "פונה חדש", phone: "0521110001" });
      expect(again.status).toBe("duplicate");
      expect((await formEvents(lead)).at(-1)).toEqual({ form_id: form2.id, submission: "repeat" });
      await drain();
      expect(await runs(any, lead)).toBe(2);
      expect(await runs(others, lead)).toBe(1);
    });

    it("a repeat inquiry of a contact writes the event on the contact; spam writes none", async () => {
      const contactRule = await rule("contact", "form_submitted");
      const contact = await own(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, phone) values ($1, 'לקוח', '0521110002') returning id", [org])).id);
      const result = await submit(form.token, { full_name: "לקוח", phone: "0521110002" });
      expect(result.status).toBe("duplicate");
      expect(await formEvents(contact)).toEqual([{ form_id: form.id, submission: "repeat" }]);
      await drain();
      expect(await runs(contactRule, contact)).toBe(1);
      const before = await asAdmin((q) => count(q, "select 1 from public.outbox_events where event_type = 'form_submitted' and organization_id = $1", [org]));
      expect((await submit(form.token, { full_name: "ספאם", phone: "0521110003" }, true)).status).toBe("spam");
      expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where event_type = 'form_submitted' and organization_id = $1", [org]))).toBe(before);
    });

    it("a repeat inquiry matching a converted lead fires its contact's rules, never the lead's", async () => {
      const result = await submit(form.token, { full_name: "יהפוך ללקוח", phone: "0521110006" });
      const lead = result.lead_id!;
      const contact = await own(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, phone) values ($1, 'יהפוך', '0521110006') returning id", [org])).id);
      await asAdmin((q) => q("update public.leads set converted_at = now(), converted_contact_id = $2 where id = $1", [lead, contact]));
      const again = await submit(form.token, { full_name: "יהפוך ללקוח", phone: "0521110006" });
      expect(again.status).toBe("duplicate");
      expect(await formEvents(lead)).toEqual([{ form_id: form.id, submission: "new" }]);
      expect(await formEvents(contact)).toEqual([{ form_id: form.id, submission: "repeat" }]);
    });

    it("with leads off, the new contact gets the event", async () => {
      await own((q) => q("insert into public.org_modules (organization_id, leads_enabled) values ($1, false) on conflict (organization_id) do update set leads_enabled = false", [org]));
      try {
        const result = await submit(form.token, { full_name: "בלי לידים", phone: "0521110004" });
        expect(result.contact_id).toBeTruthy();
        expect(await formEvents(result.contact_id!)).toEqual([{ form_id: form.id, submission: "new" }]);
      } finally {
        await own((q) => q("update public.org_modules set leads_enabled = true where organization_id = $1", [org]));
      }
    });

    it("retry: the facts are the form; it still holds", async () => {
      const lead = (await submit(form.token, { full_name: "פונה לניסיון", phone: "0521110005" })).lead_id!;
      const event = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.outbox_events where event_type = 'form_submitted' and entity_id = $1", [lead])).id);
      const facts = await asAdmin((q) => one<{ f: Record<string, unknown> }>(q, "select app.automation_run_facts('form_submitted', '{}', 'lead', $1, $2, $3) as f", [org, lead, `event:${event}`]));
      expect(facts.f).toEqual({ form_id: form.id });
      const holds = await asAdmin((q) =>
        one<{ h: boolean }>(q, "select app.automation_event_still_holds('form_submitted', '{}', 'lead', $1, $2, (select to_jsonb(l) from public.leads l where l.id = $2), $3::jsonb) as h", [org, lead, JSON.stringify(facts.f)]),
      );
      expect(holds.h).toBe(true);
    });
  });

  describe("fixed schedule", () => {
    const slot = (config: Record<string, unknown>, now: string, zone = "UTC") =>
      asAdmin(async (q) => (await one<{ s: string | null }>(q, "select to_char(app.schedule_slot($1::jsonb, $2::timestamptz, $3) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as s", [JSON.stringify(config), now, zone])).s);

    it("app.schedule_slot: the latest time at or before now, daily or on the chosen weekdays; null for a bad setting", async () => {
      // 2026-10-26 is a Monday (dow 1)
      expect(await slot({ frequency: "daily", time: "09:00" }, "2026-10-26 09:00Z")).toBe("2026-10-26 09:00");
      expect(await slot({ frequency: "daily", time: "09:00" }, "2026-10-26 08:59Z")).toBe("2026-10-25 09:00");
      expect(await slot({ frequency: "weekly", time: "08:00", days: [4] }, "2026-10-26 10:00Z")).toBe("2026-10-22 08:00");
      expect(await slot({ frequency: "weekly", time: "08:00", days: [1] }, "2026-10-26 07:00Z")).toBe("2026-10-19 08:00");
      // in the business's zone: 09:00 in Jerusalem (UTC+2 after 25 October) is 07:00 UTC
      expect(await slot({ frequency: "daily", time: "09:00" }, "2026-10-26 07:30Z", "Asia/Jerusalem")).toBe("2026-10-26 07:00");
      expect(await slot({ frequency: "weekly", time: "08:00", days: [] }, "2026-10-26 10:00Z")).toBeNull();
      expect(await slot({ frequency: "daily", time: "25:00" }, "2026-10-26 10:00Z")).toBeNull();
      expect(await slot({ frequency: "hourly", time: "08:00" }, "2026-10-26 10:00Z")).toBeNull();
      // a missing frequency runs nothing
      expect(await slot({ time: "08:00" }, "2026-10-26 10:00Z")).toBeNull();
    });

    it("never steps back while now moves on, also in the hour the clock is set back (Jerusalem, 25 October 2026)", async () => {
      for (const time of ["01:30", "01:00", "02:00", "00:45"]) {
        const seen = await asAdmin(async (q) =>
          (
            await q<{ s: string }>(
              `select app.schedule_slot($1::jsonb, t, 'Asia/Jerusalem')::text as s
                 from generate_series('2026-10-24 20:00Z'::timestamptz, '2026-10-25 03:00Z'::timestamptz, interval '5 minutes') t order by t`,
              [JSON.stringify({ frequency: "daily", time })],
            )
          ).rows.map((r) => new Date(r.s).getTime()),
        );
        for (let i = 1; i < seen.length; i += 1) expect(seen[i], `${time} #${i}`).toBeGreaterThanOrEqual(seen[i - 1]);
      }
    });

    it("runs once per record and scheduled time over the records that meet the conditions; skips bin and converted leads", async () => {
      const orgS = await newOrg("עסק לוח זמנים");
      const lead = (name: string, extra: Record<string, unknown> = {}) => insertLead(ownerOf(orgS), orgS, { full_name: name, ...extra });
      const a = await lead("א", { email: "a@x.co" });
      const b = await lead("ב", { email: "b@x.co" });
      const noEmail = await lead("ג");
      const binned = await lead("ד", { email: "d@x.co" });
      const converted = await lead("ה", { email: "e@x.co" });
      await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
      await asAdmin((q) => q("update public.leads set converted_at = now() where id = $1", [converted]));
      // the time came a minute ago in the business's zone, every day
      const time = await asAdmin(async (q) =>
        (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [orgS])).t,
      );
      const auto = await rule("lead", "schedule", { frequency: "daily", time }, [{ field: "email", op: "not_empty" }], orgS);
      const runOnce = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.run_schedule_automations() as n")).n);
      await runOnce();
      expect(await runs(auto, a)).toBe(1);
      expect(await runs(auto, b)).toBe(1);
      expect(await runs(auto, noEmail)).toBe(0);
      expect(await runs(auto, binned)).toBe(0);
      expect(await runs(auto, converted)).toBe(0);
      const key = await asAdmin(async (q) => (await one<{ k: string }>(q, "select run_key as k from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, a])).k);
      expect(key).toMatch(new RegExp(`^sched:${a}:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$`));
      // the same time never runs again, and the cursor marks it done
      await runOnce();
      expect(await runs(auto)).toBe(2);
      const cursor = await asAdmin((q) => one<{ after_id: string }>(q, "select after_id from app.automation_scan_cursors where automation_id = $1", [auto]));
      expect(cursor.after_id).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
      // a record added afterwards waits for the next time
      await lead("ו", { email: "f@x.co" });
      await runOnce();
      expect(await runs(auto)).toBe(2);

      // retry facts: the time from the run key; the check holds while the lead is open
      const facts = await asAdmin((q) => one<{ f: Record<string, unknown> }>(q, "select app.automation_run_facts('schedule', '{}', 'lead', $1, $2, $3) as f", [orgS, a, key]));
      expect(facts.f).toEqual({ slot: key.split(":").slice(2).join(":") });
      const holds = (id: string) =>
        asAdmin(async (q) =>
          (await one<{ h: boolean }>(q, "select app.automation_event_still_holds('schedule', '{}', 'lead', $1, $2, (select to_jsonb(l) from public.leads l where l.id = $2), $3::jsonb) as h", [orgS, id, JSON.stringify(facts.f)])).h,
        );
      expect(await holds(a)).toBe(true);
      expect(await holds(converted)).toBe(false);
    });

    it("goes on from the scan cursor when a pass stops at the scan limit; a time older than 24 hours is dropped", async () => {
      const orgS = await newOrg("עסק סריקה");
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push(await insertLead(ownerOf(orgS), orgS, { full_name: `סריקה ${i}` }));
      const time = await asAdmin(async (q) =>
        (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [orgS])).t,
      );
      const auto = await rule("lead", "schedule", { frequency: "daily", time }, [], orgS);
      const pass = () =>
        asAdmin(async (q) => {
          await q("select set_config('app.scheduled_scan_limit', '2', true)");
          return (await one<{ n: number }>(q, "select app.run_schedule_automations() as n")).n;
        });
      await pass();
      expect(await runs(auto)).toBe(2);
      await pass();
      expect(await runs(auto)).toBe(3);

      // a weekly rule whose day was three days ago: its time is more than 24 hours old, nothing runs
      const dow = await asAdmin(async (q) =>
        (await one<{ d: number }>(q, "select extract(dow from (now() at time zone app.intake_zone(o.timezone))::date - 3)::int as d from public.organizations o where o.id = $1", [orgS])).d,
      );
      const stale = await rule("lead", "schedule", { frequency: "weekly", time: "00:00", days: [dow] }, [], orgS);
      await pass();
      expect(await runs(stale)).toBe(0);
    });

    it("a record whose run raises is skipped for that time and logged; the rule goes on with the others", async () => {
      const orgS = await newOrg("עסק שגיאה");
      const bad = await insertLead(ownerOf(orgS), orgS, { full_name: "שגיאה" });
      const good = await insertLead(ownerOf(orgS), orgS, { full_name: "תקין" });
      const time = await asAdmin(async (q) =>
        (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [orgS])).t,
      );
      const auto = await rule("lead", "schedule", { frequency: "daily", time }, [], orgS);
      // a test-only trigger (in its own schema, removed at the end) makes the run on one record raise
      await asAdmin(async (q) => {
        await q("create schema if not exists aut03b_test");
        await q(`create or replace function aut03b_test.boom() returns trigger language plpgsql as $f$
                 begin if new.entity_id = '${bad}' and new.status = 'success' then raise exception 'boom'; end if; return new; end $f$`);
        await q("create trigger aut03b_boom before insert on public.automation_runs for each row execute function aut03b_test.boom()");
      });
      try {
        await asAdmin((q) => q("select app.run_schedule_automations()"));
      } finally {
        await asAdmin((q) => q("drop schema aut03b_test cascade"));
      }
      expect(await asAdmin((q) => one<{ status: string; steps: unknown }>(q, "select status, steps from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, bad]))).toEqual({
        status: "skipped",
        steps: [{ action: null, status: "error", error: "the run stopped with an error" }],
      });
      expect(await asAdmin((q) => one<{ status: string }>(q, "select status from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, good]))).toEqual({ status: "success" });
      // the next pass does not try the failed record again for that time
      await asAdmin((q) => q("select app.run_schedule_automations()"));
      expect(await runs(auto, bad)).toBe(1);
    });

    it("a big rule does not starve another rule of the same business; a pass has a cap across businesses", async () => {
      const orgS = await newOrg("עסק הוגן");
      for (let i = 0; i < 6; i += 1) await insertLead(ownerOf(orgS), orgS, { full_name: `הוגן ${i}` });
      const time = await asAdmin(async (q) =>
        (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [orgS])).t,
      );
      const big = await rule("lead", "schedule", { frequency: "daily", time }, [], orgS);
      const second = await rule("lead", "schedule", { frequency: "daily", time }, [], orgS);
      const pass = (perBusiness: number, perPass = 2000) =>
        asAdmin(async (q) => {
          await q("select set_config('app.schedule_runs_per_business', $1, true)", [String(perBusiness)]);
          await q("select set_config('app.schedule_runs_per_pass', $1, true)", [String(perPass)]);
          return (await one<{ n: number }>(q, "select app.run_schedule_automations() as n")).n;
        });
      await pass(4);
      expect([await runs(big), await runs(second)]).toEqual([2, 2]);
      // the next pass starts with the rule worked least recently
      await pass(4);
      expect([await runs(big), await runs(second)]).toEqual([4, 4]);
      // the cap across all businesses stops the pass
      expect(await pass(200, 1)).toBe(1);
      expect((await runs(big)) + (await runs(second))).toBe(9);
      // a share a rule does not need passes on to the rules after it
      await pass(200);
      expect([await runs(big), await runs(second)]).toEqual([6, 6]);
    });

    it("businesses take turns under the pass caps; the records examined a pass are bounded too", async () => {
      const make = async (name: string) => {
        const id = await newOrg(name);
        for (let i = 0; i < 4; i += 1) await insertLead(ownerOf(id), id, { full_name: `${name} ${i}` });
        const time = await asAdmin(async (q) =>
          (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [id])).t,
        );
        return rule("lead", "schedule", { frequency: "daily", time }, [], id);
      };
      const first = await make("עסק תור א");
      const second = await make("עסק תור ב");
      const pass = (settings: Record<string, number>) =>
        asAdmin(async (q) => {
          for (const [key, value] of Object.entries(settings)) await q("select set_config($1, $2, true)", [`app.${key}`, String(value)]);
          return (await one<{ n: number }>(q, "select app.run_schedule_automations() as n")).n;
        });
      // two runs a pass in total: whichever business goes first, the other goes first in the next pass
      expect(await pass({ schedule_runs_per_pass: 2 })).toBe(2);
      const afterOne = [await runs(first), await runs(second)];
      expect(afterOne.sort()).toEqual([0, 2]);
      expect(await pass({ schedule_runs_per_pass: 2 })).toBe(2);
      expect([await runs(first), await runs(second)]).toEqual([2, 2]);
      // three records examined a pass in total: the rest waits for the next pass
      expect(await pass({ schedule_scan_per_pass: 3 })).toBe(3);
      expect((await runs(first)) + (await runs(second))).toBe(7);
      await pass({});
      expect([await runs(first), await runs(second)]).toEqual([4, 4]);
    });

    it("a business with an idle rule does not stay first: each business takes its turn", async () => {
      const make = async (name: string, leads: number) => {
        const id = await newOrg(name);
        for (let i = 0; i < leads; i += 1) await insertLead(ownerOf(id), id, { full_name: `${name} ${i}` });
        const time = await asAdmin(async (q) =>
          (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [id])).t,
        );
        return { id, rule: await rule("lead", "schedule", { frequency: "daily", time }, [], id) };
      };
      const a = await make("עסק עם כלל רדום", 6);
      // A's idle rule: its weekly time was three days ago, so nothing is due (and it never moved a cursor before)
      const dow = await asAdmin(async (q) =>
        (await one<{ d: number }>(q, "select extract(dow from (now() at time zone app.intake_zone(o.timezone)))::int as d from public.organizations o where o.id = $1", [a.id])).d,
      );
      await rule("lead", "schedule", { frequency: "weekly", time: "00:00", days: [(dow + 4) % 7] }, [], a.id);
      const b = await make("עסק שמחכה לתור", 2);
      // B had a turn just now, so A goes first in this pass
      await asAdmin((q) => q("insert into app.schedule_business_turns (organization_id, last_turn_at) values ($1, now())", [b.id]));
      const pass = () =>
        asAdmin(async (q) => {
          await q("select set_config('app.schedule_scan_per_pass', '3', true)");
          return (await one<{ n: number }>(q, "select app.run_schedule_automations() as n")).n;
        });
      await pass();
      expect([await runs(a.rule), await runs(b.rule)]).toEqual([3, 0]);
      // the next pass reaches B first, although A's idle rule never moved its cursor
      await pass();
      expect(await runs(b.rule)).toBe(2);
      expect(await runs(a.rule)).toBe(4);
      // every business the runner reached has a turn stamp, and the stamps go with the business
      expect(await asAdmin((q) => count(q, "select 1 from app.schedule_business_turns where organization_id = any($1)", [[a.id, b.id]]))).toBe(2);
    });

    it("the cursor touch reads the rule's last change again and skips a deleted rule", async () => {
      const orgS = await newOrg("עסק נגיעה");
      const auto = await rule("lead", "schedule", { frequency: "daily", time: "00:00" }, [], orgS);
      // the runner's copy of the rule, read before an edit: changed two hours ago
      const snapshot = await asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.automations set updated_at = now() - interval '2 hours' where id = $1", [auto]);
        return (await one<{ a: Record<string, unknown> }>(q, "select to_jsonb(a) as a from public.automations a where id = $1", [auto])).a;
      });
      await asAdmin((q) =>
        q(
          `insert into app.automation_scan_cursors (automation_id, organization_id, after_at, after_id, updated_at)
           values ($1, $2, now() - interval '3 hours', 'ffffffff-ffff-ffff-ffff-ffffffffffff', now() - interval '1 hour')`,
          [auto, orgS],
        ),
      );
      // an edit committed during the pass
      await asUser(ownerOf(orgS), (q) => q("update public.automations set name = 'נערך' where id = $1", [auto]));
      const touch = (row: Record<string, unknown>) =>
        asAdmin((q) => q("select app.schedule_cursor_touch(jsonb_populate_record(null::public.automations, $1::jsonb))", [JSON.stringify(row)]));
      await touch(snapshot);
      expect(await asAdmin((q) => one<{ after_id: string }>(q, "select after_id::text from app.automation_scan_cursors where automation_id = $1", [auto]))).toEqual({
        after_id: "00000000-0000-0000-0000-000000000000",
      });
      // a rule that no longer exists gets no cursor, and no error
      const gone = { ...snapshot, id: "99999999-9999-4999-8999-999999999999" };
      await touch(gone);
      expect(await asAdmin((q) => count(q, "select 1 from app.automation_scan_cursors where automation_id = $1", [gone.id]))).toBe(0);
    });

    it("a rule whose cursor cannot be moved at all does not stop the pass for other businesses", async () => {
      const broken = await newOrg("עסק סמן תקוע");
      await insertLead(ownerOf(broken), broken, { full_name: "ליד" });
      const fine = await newOrg("עסק תקין אחרי");
      const lead = await insertLead(ownerOf(fine), fine, { full_name: "ליד תקין" });
      const timeOf = (id: string) =>
        asAdmin(async (q) =>
          (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [id])).t,
        );
      const bad = await rule("lead", "schedule", { frequency: "daily", time: await timeOf(broken) }, [], broken);
      const good = await rule("lead", "schedule", { frequency: "daily", time: await timeOf(fine) }, [], fine);
      // the broken business goes first; every write of its rule's cursor fails (as when the rule is deleted mid-pass)
      await asAdmin((q) => q("insert into app.schedule_business_turns (organization_id, last_turn_at) values ($1, '-infinity') on conflict (organization_id) do update set last_turn_at = '-infinity'", [broken]));
      await asAdmin(async (q) => {
        await q("create schema if not exists aut03b_test3");
        await q(`create or replace function aut03b_test3.boom() returns trigger language plpgsql as $f$
                 begin if new.automation_id = '${bad}' then raise exception 'boom'; end if; return new; end $f$`);
        await q("create trigger aut03b_boom3 before insert or update on app.automation_scan_cursors for each row execute function aut03b_test3.boom()");
      });
      try {
        await asAdmin((q) => q("select app.run_schedule_automations()"));
      } finally {
        await asAdmin((q) => q("drop schema aut03b_test3 cascade"));
      }
      expect(await runs(good, lead)).toBe(1);
    });

    it("records that already ran for the time count as examined", async () => {
      const orgS = await newOrg("עסק סריקה כפולה");
      for (let i = 0; i < 3; i += 1) await insertLead(ownerOf(orgS), orgS, { full_name: `כפול ${i}` });
      const time = await asAdmin(async (q) =>
        (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [orgS])).t,
      );
      const auto = await rule("lead", "schedule", { frequency: "daily", time }, [], orgS);
      const full = await asAdmin((q) => one<{ a: Record<string, unknown> }>(q, "select to_jsonb(a) as a from public.automations a where id = $1", [auto]));
      const step = () =>
        asAdmin(async (q) => (await one<{ r: { runs: number; scanned: number } }>(q, "select to_jsonb(s) as r from app.scheduled_schedule(jsonb_populate_record(null::public.automations, $1::jsonb), 100, 100) s", [JSON.stringify(full.a)])).r);
      expect(await step()).toEqual({ runs: 3, scanned: 3 });
      // a cursor reset (a rule change) walks them again: no run, but each one is examined
      await asAdmin((q) => q("update app.automation_scan_cursors set after_id = '00000000-0000-0000-0000-000000000000' where automation_id = $1", [auto]));
      expect(await step()).toEqual({ runs: 0, scanned: 3 });
    });

    it("a rule that raises goes last in the next pass; a cursor older than the rule starts again", async () => {
      const orgS = await newOrg("עסק כלל שנכשל");
      const auto = await rule("lead", "schedule", { frequency: "daily", time: "00:00" }, [], orgS);
      // a cursor left from before the rule's last change, marked done for some time
      await asAdmin((q) =>
        q(
          `insert into app.automation_scan_cursors (automation_id, organization_id, after_at, after_id, updated_at)
           values ($1, $2, now() - interval '3 days', 'ffffffff-ffff-ffff-ffff-ffffffffffff', now() - interval '2 days')`,
          [auto, orgS],
        ),
      );
      // a test-only trigger (own schema, removed at the end) makes the rule raise when it moves its cursor to the time
      await asAdmin(async (q) => {
        await q("create schema if not exists aut03b_test2");
        await q(`create or replace function aut03b_test2.boom() returns trigger language plpgsql as $f$
                 begin if new.automation_id = '${auto}' then raise exception 'boom'; end if; return new; end $f$`);
        await q("create trigger aut03b_boom2 before insert or update on app.automation_scan_cursors for each row when (new.after_at <> '-infinity') execute function aut03b_test2.boom()");
      });
      await insertLead(ownerOf(orgS), orgS, { full_name: "ליד" });
      const before = await asAdmin(async (q) => (await one<{ t: string }>(q, "select now()::text as t")).t);
      try {
        await asAdmin((q) => q("select app.run_schedule_automations()"));
      } finally {
        await asAdmin((q) => q("drop schema aut03b_test2 cascade"));
      }
      const cursor = await asAdmin((q) =>
        one<{ moved: boolean; after_at: string; after_id: string }>(
          q,
          "select updated_at >= $2::timestamptz as moved, after_at::text, after_id::text from app.automation_scan_cursors where automation_id = $1",
          [auto, before],
        ),
      );
      expect(cursor).toEqual({ moved: true, after_at: "-infinity", after_id: "00000000-0000-0000-0000-000000000000" });
    });

    it("a deal schedule runs on open deals only", async () => {
      const orgS = await newOrg("עסק עסקאות");
      const pipe = await asAdmin(async (q) => (await q<{ id: string; pipeline_id: string; kind: string }>("select s.id, s.pipeline_id, s.kind from public.stages s where s.organization_id = $1 order by s.position", [orgS])).rows);
      const openStage = pipe.find((s) => s.kind === "open")!;
      const wonStage = pipe.find((s) => s.kind === "won")!;
      const deal = (stage: { id: string; pipeline_id: string }) =>
        asUser(ownerOf(orgS), async (q) => (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [orgS, stage.pipeline_id, stage.id])).id);
      const open = await deal(openStage);
      const won = await deal(wonStage);
      const time = await asAdmin(async (q) =>
        (await one<{ t: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone)) - interval '1 minute', 'HH24:MI') as t from public.organizations o where o.id = $1", [orgS])).t,
      );
      const auto = await rule("deal", "schedule", { frequency: "daily", time }, [], orgS);
      await asAdmin((q) => q("select app.run_schedule_automations()"));
      expect(await runs(auto, open)).toBe(1);
      expect(await runs(auto, won)).toBe(0);
    });
  });

  describe("manual button", () => {
    const list = (userId: string, entity: string, record: string, orgId = org) =>
      asUser(userId, async (q) => (await one<{ r: Array<{ id: string; name: string }> }>(q, "select public.manual_automations($1, $2, $3) as r", [orgId, entity, record])).r);
    const runAs = (userId: string, auto: string, record: string, orgId = org) =>
      asUser(userId, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.run_manual_automation($1, $2, $3) as r", [orgId, auto, record])).r);

    it("lists the active manual rules of the type to whoever may edit the record, and nothing to anyone else", async () => {
      const auto = await rule("lead", "manual");
      const off = await rule("lead", "manual");
      await own((q) => q("update public.automations set is_active = false where id = $1", [off]));
      await rule("contact", "manual");
      await rule("lead", "created");
      const lead = await insertLead(member.id, org, { full_name: "ליד של חבר", owner_id: member.id });
      expect((await list(member.id, "lead", lead)).map((r) => r.id)).toEqual([auto]);
      expect((await list(owner.id, "lead", lead)).map((r) => r.id)).toEqual([auto]);
      expect(await list(other.id, "lead", lead)).toEqual([]);
      expect(await list(viewer.id, "lead", lead)).toEqual([]);
      expect(await list(outsider.id, "lead", lead)).toEqual([]);
      expect(await list(outsider.id, "lead", lead, otherOrg)).toEqual([]);
      expect(await list(member.id, "task", lead)).toEqual([]);
    });

    it("runs with the conditions checked, each press its own run with a button: key; refuses what the caller may not run", async () => {
      const auto = await rule("lead", "manual", {}, [{ field: "email", op: "not_empty" }]);
      const lead = await insertLead(member.id, org, { full_name: "ליד להפעלה", owner_id: member.id, email: "m@x.co" });
      const bare = await insertLead(member.id, org, { full_name: "ליד בלי אימייל", owner_id: member.id });
      expect(await runAs(member.id, auto, lead)).toEqual({ ok: true, status: "success" });
      const run = await asAdmin((q) => one<{ run_key: string; next_retry_at: string | null }>(q, "select run_key, next_retry_at from public.automation_runs where automation_id = $1", [auto]));
      expect(run.run_key).toMatch(/^button:/);
      expect(run.next_retry_at).toBeNull();
      // a second press runs again (each press is its own occasion)
      expect((await runAs(member.id, auto, lead)).ok).toBe(true);
      expect(await runs(auto, lead)).toBe(2);
      expect(await runAs(member.id, auto, bare)).toEqual({ ok: false, reason: "conditions" });
      expect(await runAs(other.id, auto, lead)).toEqual({ ok: false, reason: "not_found" });
      expect(await runAs(viewer.id, auto, lead)).toEqual({ ok: false, reason: "not_found" });
      expect(await runAs(outsider.id, auto, lead)).toEqual({ ok: false, reason: "not_found" });
      expect(await runAs(outsider.id, auto, lead, otherOrg)).toEqual({ ok: false, reason: "not_found" });
      // a rule that is not manual, or switched off, or a record in the bin
      const created = await rule("lead", "created");
      expect(await runAs(member.id, created, lead)).toEqual({ ok: false, reason: "not_found" });
      await own((q) => q("update public.automations set is_active = false where id = $1", [auto]));
      expect(await runAs(member.id, auto, lead)).toEqual({ ok: false, reason: "not_found" });
      await own((q) => q("update public.automations set is_active = true where id = $1", [auto]));
      await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
      expect(await runAs(member.id, auto, lead)).toEqual({ ok: false, reason: "not_found" });
      expect(await runs(auto, lead)).toBe(2);
    });

    it("counts toward the plan's monthly runs and stops with them; a failed run is never retried", async () => {
      const orgQ = await newOrg("עסק מכסה");
      const auto = await rule("contact", "manual", {}, [], orgQ);
      // no owner: "notify the owner" fails, so the run fails
      const contact = await asUser(ownerOf(orgQ), async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'מכסה', null) returning id", [orgQ])).id);
      await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [contact]));
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = $2 where organization_id = $1", [orgQ, JSON.stringify({ max_automation_runs_per_month: 10 })]));
      const counted = () =>
        asAdmin(async (q) => (await one<{ n: number | null }>(q, "select (select runs from app.automation_run_months where organization_id = $1 and month = app.automation_run_month($1)) as n", [orgQ])).n ?? 0);
      expect(await runAs(ownerOf(orgQ), auto, contact, orgQ)).toEqual({ ok: true, status: "failed" });
      expect(await counted()).toBe(1);
      expect(await asAdmin((q) => one<{ next_retry_at: string | null }>(q, "select next_retry_at from public.automation_runs where automation_id = $1", [auto]))).toEqual({ next_retry_at: null });
      await asAdmin((q) => q("update app.automation_run_months set runs = 11, warned_80_at = now(), warned_100_at = now() where organization_id = $1 and month = app.automation_run_month($1)", [orgQ]));
      expect(await runAs(ownerOf(orgQ), auto, contact, orgQ)).toEqual({ ok: false, reason: "limit", detail: "quota" });
    });

    it("stops at 20 runs of the rule on the record a day", async () => {
      const auto = await rule("contact", "manual");
      const contact = await own(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'הרבה') returning id", [org])).id);
      for (let i = 0; i < 20; i += 1) expect((await runAs(owner.id, auto, contact)).ok).toBe(true);
      expect(await runAs(owner.id, auto, contact)).toEqual({ ok: false, reason: "limit", detail: "daily" });
    });

    it("only signed-in people may call the card's functions: not anon, not the service role", async () => {
      const grants = await asAdmin(async (q) =>
        (
          await q<{ name: string; anon: boolean; service: boolean; auth: boolean }>(
            `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('service_role', p.oid, 'execute') as service,
                    has_function_privilege('authenticated', p.oid, 'execute') as auth
               from pg_proc p join pg_namespace s on s.oid = p.pronamespace
              where s.nspname = 'public' and p.proname in ('manual_automations', 'run_manual_automation') order by 1`,
          )
        ).rows,
      );
      expect(grants).toEqual([
        { name: "manual_automations", anon: false, service: false, auth: true },
        { name: "run_manual_automation", anon: false, service: false, auth: true },
      ]);
    });
  });
});
