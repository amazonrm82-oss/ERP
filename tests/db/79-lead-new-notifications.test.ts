import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Note = { user_id: string; type: string; title: string; body: string | null };

// SPD-01 (owner's answer, 13 October 2026): a lead from a form or webhook is a
// 'lead_new' notification; a lead nobody owns goes to whoever may take it.
describe("new-lead notifications from intake (SPD-01)", () => {
  let owner: U, admin: U, rep: U, teamMember: U, teamManager: U, teamViewer: U, teamGone: U, teamAdmin: U, loner: U, outsider: U;
  let org: string;
  let otherOrg: string;
  let team: string;
  let viewersTeam: string;

  const newForm = (user: U, set: Record<string, unknown>, kind = "form") =>
    asUser(user.id, async (q) => {
      const keys = Object.keys(set);
      const columns = ["organization_id", "kind", "name", ...keys].join(", ");
      const params = [org, kind, `טופס ${Math.random()}`, ...keys.map((k) => set[k])];
      const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
      return (await q<{ token: string; id: string }>(`insert into public.forms (${columns}) values (${placeholders}) returning token, id`, params)).rows[0];
    });
  const submit = (token: string, payload: Record<string, unknown>, kind = "form") =>
    asService(async (q) =>
      (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, $2, $3) as r", [token, kind, JSON.stringify(payload)])).rows[0].r,
    );
  const notesOf = (lead: string) =>
    asAdmin(async (q) =>
      (
        await q<Note>("select user_id, type, title, body from public.notifications where entity_type = 'lead' and entity_id = $1 order by user_id", [lead])
      ).rows,
    );
  const recipients = async (lead: string) => (await notesOf(lead)).map((n) => n.user_id).sort();
  const ids = (...users: U[]) => users.map((u) => u.id).sort();

  beforeAll(async () => {
    owner = await createUser("lnn-owner");
    org = await createOrg(owner.id, "עסק הלידים");
    admin = await addMember(org, owner.id, "admin", "lnn-admin");
    rep = await addMember(org, owner.id, "member", "lnn-rep");
    teamMember = await addMember(org, owner.id, "member", "lnn-team-member");
    teamManager = await addMember(org, owner.id, "manager", "lnn-team-manager");
    teamViewer = await addMember(org, owner.id, "viewer", "lnn-team-viewer");
    teamGone = await addMember(org, owner.id, "member", "lnn-team-gone");
    teamAdmin = await addMember(org, owner.id, "admin", "lnn-team-admin");
    loner = await addMember(org, owner.id, "member", "lnn-loner");
    outsider = await createUser("lnn-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      viewersTeam = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צופים') returning id", [org])).rows[0].id;
      for (const [user, manager] of [
        [teamMember, false],
        [teamManager, true],
        [teamViewer, false],
        [teamGone, false],
        [teamAdmin, false],
      ] as const) {
        await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, $4)", [org, team, user.id, manager]);
      }
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, viewersTeam, teamViewer.id]);
    });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, teamGone.id]));
    // every day a working day, so the call-back cases do not depend on the weekday they run on
    await asUser(owner.id, (q) => q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest) values ($1, '{}', false)", [org]));
  });

  it("a form lead with an owner is 'lead_new' for that owner; a lead made by hand stays 'assigned'", async () => {
    const form = await newForm(owner, { owner_id: rep.id });
    const r = await submit(form.token, { full_name: "ליד מטופס", phone: "050-7400001" });
    expect(await notesOf(r.lead_id)).toEqual([{ user_id: rep.id, type: "lead_new", title: "ליד חדש הוקצה לכם", body: null }]);
    const byHand = await insertLead(owner.id, org, { owner_id: rep.id, full_name: "ליד ידני" });
    expect((await notesOf(byHand)).map((n) => n.type)).toEqual(["assigned"]);
  });

  it("a webhook lead is 'lead_new' too", async () => {
    const hook = await newForm(owner, { owner_id: rep.id }, "webhook");
    const r = await submit(hook.token, { full_name: "מזאפייר", phone: "050-7400002" }, "webhook");
    expect((await notesOf(r.lead_id)).map((n) => [n.user_id, n.type])).toEqual([[rep.id, "lead_new"]]);
  });

  it("round robin: the picked person gets 'lead_new'", async () => {
    const form = await newForm(owner, { assign_mode: "round_robin", team_id: team });
    const r = await submit(form.token, { full_name: "בסבב", phone: "050-7400003" });
    const notes = await notesOf(r.lead_id);
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe("lead_new");
    const leadOwner = await asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.leads where id = $1", [r.lead_id])).rows[0].owner_id);
    expect(notes[0].user_id).toBe(leadOwner);
  });

  it("muting 'lead_new' is respected; the call task is then announced to the owner", async () => {
    await asUser(rep.id, (q) => q("select public.set_notification_settings('{lead_new}', '{}')"));
    try {
      const form = await newForm(owner, { owner_id: rep.id, callback_choice: true });
      const r = await submit(form.token, { full_name: "מושתק", phone: "050-7400004" });
      expect(await notesOf(r.lead_id)).toEqual([]);
    } finally {
      await asUser(rep.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
    }
  });

  it("no owner: every active team member who may take it, not viewers or suspended members; nobody else", async () => {
    // the form's owner is suspended and there is no round robin
    const form = await newForm(owner, { owner_id: teamGone.id, team_id: team });
    const r = await submit(form.token, { full_name: "בלי אחראי", phone: "050-7400005" });
    expect(await asAdmin(async (q) => (await q<{ owner_id: string | null }>("select owner_id from public.leads where id = $1", [r.lead_id])).rows[0].owner_id)).toBeNull();
    expect(await recipients(r.lead_id)).toEqual(ids(teamMember, teamManager, teamAdmin));
    const notes = await notesOf(r.lead_id);
    expect(new Set(notes.map((n) => n.type))).toEqual(new Set(["lead_new"]));
    expect(notes[0].title).toBe("ליד חדש מחכה למי שייקח אותו");
    // never anyone of another organization
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and organization_id <> $2", [r.lead_id, org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1", [otherOrg]))).toBe(0);

    // the first "לקחתי" wins; the next one sees who took it
    const take = (user: U) => asUser(user.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.take_lead($1, $2) as r", [org, r.lead_id])).rows[0].r);
    expect(await take(teamMember)).toEqual({ ok: true, result: "taken" });
    expect(await take(teamManager)).toMatchObject({ ok: false, reason: "taken" });
    expect(await asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.leads where id = $1", [r.lead_id])).rows[0].owner_id)).toBe(teamMember.id);
  });

  it("no owner, 'own' visibility: only those who may read the team's lead (its manager, admins)", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const form = await newForm(owner, { team_id: team });
      const r = await submit(form.token, { full_name: "פרטי", phone: "050-7400006" });
      expect(await recipients(r.lead_id)).toEqual(ids(teamManager, teamAdmin));
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("no owner and no team, or nobody in it who qualifies: the owners and admins", async () => {
    const noTeam = await newForm(owner, {});
    const r1 = await submit(noTeam.token, { full_name: "בלי צוות", phone: "050-7400007" });
    expect(await recipients(r1.lead_id)).toEqual(ids(owner, admin, teamAdmin));
    const onlyViewers = await newForm(owner, { team_id: viewersTeam });
    const r2 = await submit(onlyViewers.token, { full_name: "צוות צופים", phone: "050-7400008" });
    expect(await recipients(r2.lead_id)).toEqual(ids(owner, admin, teamAdmin));
    // a member outside the team is never told about a lead they cannot take in that order
    expect(await recipients(r2.lead_id)).not.toContain(loner.id);
  });

  it("one notification per person, muting respected, and the push carries the buttons", async () => {
    await asUser(teamManager.id, (q) => q("select public.set_notification_settings('{lead_new}', '{}')"));
    await asAdmin((q) =>
      q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'k', 'a')", [teamMember.id, `https://push.example.test/${teamMember.id}`]),
    );
    try {
      const form = await newForm(owner, { team_id: team });
      const r = await submit(form.token, { full_name: "דחיפה", phone: "050-7400009" });
      expect(await recipients(r.lead_id)).toEqual(ids(teamMember, teamAdmin));
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 group by user_id having count(*) > 1", [r.lead_id]))).toBe(0);
      const batch = await asService(async (q) =>
        (await q<{ r: { user_id: string; entity_id: string; type: string; lead_actions: boolean }[] }>("select public.claim_push_notifications(500) as r")).rows[0].r,
      );
      expect(batch.find((n) => n.entity_id === r.lead_id && n.user_id === teamMember.id)).toMatchObject({ type: "lead_new", lead_actions: true });
    } finally {
      await asUser(teamManager.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
    }
  });

  it("a call-back request on a lead nobody owns: the time is in every notification, the task has no owner", async () => {
    // a zone where it is about noon, so "now" is offered
    const offset = 12 - new Date().getUTCHours();
    const zone = offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
    await asUser(owner.id, (q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    try {
      const form = await newForm(owner, { team_id: team, callback_choice: true });
      const r = await submit(form.token, { full_name: "התקשרו", phone: "050-7400010", callback: "now" });
      const notes = await notesOf(r.lead_id);
      expect(notes.map((n) => n.user_id).sort()).toEqual(ids(teamMember, teamManager, teamAdmin));
      expect(new Set(notes.map((n) => n.body))).toEqual(new Set(["ביקשו שנחזור אליהם עכשיו"]));
      const task = await asAdmin(async (q) => (await q<{ owner_id: string | null }>("select owner_id from public.tasks where lead_id = $1", [r.lead_id])).rows[0]);
      expect(task.owner_id).toBeNull();
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("with a call-back request and the owner muted: the task is announced, as they were not told", async () => {
    const offset = 12 - new Date().getUTCHours();
    const zone = offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
    await asUser(owner.id, (q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    await asUser(rep.id, (q) => q("select public.set_notification_settings('{lead_new}', '{}')"));
    try {
      const form = await newForm(owner, { owner_id: rep.id, callback_choice: true });
      const r = await submit(form.token, { full_name: "מושתק עם שיחה", phone: "050-7400011", callback: "now" });
      expect(await notesOf(r.lead_id)).toEqual([]);
      expect(
        await asAdmin((q) =>
          count(q, "select 1 from public.notifications n join public.tasks t on t.id = n.entity_id where t.lead_id = $1 and n.user_id = $2 and n.type = 'assigned'", [r.lead_id, rep.id]),
        ),
      ).toBe(1);
    } finally {
      await asUser(rep.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
      await asUser(owner.id, (q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  describe("the call-back task follows 'לקחתי' (SPD-05)", () => {
    const noon = (() => {
      const offset = 12 - new Date().getUTCHours();
      return offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
    })();
    const tomorrow9 = async () =>
      `${await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone $1)::date + 1, 'YYYY-MM-DD') as d", [noon])).rows[0].d)}-09`;
    type T = { id: string; owner_id: string | null; reminded_at: Date | null };
    const tasksOf = (lead: string) =>
      asAdmin(async (q) => (await q<T>("select id, owner_id, reminded_at from public.tasks where lead_id = $1 order by created_at, id", [lead])).rows);
    const take = (user: U, lead: string) =>
      asUser(user.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r);
    const remindNow = (task: string) =>
      asAdmin(async (q) => {
        await q("update public.tasks set remind_at = now() - interval '1 minute' where id = $1", [task]);
        await q("select app.send_task_reminders()");
      });
    let form: { token: string };

    beforeAll(async () => {
      await asUser(owner.id, (q) => q("update public.organizations set timezone = $2 where id = $1", [org, noon]));
      form = await newForm(owner, { team_id: team, callback_choice: true });
    });
    afterAll(async () => {
      await asUser(owner.id, (q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    });

    it("the taker gets the lead's unowned call task in the same action, with no task notification", async () => {
      const r = await submit(form.token, { full_name: "שיחה ללקיחה", phone: "050-7400101", callback: await tomorrow9() });
      const [task] = await tasksOf(r.lead_id);
      expect(task.owner_id).toBeNull();
      expect(await take(teamMember, r.lead_id)).toEqual({ ok: true, result: "taken" });
      expect((await tasksOf(r.lead_id))[0].owner_id).toBe(teamMember.id);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_type = 'task' and entity_id = $1", [task.id]))).toBe(0);
      // the reminder at the slot's start goes to the taker only, as a task reminder
      await remindNow(task.id);
      const notes = await asAdmin(async (q) =>
        (await q<{ user_id: string; type: string }>("select user_id, type from public.notifications where (entity_type = 'task' and entity_id = $1) or (entity_type = 'lead' and entity_id = $2 and title like 'תזכורת%')", [task.id, r.lead_id])).rows,
      );
      expect(notes).toEqual([{ user_id: teamMember.id, type: "task_reminder" }]);
    });

    it("a call task that already has an owner, and other tasks, do not move", async () => {
      const r = await submit(form.token, { full_name: "משימה עם אחראי", phone: "050-7400102", callback: await tomorrow9() });
      const [call] = await tasksOf(r.lead_id);
      await asAdmin(async (q) => {
        await q("update public.tasks set owner_id = $2 where id = $1", [call.id, rep.id]);
        await q("insert into public.tasks (organization_id, title, lead_id) values ($1, 'משימה אחרת בלי אחראי', $2)", [org, r.lead_id]);
      });
      expect(await take(teamManager, r.lead_id)).toEqual({ ok: true, result: "taken" });
      const after = await tasksOf(r.lead_id);
      expect(after.map((t) => t.owner_id)).toEqual([rep.id, null]);
    });

    it("nobody took the lead by the slot's start: the people who got the lead are reminded, once, with the buttons", async () => {
      const r = await submit(form.token, { full_name: "עוד מחכה", phone: "050-7400103", callback: await tomorrow9() });
      const [task] = await tasksOf(r.lead_id);
      await remindNow(task.id);
      const reminders = async () =>
        asAdmin(async (q) =>
          (
            await q<{ user_id: string; type: string }>(
              "select user_id, type from public.notifications where entity_type = 'lead' and entity_id = $1 and title like 'תזכורת%' order by user_id",
              [r.lead_id],
            )
          ).rows,
        );
      expect((await reminders()).map((n) => n.user_id).sort()).toEqual(ids(teamMember, teamManager, teamAdmin));
      expect(new Set((await reminders()).map((n) => n.type))).toEqual(new Set(["lead_new"]));
      expect((await tasksOf(r.lead_id))[0].reminded_at).not.toBeNull();
      // once
      await asAdmin((q) => q("select app.send_task_reminders()"));
      expect(await reminders()).toHaveLength(3);
      // the push carries "לקחתי" (teamMember has a device since an earlier test)
      const batch = await asService(async (q) =>
        (await q<{ r: { user_id: string; entity_id: string; title: string; lead_actions: boolean }[] }>("select public.claim_push_notifications(500) as r")).rows[0].r,
      );
      expect(batch.find((n) => n.entity_id === r.lead_id && n.user_id === teamMember.id && n.title.startsWith("תזכורת"))).toMatchObject({ lead_actions: true });
    });

    it("the call task carries the lead's team, and follows an owner set by hand, silently", async () => {
      const r = await submit(form.token, { full_name: "שיוך ידני", phone: "050-7400104", callback: await tomorrow9() });
      const [task] = await tasksOf(r.lead_id);
      expect(await asAdmin(async (q) => (await q<{ team_id: string }>("select team_id from public.tasks where id = $1", [task.id])).rows[0].team_id)).toBe(team);
      await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [r.lead_id, rep.id]));
      expect((await tasksOf(r.lead_id))[0].owner_id).toBe(rep.id);
      // told about the lead ('assigned'), not again about the task
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_type = 'task' and entity_id = $1", [task.id]))).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_type = 'lead' and entity_id = $1 and user_id = $2 and type = 'assigned'", [r.lead_id, rep.id]))).toBe(1);
    });

    it("an owner who is not an active member counts as no owner; once active, the task follows them", async () => {
      // the lead goes to the suspended member: the task stays without an owner
      const r = await submit(form.token, { full_name: "בעלים מושעה", phone: "050-7400105", callback: await tomorrow9() });
      await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [r.lead_id, teamGone.id]));
      const [task] = await tasksOf(r.lead_id);
      expect(task.owner_id).toBeNull();
      // at the slot's start the would-be takers are reminded, not the suspended owner
      await remindNow(task.id);
      const told = await asAdmin(async (q) =>
        (await q<{ user_id: string }>("select user_id from public.notifications where entity_type = 'lead' and entity_id = $1 and title like 'תזכורת%'", [r.lead_id])).rows.map((n) => n.user_id).sort(),
      );
      expect(told).toEqual(ids(teamMember, teamManager, teamAdmin));

      // another lead of theirs: back at work, "לקחתי" on their own lead brings the task along
      const r2 = await submit(form.token, { full_name: "בעלים חוזר", phone: "050-7400106", callback: await tomorrow9() });
      await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [r2.lead_id, teamGone.id]));
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, teamGone.id]));
      try {
        expect((await tasksOf(r2.lead_id))[0].owner_id).toBeNull();
        expect(await take(teamGone, r2.lead_id)).toEqual({ ok: true, result: "acknowledged" });
        expect((await tasksOf(r2.lead_id))[0].owner_id).toBe(teamGone.id);
      } finally {
        await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, teamGone.id]));
      }
    });

    it("the reminder job moves a stranded task to the lead's usable owner first, then reminds them", async () => {
      const r = await submit(form.token, { full_name: "תקוע", phone: "050-7400107", callback: await tomorrow9() });
      await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [r.lead_id, teamGone.id]));
      const [task] = await tasksOf(r.lead_id);
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, teamGone.id]));
      try {
        await remindNow(task.id);
        expect((await tasksOf(r.lead_id))[0].owner_id).toBe(teamGone.id);
        const notes = await asAdmin(async (q) =>
          (await q<{ user_id: string; type: string }>("select user_id, type from public.notifications where (entity_type = 'task' and entity_id = $1) or (entity_type = 'lead' and entity_id = $2 and title like 'תזכורת%')", [task.id, r.lead_id])).rows,
        );
        expect(notes).toEqual([{ user_id: teamGone.id, type: "task_reminder" }]);
      } finally {
        await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, teamGone.id]));
      }
    });

    it("a merge brings a stranded call task onto an owned lead: it follows that owner, silently", async () => {
      const r = await submit(form.token, { full_name: "כפול", phone: "050-7400108", callback: "now" });
      const [task] = await tasksOf(r.lead_id);
      expect(task.owner_id).toBeNull();
      const kept = await insertLead(owner.id, org, { owner_id: rep.id, full_name: "המקורי" });
      await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, kept, r.lead_id]));
      expect(await asAdmin(async (q) => (await q<{ owner_id: string; lead_id: string }>("select owner_id, lead_id from public.tasks where id = $1", [task.id])).rows[0])).toEqual({
        owner_id: rep.id,
        lead_id: kept,
      });
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_type = 'task' and entity_id = $1", [task.id]))).toBe(0);
    });

    it("a handover of the lead's owner brings the stranded call task along, silently", async () => {
      const r = await submit(form.token, { full_name: "מסירה", phone: "050-7400109", callback: await tomorrow9() });
      // owned by a suspended member: the task stays without an owner
      await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [r.lead_id, teamGone.id]));
      const [task] = await tasksOf(r.lead_id);
      expect(task.owner_id).toBeNull();
      await asUser(owner.id, (q) => q("select public.transfer_records($1, $2, $3)", [org, teamGone.id, loner.id]));
      expect((await tasksOf(r.lead_id))[0].owner_id).toBe(loner.id);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_type = 'task' and entity_id = $1", [task.id]))).toBe(0);
    });

    it("other task reminders are unchanged; an unowned task that is not a call-back task reminds nobody", async () => {
      const lead = await insertLead(owner.id, org, { full_name: "ידני" });
      const ids2 = await asAdmin(async (q) => ({
        owned: (await q<{ id: string }>("insert into public.tasks (organization_id, title, lead_id, owner_id, remind_at) values ($1, 'רגילה', $2, $3, now() - interval '1 minute') returning id", [org, lead, rep.id])).rows[0].id,
        unowned: (await q<{ id: string }>("insert into public.tasks (organization_id, title, lead_id, remind_at) values ($1, 'בלי אחראי', $2, now() - interval '1 minute') returning id", [org, lead])).rows[0].id,
      }));
      await asAdmin((q) => q("select app.send_task_reminders()"));
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and user_id = $2 and type = 'task_reminder'", [ids2.owned, rep.id]))).toBe(1);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id in ($1, $2) and title like 'תזכורת: בלי%'", [ids2.unowned, lead]))).toBe(0);
    });
  });

  it("the helper is closed to clients", async () => {
    const err = await asUser(owner.id, (q) => q("select * from app.intake_unowned_recipients($1, null)", [org])).catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe("42501");
  });
});
