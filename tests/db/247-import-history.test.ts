import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = Record<string, unknown>;
type Note = { record_id: string; body: string; date?: string | null };

/**
 * GAP-12: history in an import. An import may carry each record's original creation date (`original_created_on`, a column
 * of its own: `created_at` stays the import time, so every timing rule keeps measuring from the import) and notes, written
 * by public.import_record_notes as 'import_note' timeline entries that are neither contact nor activity.
 */
describe("history in an import (GAP-12)", () => {
  let owner: U, admin: U, holder: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const newJob = (who: U, entity = "lead", mode = "skip", o = org) =>
    asUser(who.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows) values ($1, $2, 'history.csv', $3, 5) returning id",
          [o, entity, mode],
        )
      ).rows[0].id,
    );
  const finish = (who: U, job: string) => asUser(who.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
  const notes = (who: U, job: string, items: Note[], o = org) =>
    asUser(who.id, async (q) => (await q<{ r: string[] }>("select public.import_record_notes($1, $2, $3) as r", [o, job, JSON.stringify(items)])).rows[0].r);
  const notesOf = (column: string, id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Row>(
            `select type, body, created_by, to_char(occurred_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as at, metadata
               from public.activities where ${column} = $1 order by occurred_at`,
            [id],
          )
        ).rows,
    );
  // touch_row keeps created_at: back-dating is a test-only write with the triggers off
  const backdate = (table: string, id: string, days: number) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(`update public.${table} set created_at = now() - make_interval(days => $2) where id = $1`, [id, days]);
    });

  beforeAll(async () => {
    owner = await createUser("gh-owner");
    org = await createOrg(owner.id, "עסק עם היסטוריה");
    admin = await addMember(org, owner.id, "admin", "gh-admin");
    holder = await addMember(org, owner.id, "member", "gh-holder");
    member = await addMember(org, owner.id, "member", "gh-member");
    viewer = await addMember(org, owner.id, "viewer", "gh-viewer");
    outsider = await createUser("gh-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, holder.id, ["import"]]));
  });

  it("an import writes the original creation date; a person's own write never does", async () => {
    const job = await newJob(owner);
    const lead = await insertLead(owner.id, org, { full_name: "ותיק", import_job_id: job, original_created_on: "2012-03-04" });
    const stored = await asAdmin(
      async (q) =>
        (await q<{ d: string; fresh: boolean }>("select original_created_on::text as d, created_at > now() - interval '1 hour' as fresh from public.leads where id = $1", [lead]))
          .rows[0],
    );
    // created_at stays the import time
    expect(stored).toEqual({ d: "2012-03-04", fresh: true });

    // without an import, or out of range
    expect((await pgError(insertLead(owner.id, org, { full_name: "בלי ייבוא", original_created_on: "2012-03-04" }))).hint).toBe("import:original_date_fixed");
    expect((await pgError(insertLead(owner.id, org, { import_job_id: job, original_created_on: "1989-12-31" }))).hint).toBe("import:original_date");
    expect((await pgError(insertLead(owner.id, org, { import_job_id: job, original_created_on: "2999-01-01" }))).hint).toBe("import:original_date");
    // leads and contacts: no update grant; companies and deals (table grants): refused by the trigger
    expect((await pgError(asUser(owner.id, (q) => q("update public.leads set original_created_on = '2010-01-01' where id = $1", [lead])))).code).toBe("42501");

    const companyJob = await newJob(owner, "company");
    const company = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.companies (organization_id, name, import_job_id, original_created_on) values ($1, 'חברה ותיקה', $2, '2001-05-06') returning id",
          [org, companyJob],
        )
      ).rows[0].id,
    );
    expect((await pgError(asUser(owner.id, (q) => q("update public.companies set original_created_on = '2002-01-01' where id = $1", [company])))).hint).toBe(
      "import:original_date_fixed",
    );
    expect((await pgError(asUser(owner.id, (q) => q("update public.companies set original_created_on = null where id = $1", [company])))).hint).toBe(
      "import:original_date_fixed",
    );
    // a change of another column keeps it
    await asUser(owner.id, (q) => q("update public.companies set city = 'חיפה' where id = $1", [company]));
    expect(await asAdmin(async (q) => (await q<{ d: string }>("select original_created_on::text as d from public.companies where id = $1", [company])).rows[0].d)).toBe(
      "2001-05-06",
    );
    // a job of another type, or someone else's job, is not an import of this record (app.guard_import_tag)
    expect((await pgError(insertLead(admin.id, org, { import_job_id: job, original_created_on: "2012-03-04" }))).code).toBe("42501");
    expect(
      (
        await pgError(
          asUser(owner.id, (q) =>
            q("insert into public.companies (organization_id, name, import_job_id, original_created_on) values ($1, 'x', $2, '2001-05-06')", [org, job]),
          ),
        )
      ).code,
    ).toBe("42501");

    const dealJob = await newJob(owner, "deal", "create");
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, import_job_id, original_created_on) values ($1, 'עסקה ישנה', $2, $3, $4, '2015-07-08') returning id",
          [org, pipelineId, stages[0].id, dealJob],
        )
      ).rows[0].id,
    );
    expect((await pgError(asUser(owner.id, (q) => q("update public.deals set original_created_on = '2016-01-01' where id = $1", [deal])))).hint).toBe(
      "import:original_date_fixed",
    );
    const contactJob = await newJob(owner, "contact");
    await asUser(owner.id, (q) =>
      q("insert into public.contacts (organization_id, first_name, import_job_id, original_created_on) values ($1, 'רות', $2, '2018-01-02')", [org, contactJob]),
    );
    // a server write passes (no person)
    await asAdmin((q) => q("update public.companies set original_created_on = '2001-05-07' where id = $1", [company]));
  });

  it("notes are timeline entries by the importer, dated by the file, else by the original date, else now", async () => {
    const job = await newJob(owner);
    const lead = await insertLead(owner.id, org, { full_name: "עם הערות", import_job_id: job, original_created_on: "2014-02-03" });
    const plain = await insertLead(owner.id, org, { full_name: "בלי תאריך", import_job_id: job });
    const result = await notes(owner, job, [
      { record_id: lead, body: "  שיחה ראשונה  ", date: "2014-02-10" },
      { record_id: lead, body: "הערה בלי תאריך" },
      { record_id: plain, body: "היום" },
      { record_id: lead, body: "   " },
      { record_id: lead, body: "x".repeat(5001) },
      { record_id: lead, body: "תאריך עתידי", date: "2999-01-01" },
      { record_id: lead, body: "תאריך לא תקין", date: "2014-02-30" },
      { record_id: lead, body: "לפני 1990", date: "1989-01-01" },
      { record_id: "not-a-uuid", body: "x" },
    ]);
    expect(result).toEqual(["written", "written", "written", "invalid", "invalid", "invalid", "invalid", "invalid", "invalid"]);
    const meta = { kind: "import_note", import_job_id: job };
    const rows = await notesOf("lead_id", lead);
    expect(rows.map((r) => [r.body, r.at])).toEqual([
      ["הערה בלי תאריך", "2014-02-03 12:00"],
      ["שיחה ראשונה", "2014-02-10 12:00"],
    ]);
    expect(rows.every((r) => r.type === "import_note" && r.created_by === owner.id)).toBe(true);
    expect(rows[0].metadata).toEqual(meta);
    const today = await asAdmin(
      async (q) =>
        (await q<{ n: number }>("select count(*)::int as n from public.activities where lead_id = $1 and occurred_at > now() - interval '1 minute'", [plain])).rows[0].n,
    );
    expect(today).toBe(1);
  });

  it("only the caller's own running import, and only its records or (update mode) records the caller may edit", async () => {
    const job = await newJob(owner);
    const mine = await insertLead(owner.id, org, { full_name: "שלי", import_job_id: job });
    const existing = await insertLead(owner.id, org, { full_name: "קיים" });
    // a skip-mode job does not annotate a record it did not create
    expect(await notes(owner, job, [{ record_id: existing, body: "x" }])).toEqual(["refused"]);
    // a record of another business
    const foreign = await insertLead(outsider.id, otherOrg, { full_name: "זר" });
    expect(await notes(owner, job, [{ record_id: foreign, body: "x" }])).toEqual(["refused"]);
    // someone else's job, a viewer, an outsider, a member without the import permission, anon
    expect((await pgError(notes(admin, job, [{ record_id: mine, body: "x" }]))).code).toBe("42501");
    expect((await pgError(notes(viewer, job, [{ record_id: mine, body: "x" }]))).code).toBe("42501");
    expect((await pgError(notes(member, job, [{ record_id: mine, body: "x" }]))).code).toBe("42501");
    expect((await pgError(notes(outsider, job, [{ record_id: mine, body: "x" }]))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.import_record_notes($1, $2, '[]')", [org, job]))))).toMatchObject({ code: "42501" });
    // too many, or not an array
    const many = Array.from({ length: 1001 }, () => ({ record_id: mine, body: "x" }));
    expect((await pgError(notes(owner, job, many))).hint).toBe("import_note:too_many");
    expect(
      (await pgError(asUser(owner.id, (q) => q("select public.import_record_notes($1, $2, '{}')", [org, job])))).hint,
    ).toBe("import_note:items");
    // a finished job writes nothing
    await finish(owner, job);
    expect((await pgError(notes(owner, job, [{ record_id: mine, body: "x" }]))).code).toBe("42501");

    // an update-mode job annotates a record the caller may edit; the holder (member) only their own
    const update = await newJob(owner, "lead", "update");
    expect(await notes(owner, update, [{ record_id: existing, body: "מהמערכת הקודמת", date: "2019-09-09" }])).toEqual(["written"]);
    const holderJob = await newJob(holder, "lead", "update");
    const holders = await insertLead(holder.id, org, { full_name: "של המחזיק", owner_id: holder.id });
    expect(await notes(holder, holderJob, [{ record_id: existing, body: "x" }, { record_id: holders, body: "שלי" }])).toEqual(["refused", "written"]);
    // a person never writes an import note directly
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'import_note', 'x', $2)", [org, existing])))).code,
    ).toBe("42501");
  });

  it("running the file again adds no note twice; a note is never dated after now", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ייבוא חוזר" });
    const first = await newJob(owner, "lead", "update");
    expect(await notes(owner, first, [{ record_id: lead, body: "שיחה", date: "2018-05-05" }, { record_id: lead, body: "היום" }])).toEqual([
      "written",
      "written",
    ]);
    await finish(owner, first);
    const again = await newJob(owner, "lead", "update");
    expect(
      await notes(owner, again, [
        { record_id: lead, body: "שיחה", date: "2018-05-05" },
        { record_id: lead, body: "היום" },
        // another day or another text is a new note
        { record_id: lead, body: "שיחה", date: "2018-05-06" },
        { record_id: lead, body: "שיחה אחרת", date: "2018-05-05" },
      ]),
    ).toEqual(["exists", "exists", "written", "written"]);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and type = 'import_note'", [lead]))).toBe(4);
    // a note dated today is 12:00 of today at the latest, and never after now
    const today = await asAdmin(async (q) => (await q<{ d: string }>("select to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d")).rows[0].d);
    const third = await newJob(owner, "lead", "update");
    expect(await notes(owner, third, [{ record_id: lead, body: "מהיום", date: today }])).toEqual(["written"]);
    const late = await asAdmin((q) =>
      count(q, "select 1 from public.activities where lead_id = $1 and body = 'מהיום' and occurred_at <= now() and occurred_at >= least(now(), ($2::date + time '12:00') at time zone 'Asia/Jerusalem')", [lead, today]),
    );
    expect(late).toBe(1);
  });

  it("owners and admins remove a wrong import note; its author (a member) and others do not", async () => {
    const job = await newJob(holder, "lead", "update");
    const lead = await insertLead(holder.id, org, { full_name: "הערה שגויה", owner_id: holder.id });
    expect(await notes(holder, job, [{ record_id: lead, body: "טעות" }, { record_id: lead, body: "טעות שנייה", date: "2015-01-01" }])).toEqual([
      "written",
      "written",
    ]);
    const ids = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.activities where lead_id = $1 order by body", [lead])).rows.map((r) => r.id));
    const remove = (who: U, id: string) =>
      asUser(who.id, async (q) => (await q("delete from public.activities where id = $1 and type = 'import_note' returning id", [id])).rowCount);
    expect(await remove(holder, ids[0])).toBe(0);
    expect(await remove(member, ids[0])).toBe(0);
    expect(await remove(viewer, ids[0])).toBe(0);
    expect(await remove(admin, ids[0])).toBe(1);
    expect(await remove(owner, ids[1])).toBe(1);
    // the removal is in the audit log
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = any($1) and action = 'delete'", [ids]))).toBe(2);
  });

  it("a deal's last activity (stuck list, board, weekly cleanup) leaves out import notes", async () => {
    const { pipelineId, stages } = await defaultPipeline(org);
    const job = await newJob(owner, "deal", "create");
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, import_job_id, original_created_on) values ($1, 'עסקה עם היסטוריה', $2, $3, $4, '2016-01-01') returning id",
          [org, pipelineId, stages.find((s) => s.kind === "open")!.id, job],
        )
      ).rows[0].id,
    );
    expect(await notes(owner, job, [{ record_id: deal, body: "פגישה ישנה", date: "2016-02-02" }])).toEqual(["written"]);
    const attention = await asUser(owner.id, async (q) =>
      (await q<{ last_activity_at: string | null }>("select last_activity_at from app.deal_attention_rows($1, null, null, 14, array[$2::uuid])", [org, deal])).rows[0],
    );
    expect(attention.last_activity_at).toBeNull();
    // the weekly cleanup's copy of the rule (a deal stuck in its stage, so it is listed)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.deals set stage_entered_at = now() - interval '60 days' where id = $1", [deal]);
    });
    const cleanup = await asUser(owner.id, async (q) => {
      const r = (await q<{ r: { deals: Array<{ id: string; last_activity_at: string | null }> } }>("select public.report_pipeline_cleanup($1) as r", [org])).rows[0].r;
      return r.deals.find((d) => d.id === deal) ?? null;
    });
    expect(cleanup).not.toBeNull();
    expect(cleanup?.last_activity_at).toBeNull();
    // a person's logged entry still counts
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, deal_id) values ($1, 'call', 'שיחה', $2)", [org, deal]));
    const after = await asUser(owner.id, async (q) =>
      (await q<{ last_activity_at: string | null }>("select last_activity_at from app.deal_attention_rows($1, null, null, 14, array[$2::uuid])", [org, deal])).rows[0],
    );
    expect(after.last_activity_at).not.toBeNull();
  });

  it("an import note is not contact: last contact, waiting money, activation and score stay as they were", async () => {
    const fresh = await createUser("gh-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש");
    const lead = await insertLead(fresh.id, freshOrg, { full_name: "ממתין" });
    const job = await newJob(fresh, "lead", "update", freshOrg);
    expect(await notes(fresh, job, [{ record_id: lead, body: "היסטוריה" }], freshOrg)).toEqual(["written"]);
    const row = await asAdmin(
      async (q) => (await q<Row>("select last_contacted_at, first_contacted_at from public.leads where id = $1", [lead])).rows[0],
    );
    expect(row).toEqual({ last_contacted_at: null, first_contacted_at: null });
    expect(await asAdmin((q) => count(q, "select 1 from app.org_activation where organization_id = $1", [freshOrg]))).toBe(0);
    const waiting = await asUser(fresh.id, async (q) => (await q<{ r: { leads: { id: string }[] } }>("select public.report_money_waiting($1) as r", [freshOrg])).rows[0].r);
    expect(waiting.leads.map((l) => l.id)).toContain(lead);
    // a person's note does answer it (the rule is unchanged)
    await asUser(fresh.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'עניתי', $2)", [freshOrg, lead]));
    const after = await asUser(fresh.id, async (q) => (await q<{ r: { leads: { id: string }[] } }>("select public.report_money_waiting($1) as r", [freshOrg])).rows[0].r);
    expect(after.leads.map((l) => l.id)).not.toContain(lead);
  });

  it("an import note is not activity for the 'no activity' automation, its retry facts or its retry check", async () => {
    const quiet = await insertLead(owner.id, org, { full_name: "שקט" });
    await backdate("leads", quiet, 10);
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שקט אחרי ייבוא', 'lead', 'no_activity', '{"days": 3}', '[]', '[{"type": "create_note", "body": "עדיין אין פעילות"}]', false)
           returning id`,
          [org],
        )
      ).rows[0].id,
    );
    const facts = () =>
      asAdmin(
        async (q) =>
          (await q<{ f: { last_at: string } }>("select app.automation_run_facts('no_activity', '{\"days\": 3}', 'lead', $1, $2, 'noact:x') as f", [org, quiet])).rows[0].f,
      );
    const before = await facts();
    const job = await newJob(owner, "lead", "update");
    // dated today: if it counted, the lead would no longer be quiet
    const today = await asAdmin(async (q) => (await q<{ d: string }>("select to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d")).rows[0].d);
    expect(await notes(owner, job, [{ record_id: quiet, body: "הערה ישנה", date: today }])).toEqual(["written"]);
    expect(await facts()).toEqual(before);
    const holds = await asAdmin(
      async (q) =>
        (
          await q<{ h: boolean }>(
            "select app.automation_event_still_holds('no_activity', '{\"days\": 3}', 'lead', $1, $2, to_jsonb(l), $3) as h from public.leads l where l.id = $2",
            [org, quiet, JSON.stringify(before)],
          )
        ).rows[0].h,
    );
    expect(holds).toBe(true);
    await asAdmin(async (q) => {
      await q("delete from app.automation_scan_cursors where automation_id = $1", [rule]);
      await q("select app.scheduled_no_activity(a) from public.automations a where a.id = $1", [rule]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [rule, quiet]))).toBe(1);

    // an imported lead with notes from years ago is measured from the import, so the scan leaves it alone
    const importJob = await newJob(owner);
    const old = await insertLead(owner.id, org, { full_name: "היסטוריה ישנה", import_job_id: importJob, original_created_on: "2011-01-01" });
    expect(await notes(owner, importJob, [{ record_id: old, body: "לפני שנים", date: "2011-06-01" }])).toEqual(["written"]);
    await asAdmin(async (q) => {
      await q("delete from app.automation_scan_cursors where automation_id = $1", [rule]);
      await q("select app.scheduled_no_activity(a) from public.automations a where a.id = $1", [rule]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [rule, old]))).toBe(0);
  });

  it("undo: the job's records go to the bin with their notes; a member's own undo does not count the notes as work", async () => {
    const job = await newJob(owner);
    const lead = await insertLead(owner.id, org, { full_name: "לביטול", import_job_id: job, original_created_on: "2013-01-01" });
    await notes(owner, job, [{ record_id: lead, body: "הערה" }]);
    await finish(owner, job);
    await asUser(owner.id, (q) => q("select public.undo_import($1, $2)", [org, job]));
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is not null", [lead]))).toBe(1);
    // the notes stay with the record in the bin (a restore brings both back)
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and type = 'import_note'", [lead]))).toBe(1);

    const own = await newJob(holder);
    const a = await insertLead(holder.id, org, { full_name: "א", import_job_id: own, owner_id: holder.id });
    const b = await insertLead(holder.id, org, { full_name: "ב", import_job_id: own, owner_id: holder.id });
    expect(await notes(holder, own, [{ record_id: a, body: "הערה מהקובץ", date: "2020-02-02" }])).toEqual(["written"]);
    await finish(holder, own);
    // someone's real note on b after the import is work
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'עבודה', $2)", [org, b]));
    const result = await asUser(holder.id, async (q) => (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [org, own])).rows[0].r);
    expect(result).toMatchObject({ done: 1, kept: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1 and deleted_at is not null", [a]))).toBe(1);
  });

  it("an old original date never makes a lead waiting (MNY-01) or due for retention (PRV-01)", async () => {
    const job = await newJob(owner);
    const old = await insertLead(owner.id, org, { full_name: "מ-2010", import_job_id: job, original_created_on: "2010-01-01" });
    await finish(owner, job);
    // waiting leads and money waiting leave imports out
    const waiting = await asUser(owner.id, async (q) => (await q<{ r: { leads: { id: string }[] } }>("select public.report_money_waiting($1) as r", [org])).rows[0].r);
    expect(waiting.leads.map((l) => l.id)).not.toContain(old);
    // retention measures from created_at (the import), never the original date
    const candidate = (months: number) =>
      asAdmin((q) => count(q, "select 1 from app.lead_retention_candidates($1, now() - make_interval(months => $3), $2) c", [org, old, months]));
    expect(await candidate(6)).toBe(0);
    // once the import itself is older than the cutoff it is judged like any lead
    await backdate("leads", old, 400);
    expect(await candidate(6)).toBe(1);
  });
});
