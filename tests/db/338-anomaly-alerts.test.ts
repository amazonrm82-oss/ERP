import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultLeadStatus, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Notice = { user_id: string; title: string; body: string; entity_type: string; entity_id: string };

// MNY-04: app.send_anomaly_alerts (pg_cron crm-anomaly-alerts). Every run below passes a fixed "now":
// Wednesday 11 November 2026, 10:00 in Asia/Jerusalem (the default calendar rests on Friday and Saturday).
const NOW = "2026-11-11 10:00:00+02";
const DAY = 24 * 3600 * 1000;
/** A time `days` days before NOW (fractional days allowed), as an ISO string. */
const ago = (days: number) => new Date(new Date(NOW).getTime() - days * DAY).toISOString();

describe("anomaly alerts (MNY-04)", () => {
  let owner: U;
  let admin: U;
  let org: string;

  const raw = (sql: string, params: unknown[]) =>
    asAdmin(async (q) => {
      // the triggers keep created_at and stamp the actor: write the history with them off
      await q("set local session_replication_role = replica");
      const r = await q<{ id: string }>(sql, params);
      await q("set local session_replication_role = origin");
      return r.rows[0]?.id;
    });
  const statusOf = (orgId: string) => defaultLeadStatus(orgId);
  const lead = async (orgId: string, at: string, fields: { source_id?: string; campaign?: string; import_job_id?: string } = {}) =>
    raw(
      "insert into public.leads (organization_id, status_id, full_name, source_id, campaign, import_job_id, created_at, updated_at) values ($1, $2, 'פנייה', $3, $4, $5, $6, $6) returning id",
      [orgId, await statusOf(orgId), fields.source_id ?? null, fields.campaign ?? null, fields.import_job_id ?? null, at],
    );
  const run = (orgs: string[], now = NOW) =>
    asAdmin(async (q) => (await q<{ n: number }>("select app.send_anomaly_alerts($1, $2::timestamptz) as n", [orgs, now])).rows[0].n);
  const notices = (orgId: string, entity: string) =>
    asAdmin(async (q) =>
      (
        await q<Notice>(
          "select user_id, title, body, entity_type, entity_id from public.notifications where organization_id = $1 and entity_type = $2 order by created_at, user_id",
          [orgId, entity],
        )
      ).rows,
    );
  const source = (orgId: string, name: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, $2) returning id", [orgId, name])).rows[0].id);
  const backdateMembership = (orgId: string, userId: string, days: number) =>
    raw("update public.memberships set created_at = $3 where organization_id = $1 and user_id = $2 returning id", [orgId, userId, ago(days)]);
  const audit = (orgId: string, actor: string, at: string, entity = "leads") =>
    raw("insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, created_at) values ($1, $2, 'update', $4, gen_random_uuid(), $3) returning id::text", [orgId, actor, at, entity]);
  // a new owner per business: one person owns at most 5
  const newOrg = async (name: string) => {
    const o = await createUser("owner");
    return { owner: o, org: await createOrg(o.id, name) };
  };
  // a regular source: 5 leads a week in each of the 4 weeks of days -35..-8
  const regularSource = async (orgId: string, name: string) => {
    const s = await source(orgId, name);
    for (let week = 0; week < 4; week++) for (let i = 0; i < 5; i++) await lead(orgId, ago(34 - week * 7 - i * 0.5), { source_id: s });
    return s;
  };
  const drops = (orgId: string, today = "2026-11-11") =>
    asAdmin(async (q) =>
      (await q<{ s: string }>("select s::text from app.anomaly_lead_drops($1, $2::date, 'Asia/Jerusalem') s", [orgId, today])).rows.map((r) => r.s),
    );

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id, "עסק חריגות");
    admin = await addMember(org, owner.id, "admin");
    await addMember(org, owner.id, "member");
  });

  it("no client role may run the job or its parts", async () => {
    for (const fn of [
      "app.send_anomaly_alerts($1::uuid[], now())",
      "app.anomaly_lead_drops($1::uuid, current_date, 'UTC')",
      "app.anomaly_alert_notify($1::uuid, 'lead_drop', current_date, 'UTC', array['x'])",
      "app.anomaly_person_changes($1::uuid, $1::uuid, now(), now(), 1)",
    ]) {
      const err = await pgError(asUser(owner.id, (q) => q(`select ${fn}`, [fn.startsWith("app.send") ? [org] : org])));
      expect(err.code).toBe("42501");
    }
  });

  it("a sharp drop in a regular source tells the owners and admins once, with a count only", async () => {
    const steady = await source(org, "מקור יציב");
    const falling = await source(org, "מקור שיורד");
    const once = await source(org, "מקור חד-פעמי");
    // days -35..-8 are four weeks: six leads a week in each for the two regular sources
    for (let week = 0; week < 4; week++) {
      for (let i = 0; i < 6; i++) {
        const at = ago(34 - week * 7 - i * 0.5);
        await lead(org, at, { source_id: steady });
        await lead(org, at, { source_id: falling });
      }
    }
    // a source with 24 leads all in one week is not regular
    for (let i = 0; i < 24; i++) await lead(org, ago(20 - i * 0.1), { source_id: once });
    // the last 7 days: steady 3 (3 * 8 = 24, not below the 4 weeks' 24), falling 2 (below)
    for (let i = 0; i < 3; i++) await lead(org, ago(2 + i), { source_id: steady });
    for (let i = 0; i < 2; i++) await lead(org, ago(2 + i), { source_id: falling });
    expect(await drops(org)).toEqual([falling]);

    // the job tells the owner and the admin (not the member), with a count and nothing else
    expect(await run([org])).toBe(1);
    const got = await notices(org, "anomaly_lead_drop");
    expect(got.map((n) => n.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect(got[0].title).toBe("ירידה חדה בפניות ממקור קבוע");
    expect(got[0].body).toBe("מקור אחד: ב-7 הימים האחרונים הגיעו ממנו פחות ממחצית הממוצע השבועי של 4 השבועות שלפניהם");
    expect(got[0].entity_id).toBe(org);
    // nothing personal: no source name in the notice
    expect(JSON.stringify(got)).not.toContain("מקור שיורד");

    // once a day: a second run the same day serves nothing new
    expect(await run([org])).toBe(0);
    // the next day the source still drops, but it was told this week
    expect(await run([org], "2026-11-12 10:00:00+02")).toBe(1);
    expect(await notices(org, "anomaly_lead_drop")).toHaveLength(2);
  });

  it("leaves out imported and sample leads", async () => {
    const other = await newOrg("עסק ייבוא");
    const s = await regularSource(other.org, "מקור");
    const job = await raw(
      "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, created_by) values ($1, 'lead', 'x.csv', 'skip', $2) returning id",
      [other.org, other.owner.id],
    );
    // recent leads that would hide the drop, but imported or sample data
    for (let i = 0; i < 5; i++) {
      const id = await lead(other.org, ago(1 + i * 0.2), { source_id: s });
      await raw("insert into app.sample_records (organization_id, lead_id, snapshot) values ($1, $2, '{}') returning id::text", [other.org, id]);
    }
    for (let i = 0; i < 5; i++) await lead(other.org, ago(1 + i * 0.2), { source_id: s, import_job_id: job });
    expect(await drops(other.org)).toEqual([s]);
  });

  it("does not compare a week with fewer working days, and looks at no lead while leads are off", async () => {
    const shop = await newOrg("עסק חג");
    await regularSource(shop.org, "מקור");
    expect(await run([shop.org])).toBe(1);
    expect(await notices(shop.org, "anomaly_lead_drop")).toHaveLength(1);

    // Wednesday 23 September 2026: the last 7 days hold Yom Kippur (Monday 21), so 4 working days against 5 in the fullest
    // week before; the same drop is not compared
    const holidayNow = "2026-09-23 10:00:00+03";
    const before = (days: number) => new Date(new Date(holidayNow).getTime() - days * DAY).toISOString();
    const holiday = await newOrg("עסק בחג");
    const s = await source(holiday.org, "מקור");
    for (let week = 0; week < 4; week++) for (let i = 0; i < 5; i++) await lead(holiday.org, before(34 - week * 7 - i * 0.5), { source_id: s });
    expect(await drops(holiday.org, "2026-09-23")).toEqual([s]);
    const fullWeek = (orgId: string, day: string) =>
      asAdmin(async (q) => (await q<{ f: boolean }>("select app.anomaly_full_week($1, $2::date) as f", [orgId, day])).rows[0].f);
    expect(await fullWeek(holiday.org, "2026-09-23")).toBe(false);
    expect(await fullWeek(holiday.org, "2026-11-11")).toBe(true);
    expect(await run([holiday.org], holidayNow)).toBe(1);
    expect(await notices(holiday.org, "anomaly_lead_drop")).toHaveLength(0);

    // leads off (LEAD-08): the job reads no lead
    const off = await newOrg("עסק בלי לידים");
    await regularSource(off.org, "מקור");
    await asAdmin((q) =>
      q("insert into public.org_modules (organization_id, leads_enabled) values ($1, false) on conflict (organization_id) do update set leads_enabled = false", [off.org]),
    );
    expect(await run([off.org])).toBe(1);
    expect(await notices(off.org, "anomaly_lead_drop")).toHaveLength(0);
  });

  it("finds a member who stopped changing records in their own last 3 working days", async () => {
    const team = await newOrg("עסק צוות");
    const idle = await addMember(team.org, team.owner.id, "member", "idle");
    const busy = await addMember(team.org, team.owner.id, "member", "busy");
    const away = await addMember(team.org, team.owner.id, "member", "away");
    const partTime = await addMember(team.org, team.owner.id, "member", "part");
    const payer = await addMember(team.org, team.owner.id, "manager", "payer");
    const sender = await addMember(team.org, team.owner.id, "member", "sender");
    const fresh = await addMember(team.org, team.owner.id, "manager", "fresh");
    const viewer = await addMember(team.org, team.owner.id, "viewer", "viewer");
    const all = [idle, busy, away, partTime, payer, sender, fresh, viewer];
    for (const u of all) await backdateMembership(team.org, u.id, 90);
    await backdateMembership(team.org, fresh.id, 10);
    for (const u of all) for (let i = 0; i < 6; i++) await audit(team.org, u.id, ago(20 + i));
    const idleOf = () =>
      asAdmin(async (q) =>
        (await q<{ u: string }>("select u::text from app.anomaly_idle_reps($1, date '2026-11-11', 'Asia/Jerusalem') u", [team.org])).rows.map((r) => r.u).sort(),
      );
    // with no change in the window (the business's Sun 8, Mon 9 and Tue 10 November), every member and manager with a
    // history who joined more than 14 days before is idle; the viewer and the new manager are not
    expect(await idleOf()).toEqual([idle, busy, away, partTime, payer, sender].map((u) => u.id).sort());

    // an activity logged on Monday 9 November
    const subject = await lead(team.org, ago(40));
    await raw(
      "insert into public.activities (organization_id, lead_id, type, body, created_by, created_at, occurred_at) values ($1, $4, 'note', 'x', $2, $3, $3) returning id",
      [team.org, busy.id, ago(2), subject],
    );
    // a payment recorded (audited as payments) on Tuesday 10 November
    await audit(team.org, payer.id, ago(1), "payments");
    // a message queued from a record card on Sunday 8 November
    await raw(
      "insert into app.jobs (organization_id, kind, payload, created_at) values ($1, 'message.send', jsonb_build_object('channel', 'sms', 'message_type', 'requested_document', 'lead_id', gen_random_uuid(), 'sent_by_user_id', $2::text), $3) returning id",
      [team.org, sender.id, "2026-11-08 11:00:00+02"],
    );
    // away is on leave on Monday and Tuesday: their last 3 working days are Wed 4, Thu 5 and Sun 8 November, and they
    // changed a record on Thursday
    await raw("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-11-09', '2026-11-10') returning id", [team.org, away.id]);
    await audit(team.org, away.id, "2026-11-05 10:00:00+02", "contacts");
    // part time works on Sunday and Monday only (CAP-09 hours): their window is Mon 2, Sun 8 and Mon 9 November, and they
    // changed a task on Monday 2 November
    await raw(
      `update public.profiles set working_hours = '{"sun": {"start": "09:00", "end": "17:00"}, "mon": {"start": "09:00", "end": "17:00"}}' where id = $1 returning id`,
      [partTime.id],
    );
    await audit(team.org, partTime.id, "2026-11-02 10:00:00+02", "tasks");
    expect(await idleOf()).toEqual([idle.id]);

    // a change on Sunday 8 November is inside the window too (Friday and Saturday are rest days)
    await audit(team.org, idle.id, "2026-11-08 09:00:00+02", "deals");
    expect(await idleOf()).toEqual([]);
  });

  it("skips idle people while the business was not writable during their window", async () => {
    const team = await newOrg("עסק שחזר");
    const idle = await addMember(team.org, team.owner.id, "member", "idle");
    await backdateMembership(team.org, idle.id, 90);
    for (let i = 0; i < 6; i++) await audit(team.org, idle.id, ago(20 + i));
    const idleOf = () =>
      asAdmin(async (q) =>
        (await q<{ u: string }>("select u::text from app.anomaly_idle_reps($1, date '2026-11-11', 'Asia/Jerusalem') u", [team.org])).rows.map((r) => r.u),
      );
    expect(await idleOf()).toEqual([idle.id]);
    // a trial that became active on Monday 9 November stayed writable: the person is still idle
    await raw(
      `insert into public.audit_log (organization_id, action, entity_type, entity_id, changes, created_at) values ($1, 'update', 'organizations', $1, '{"status": {"old": "trial", "new": "active"}}', $2) returning id::text`,
      [team.org, "2026-11-09 11:00:00+02"],
    );
    expect(await idleOf()).toEqual([idle.id]);
    // the business came back from read-only on Monday 9 November
    await raw(
      `insert into public.audit_log (organization_id, action, entity_type, entity_id, changes, created_at) values ($1, 'update', 'organizations', $1, '{"status": {"old": "read_only", "new": "active"}}', $2) returning id::text`,
      [team.org, "2026-11-09 12:00:00+02"],
    );
    expect(await idleOf()).toEqual([]);
  });

  // review 2: each message-job check of app.anomaly_person_changes is answered by its partial sender index (never a scan of
  // the whole queue): the conditions are read from the function itself and explained with sequential scans off
  it("reads the message jobs through their partial sender indexes", async () => {
    const def = await asAdmin(async (q) =>
      (await q<{ d: string }>("select pg_get_functiondef('app.anomaly_person_changes(uuid, uuid, timestamptz, timestamptz, integer)'::regprocedure) as d")).rows[0].d,
    );
    // any of the queue's partial message indexes will do (the planner may pick jobs_record_email_idx over
    // jobs_record_email_sender_idx on a small table); what matters is an index on app.jobs and never a full scan
    for (const key of ["reply_to_user_id", "sent_by_user_id", "pressed_by_user_id"]) {
      const found = [...def.matchAll(/exists \((select 1 from app\.jobs j[\s\S]*?and j\.created_at < p_to)\)/g)].map((m) => m[1]).filter((t) => t.includes(`'${key}'`));
      expect(found, key).toHaveLength(1);
      const sql = found[0].replace(/p_org/g, "$1::uuid").replace(/p_user/g, "$2::uuid").replace(/p_from/g, "$3::timestamptz").replace(/p_to/g, "$4::timestamptz");
      const plan = await asAdmin(async (q) => {
        await q("set local enable_seqscan = off");
        return (await q<{ "QUERY PLAN": string }>(`explain ${sql}`, [org, owner.id, ago(30), NOW])).rows.map((r) => r["QUERY PLAN"]).join("\n");
      });
      expect(plan, key).toMatch(/(Index Scan|Index Only Scan|Bitmap Index Scan) (Backward )?(using|on) jobs_record_\w+/);
      expect(plan, key).not.toMatch(/Seq Scan/);
    }
  });

  it("finds a web form or webhook that took inquiries every week and stopped", async () => {
    const make = async (name: string) => {
      const id = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.forms (organization_id, name) values ($1, $2) returning id", [org, name])).rows[0].id);
      await raw("update public.forms set created_at = $2 where id = $1 returning id", [id, ago(60)]);
      return id;
    };
    const stopped = await make("טופס שנעצר");
    const alive = await make("טופס חי");
    const spammed = await make("טופס ספאם");
    const hook = await make("חיבור שנעצר");
    const widget = await make("ווידג'ט שנעצר");
    await raw("update public.forms set kind = 'webhook' where id = $1 returning id", [hook]);
    // a site widget's form is not listed on the intake settings: never told (the widget row itself is not needed here)
    await raw("update public.forms set kind = 'widget', site_widget_id = gen_random_uuid() where id = $1 returning id", [widget]);
    const sub = (form: string, at: string, st = "accepted") =>
      raw("insert into public.form_submissions (organization_id, form_id, status, created_at) values ($1, $2, $3, $4) returning id", [org, form, st, at]);
    for (const f of [stopped, alive, spammed, hook, widget]) for (let week = 0; week < 4; week++) await sub(f, ago(33 - week * 7));
    await sub(alive, ago(3));
    // only spam in the last week: still stopped
    await sub(spammed, ago(3), "spam");
    const forms = await asAdmin(async (q) =>
      (await q<{ f: string }>("select f::text from app.anomaly_quiet_forms($1, date '2026-11-11', 'Asia/Jerusalem') f", [org])).rows.map((r) => r.f),
    );
    expect(forms.sort()).toEqual([stopped, spammed, hook].sort());
    await raw("update public.forms set kind = 'form', site_widget_id = null, is_active = false where id = $1 returning id", [widget]);
  });

  it("tells about a campaign whose cost per lead at least doubled once per month and key, only with the plan key", async () => {
    const shop = await newOrg("עסק קמפיינים");
    const cost = (campaign: string, month: string, agorot: number) =>
      raw("insert into public.campaign_costs (organization_id, campaign, month, amount_agorot) values ($1, $2, $3, $4) returning id", [shop.org, campaign, month, agorot]);
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"campaign_costs\": true}' where organization_id = $1", [shop.org]),
    );
    const job = await raw(
      "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, created_by) values ($1, 'lead', 'x.csv', 'skip', $2) returning id",
      [shop.org, shop.owner.id],
    );
    for (const [month, day] of [["2026-07-01", "2026-07-15"], ["2026-08-01", "2026-08-15"], ["2026-09-01", "2026-09-15"], ["2026-10-01", "2026-10-15"]]) {
      await cost("Summer", month, 100000);
      await cost("Steady", month, 100000);
      // Summer: 5 leads a month until September, 2 in October (cost per lead 200, then 500)
      for (let i = 0; i < (month === "2026-10-01" ? 2 : 5); i++) await lead(shop.org, `${day} 12:00:00+03`, { campaign: " summer " });
      for (let i = 0; i < 5; i++) await lead(shop.org, `${day} 12:00:00+03`, { campaign: "Steady" });
    }
    // imported October leads do not hide the jump (unlike report_campaign_roi, which counts them)
    for (let i = 0; i < 5; i++) await lead(shop.org, "2026-10-16 12:00:00+03", { campaign: "Summer", import_job_id: job });
    const keys = await asAdmin(async (q) =>
      (await q<{ k: string }>("select k from app.anomaly_campaign_jumps($1, date '2026-11-11', 'Asia/Jerusalem') k", [shop.org])).rows.map((r) => r.k),
    );
    expect(keys).toEqual(["|summer|2026-10"]);

    expect(await run([shop.org])).toBe(1);
    const got = await notices(shop.org, "anomaly_campaign_jump");
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe("קמפיין או מקור אחד: בחודש שעבר העלות לפנייה הייתה לפחות כפולה מהממוצע של 3 החודשים שלפניו");
    expect(JSON.stringify(got)).not.toContain("ummer");
    // the next week the same month's jump is not told again
    expect(await run([shop.org], "2026-11-18 10:00:00+02")).toBe(1);
    expect(await run([shop.org], "2026-11-25 10:00:00+02")).toBe(1);
    expect(await notices(shop.org, "anomaly_campaign_jump")).toHaveLength(1);

    // without the plan key the job does not look at costs
    const plain = await newOrg("עסק בלי עלויות");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"campaign_costs\": false}' where organization_id = $1", [plain.org]),
    );
    await raw("insert into public.campaign_costs (organization_id, campaign, month, amount_agorot) values ($1, 'X', '2026-10-01', 5000) returning id", [plain.org]);
    expect(await run([plain.org])).toBe(1);
    expect(await notices(plain.org, "anomaly_campaign_jump")).toHaveLength(0);
  });

  it("a target is told at most once a week; a later one the same week is told as further", async () => {
    const quiet = await newOrg("עסק שבועי");
    // this week (the real one) and the next, so the sent rows' times fall in their week
    const week = await asAdmin(async (q) =>
      (await q<{ w: string }>("select to_char(current_date - extract(dow from current_date)::int, 'YYYY-MM-DD') as w")).rows[0].w,
    );
    const notify = (keys: string[], w = week) =>
      asAdmin(async (q) =>
        (await q<{ n: number }>("select app.anomaly_alert_notify($1, 'quiet_form', $2::date, 'UTC', $3) as n", [quiet.org, w, keys])).rows[0].n,
      );
    expect(await notify(["a", "b"])).toBe(2);
    expect(await notify(["a", "b"])).toBe(0);
    expect(await notify(["a", "c"])).toBe(1);
    expect(await notify(["d", "e"])).toBe(2);
    const got = (await notices(quiet.org, "anomaly_quiet_form")).map((n) => n.body);
    expect(got).toEqual([
      "2 טפסים לא קיבלו אף פנייה ב-7 הימים האחרונים, אחרי שקיבלו פניות קבועות בחודש שלפני",
      "טופס נוסף לא קיבל אף פנייה ב-7 הימים האחרונים, אחרי שקיבל פניות קבועות בחודש שלפני",
      "2 טפסים נוספים לא קיבלו אף פנייה ב-7 הימים האחרונים, אחרי שקיבלו פניות קבועות בחודש שלפני",
    ]);
  });

  it("runs from 08:00 in the business's zone, for writable businesses only", async () => {
    const a = await newOrg("עסק א");
    const b = await newOrg("עסק ב");
    // 07:59 in Israel: not yet
    expect(await run([a.org, b.org], "2026-11-11 07:59:00+02")).toBe(0);
    // read-only is not writable
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [b.org]));
    expect(await run([a.org, b.org])).toBe(1);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [b.org]));
    expect(await run([b.org])).toBe(1);
  });

  it("serves the business served longest ago first, and stops at the limit and at the time budget", async () => {
    // d was served yesterday, e two days ago, f never: one business a run, f first, then e, then d
    const d = await newOrg("עסק תור ד");
    const e = await newOrg("עסק תור ה");
    const f = await newOrg("עסק תור ו");
    await raw("insert into app.anomaly_alert_days (organization_id, day, done_at, last_attempt_at) values ($1, '2026-11-10', $2, $2) returning day::text", [d.org, "2026-11-10 08:00:00+02"]);
    await raw("insert into app.anomaly_alert_days (organization_id, day, done_at, last_attempt_at) values ($1, '2026-11-09', $2, $2) returning day::text", [e.org, "2026-11-09 08:00:00+02"]);
    const servedToday = () =>
      asAdmin(async (q) =>
        (await q<{ o: string }>("select organization_id::text as o from app.anomaly_alert_days where organization_id = any($1) and day = '2026-11-11'", [[d.org, e.org, f.org]])).rows.map((r) => r.o),
      );
    const one = () =>
      asAdmin(async (q) => {
        await q("set local app.anomaly_alert_limit = '1'");
        return (await q<{ n: number }>("select app.send_anomaly_alerts($1, $2::timestamptz) as n", [[d.org, e.org, f.org], NOW])).rows[0].n;
      });
    expect(await one()).toBe(1);
    expect(await servedToday()).toEqual([f.org]);
    expect(await one()).toBe(1);
    expect((await servedToday()).sort()).toEqual([f.org, e.org].sort());
    expect(await one()).toBe(1);
    expect((await servedToday()).sort()).toEqual([d.org, e.org, f.org].sort());

    // a time budget of 0: a run serves one business and stops
    const g = await newOrg("עסק תקציב א");
    const h = await newOrg("עסק תקציב ב");
    const budget = await asAdmin(async (q) => {
      await q("set local app.anomaly_alert_budget_ms = '0'");
      return (await q<{ n: number }>("select app.send_anomaly_alerts($1, $2::timestamptz) as n", [[g.org, h.org], NOW])).rows[0].n;
    });
    expect(budget).toBe(1);
    expect(await run([g.org, h.org])).toBe(1);
  });

  it("a business that fails is tried again, and after 3 failures in a day it waits for the next day", async () => {
    const shop = await newOrg("עסק תקלה");
    const warnings: string[] = [];
    const client = new Client({ connectionString: TEST_DB_URL });
    client.on("notice", (n) => warnings.push(n.message ?? ""));
    await client.connect();
    try {
      await client.query("begin");
      // only inside this transaction, rolled back below
      await client.query(`create or replace function app.anomaly_quiet_forms(p_org uuid, p_today date, p_zone text) returns setof uuid
                          language plpgsql stable set search_path = '' as $f$
                          begin raise exception 'refused by the test' using errcode = 'P0001'; end $f$`);
      const runOnce = async (now = NOW) =>
        (await client.query<{ n: number }>("select app.send_anomaly_alerts($1, $2::timestamptz) as n", [[shop.org], now])).rows[0].n;
      for (let i = 0; i < 3; i++) expect(await runOnce()).toBe(0);
      const row = (await client.query<{ failures: number; done: boolean }>(
        "select failures, done_at is not null as done from app.anomaly_alert_days where organization_id = $1 and day = '2026-11-11'",
        [shop.org],
      )).rows[0];
      expect(row).toEqual({ failures: 3, done: false });
      // skipped for the rest of the day: not even tried
      expect(await runOnce()).toBe(0);
      expect((await client.query<{ failures: number }>("select failures from app.anomaly_alert_days where organization_id = $1 and day = '2026-11-11'", [shop.org])).rows[0].failures).toBe(3);
      // the next day it is tried again
      await runOnce("2026-11-12 10:00:00+02");
      expect((await client.query<{ failures: number }>("select failures from app.anomaly_alert_days where organization_id = $1 and day = '2026-11-12'", [shop.org])).rows[0].failures).toBe(1);
    } finally {
      await client.query("rollback");
      await client.end();
    }
    expect(warnings.filter((w) => w === `crm-anomaly-alerts: organization ${shop.org} failed (SQLSTATE P0001)`)).toHaveLength(4);
  });

  // MNY-04, owner (285) ג: a switch and a threshold per alert (public.anomaly_alert_settings; no row = all on, 021228's numbers)
  const settings = (orgId: string, set: string) =>
    asAdmin(async (q) => {
      await q("insert into public.anomaly_alert_settings (organization_id) values ($1) on conflict (organization_id) do nothing", [orgId]);
      await q(`update public.anomaly_alert_settings set ${set} where organization_id = $1`, [orgId]);
    });
  const idleOf = (orgId: string) =>
    asAdmin(async (q) =>
      (await q<{ u: string }>("select u::text from app.anomaly_idle_reps($1, date '2026-11-11', 'Asia/Jerusalem') u", [orgId])).rows.map((r) => r.u).sort(),
    );
  // a person with a history 20..25 days ago and nothing in the last working days
  const history = async (orgId: string, userId: string) => {
    await backdateMembership(orgId, userId, 90);
    for (let i = 0; i < 6; i++) await audit(orgId, userId, ago(20 + i));
  };

  it("(285) ג: no row means every alert on with the default numbers", async () => {
    const shop = await newOrg("עסק ברירת מחדל");
    const cfg = await asAdmin(async (q) =>
      (
        await q(
          `select s.lead_drop_on, s.lead_drop_percent, s.idle_rep_on, s.idle_rep_days, s.quiet_form_on, s.quiet_form_min_inquiries,
                  s.campaign_jump_on, s.campaign_jump_percent from app.anomaly_settings_of($1) s`,
          [shop.org],
        )
      ).rows[0],
    );
    expect(cfg).toEqual({
      lead_drop_on: true, lead_drop_percent: 50, idle_rep_on: true, idle_rep_days: 3,
      quiet_form_on: true, quiet_form_min_inquiries: 4, campaign_jump_on: true, campaign_jump_percent: 100,
    });
    // the defaults of a saved row are the same numbers
    await settings(shop.org, "idle_rep_on = true");
    const row = await asAdmin(async (q) =>
      (await q("select lead_drop_percent, idle_rep_days, quiet_form_min_inquiries, campaign_jump_percent from public.anomaly_alert_settings where organization_id = $1", [shop.org])).rows[0],
    );
    expect(row).toEqual({ lead_drop_percent: 50, idle_rep_days: 3, quiet_form_min_inquiries: 4, campaign_jump_percent: 100 });
    expect((await pgError(asUser(owner.id, (q) => q("select app.anomaly_settings_of($1)", [org])))).code).toBe("42501");
  });

  it("(285) ג: a switched-off alert is not looked for; the idle days and their wording follow the business", async () => {
    const team = await newOrg("עסק מתגים");
    const idle = await addMember(team.org, team.owner.id, "member", "idle");
    await history(team.org, idle.id);
    await settings(team.org, "idle_rep_on = false");
    expect(await run([team.org])).toBe(1);
    expect(await notices(team.org, "anomaly_idle_rep")).toHaveLength(0);
    // one working day: a change on Monday 9 November no longer counts (the window is Tuesday 10 only)
    await audit(team.org, idle.id, "2026-11-09 10:00:00+02");
    expect(await idleOf(team.org)).toEqual([]);
    await settings(team.org, "idle_rep_on = true, idle_rep_days = 1");
    expect(await idleOf(team.org)).toEqual([idle.id]);
    expect(await run([team.org], "2026-11-12 10:00:00+02")).toBe(1);
    // Thursday 12: the last working day is Wednesday 11, also without a change
    const got = await notices(team.org, "anomaly_idle_rep");
    expect(got.map((n) => n.body)).toEqual(["חבר צוות אחד לא עדכן אף רשומה ביום העבודה האחרון שלו"]);
    await settings(team.org, "idle_rep_days = 5");
    expect(await idleOf(team.org)).toEqual([]);
  });

  it("(285) ג: the lead drop percent, the form's inquiries and the campaign percent are the business's", async () => {
    const shop = await newOrg("עסק ספים");
    const s = await regularSource(shop.org, "מקור");
    // 5 a week before; 2 in the last 7 days: fewer than half (2.5), not fewer than 30% (1.5)
    for (let i = 0; i < 2; i++) await lead(shop.org, ago(2 + i), { source_id: s });
    expect(await drops(shop.org)).toEqual([s]);
    await settings(shop.org, "lead_drop_percent = 70");
    expect(await drops(shop.org)).toEqual([]);
    await settings(shop.org, "lead_drop_percent = 30");
    expect(await drops(shop.org)).toEqual([s]);
    // switched off: the job does not tell it
    await settings(shop.org, "lead_drop_on = false");
    expect(await run([shop.org])).toBe(1);
    expect(await notices(shop.org, "anomaly_lead_drop")).toHaveLength(0);

    // a form with 2 inquiries in two of the four weeks: regular only from 2
    const form = await asUser(shop.owner.id, async (q) => (await q<{ id: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס קטן') returning id", [shop.org])).rows[0].id);
    await raw("update public.forms set created_at = $2 where id = $1 returning id", [form, ago(60)]);
    for (const d of [33, 19]) await raw("insert into public.form_submissions (organization_id, form_id, status, created_at) values ($1, $2, 'accepted', $3) returning id", [shop.org, form, ago(d)]);
    const quiet = () =>
      asAdmin(async (q) => (await q<{ f: string }>("select f::text from app.anomaly_quiet_forms($1, date '2026-11-11', 'Asia/Jerusalem') f", [shop.org])).rows.map((r) => r.f));
    expect(await quiet()).toEqual([]);
    await settings(shop.org, "quiet_form_min_inquiries = 2");
    expect(await quiet()).toEqual([form]);
    await settings(shop.org, "quiet_form_min_inquiries = 3");
    expect(await quiet()).toEqual([]);

    // the texts follow the numbers
    const week = await asAdmin(async (q) =>
      (await q<{ w: string }>("select to_char(current_date - extract(dow from current_date)::int, 'YYYY-MM-DD') as w")).rows[0].w,
    );
    await settings(shop.org, "lead_drop_percent = 70, campaign_jump_percent = 150");
    for (const kind of ["lead_drop", "campaign_jump"]) {
      await asAdmin((q) => q("select app.anomaly_alert_notify($1, $2, $3::date, 'UTC', array['k']) as n", [shop.org, kind, week]));
    }
    expect((await notices(shop.org, "anomaly_lead_drop")).map((n) => n.body)).toEqual([
      "מקור אחד: ב-7 הימים האחרונים הגיעו ממנו פחות מ-30% מהממוצע השבועי של 4 השבועות שלפניהם",
    ]);
    expect((await notices(shop.org, "anomaly_campaign_jump")).map((n) => n.body)).toEqual([
      "קמפיין או מקור אחד: בחודש שעבר העלות לפנייה הייתה גבוהה לפחות ב-150% מהממוצע של 3 החודשים שלפניו",
    ]);
  });

  it("(285) ג: the campaign percent decides the jump", async () => {
    const shop = await newOrg("עסק קפיצה");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"campaign_costs\": true}' where organization_id = $1", [shop.org]),
    );
    // 100,000 agorot a month; 5 leads a month, then 3 in October: cost per lead 200, then 333 (+67%)
    for (const [month, day] of [["2026-07-01", "2026-07-15"], ["2026-08-01", "2026-08-15"], ["2026-09-01", "2026-09-15"], ["2026-10-01", "2026-10-15"]]) {
      await raw("insert into public.campaign_costs (organization_id, campaign, month, amount_agorot) values ($1, 'Autumn', $2, 100000) returning id", [shop.org, month]);
      for (let i = 0; i < (month === "2026-10-01" ? 3 : 5); i++) await lead(shop.org, `${day} 12:00:00+03`, { campaign: "Autumn" });
    }
    const keys = () =>
      asAdmin(async (q) => (await q<{ k: string }>("select k from app.anomaly_campaign_jumps($1, date '2026-11-11', 'Asia/Jerusalem') k", [shop.org])).rows.map((r) => r.k));
    expect(await keys()).toEqual([]);
    await settings(shop.org, "campaign_jump_percent = 60");
    expect(await keys()).toEqual(["|autumn|2026-10"]);
    await settings(shop.org, "campaign_jump_on = false");
    expect(await run([shop.org])).toBe(1);
    expect(await notices(shop.org, "anomaly_campaign_jump")).toHaveLength(0);
  });

  it("(286) ב: an idle owner or admin is counted, and told only to the other owners and admins", async () => {
    const team = await newOrg("עסק בעלים");
    const second = await addMember(team.org, team.owner.id, "admin", "second");
    const member = await addMember(team.org, team.owner.id, "member", "worker");
    for (const u of [team.owner, second, member]) await history(team.org, u.id);
    // the admin changed a record on Tuesday 10 November: only the owner and the member are idle
    await audit(team.org, second.id, ago(1));
    expect(await idleOf(team.org)).toEqual([team.owner.id, member.id].sort());
    expect(await run([team.org])).toBe(1);
    const got = await notices(team.org, "anomaly_idle_rep");
    // the owner hears of the member only; the admin of both; the member nothing
    expect(got.map((n) => [n.user_id, n.body]).sort()).toEqual(
      [
        [team.owner.id, "חבר צוות אחד לא עדכן אף רשומה ב-3 ימי העבודה האחרונים שלו"],
        [second.id, "2 חברי צוות לא עדכנו אף רשומה ב-3 ימי העבודה האחרונים שלהם"],
      ].sort(),
    );

    // alone: an owner with nobody else to tell gets nothing about themself
    const solo = await newOrg("עסק לבד");
    await history(solo.org, solo.owner.id);
    expect(await idleOf(solo.org)).toEqual([solo.owner.id]);
    expect(await run([solo.org])).toBe(1);
    expect(await notices(solo.org, "anomaly_idle_rep")).toHaveLength(0);
    // the owner is still marked told for the week
    const told = await asAdmin(async (q) =>
      (await q<{ n: number }>("select count(*)::int as n from app.anomaly_alerts_sent where organization_id = $1 and kind = 'idle_rep'", [solo.org])).rows[0].n,
    );
    expect(told).toBe(1);

    // "further" is judged per recipient: an owner never told about anyone but themself hears of the next person as the first
    const week = await asAdmin(async (q) =>
      (await q<{ w: string }>("select to_char(current_date - extract(dow from current_date)::int, 'YYYY-MM-DD') as w")).rows[0].w,
    );
    const pair = await newOrg("עסק זוג");
    const partner = await addMember(pair.org, pair.owner.id, "admin", "partner");
    const notify = (keys: string[]) =>
      asAdmin(async (q) => (await q<{ n: number }>("select app.anomaly_alert_notify($1, 'idle_rep', $2::date, 'UTC', $3) as n", [pair.org, week, keys])).rows[0].n);
    expect(await notify([pair.owner.id])).toBe(1);
    expect(await notify(["someone-else"])).toBe(1);
    const bodies = (await notices(pair.org, "anomaly_idle_rep")).map((n) => [n.user_id, n.body]);
    expect(bodies.filter(([u]) => u === pair.owner.id).map(([, b]) => b)).toEqual(["חבר צוות אחד לא עדכן אף רשומה ב-3 ימי העבודה האחרונים שלו"]);
    expect(bodies.filter(([u]) => u === partner.id).map(([, b]) => b)).toEqual([
      "חבר צוות אחד לא עדכן אף רשומה ב-3 ימי העבודה האחרונים שלו",
      "חבר צוות נוסף לא עדכן אף רשומה ב-3 ימי העבודה האחרונים שלו",
    ]);
  });
});
