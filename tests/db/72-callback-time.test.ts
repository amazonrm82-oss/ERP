import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Task = {
  id: string;
  title: string;
  description: string;
  task_type: string;
  priority: number;
  owner_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  due_at: Date;
  remind_at: Date | null;
};

const submit = (token: string, payload: Record<string, unknown>) =>
  asService(async (q) =>
    (await q<{ r: { status: string; lead_id?: string; contact_id?: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)]))
      .rows[0].r,
  );

const tasksOf = (column: "lead_id" | "contact_id", id: string) =>
  asAdmin(async (q) =>
    (
      await q<Task>(
        `select id, title, description, task_type, priority, owner_id, lead_id, contact_id, due_at, remind_at
           from public.tasks where ${column} = $1 order by created_at, id`,
        [id],
      )
    ).rows,
  );

const zoned = (iso: string) => asAdmin(async (q) => (await q<{ t: Date }>("select $1::timestamptz as t", [iso])).rows[0].t);

// SPD-05: the public form asks "when should we call you back?" (now, or a slot
// today or tomorrow); the choice creates a call task and shows in the notification.
describe("call-back time on the public form (SPD-05)", () => {
  let owner: U, admin: U, member: U, rep: U, outsider: U;
  let org: string;
  let form: { id: string; token: string };

  beforeAll(async () => {
    owner = await createUser("cb-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "cb-admin");
    member = await addMember(org, owner.id, "member", "cb-member");
    rep = await addMember(org, owner.id, "member", "cb-rep");
    outsider = await createUser("cb-outsider");
    await createOrg(outsider.id, "עסק אחר");
    form = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string; token: string }>(
          "insert into public.forms (organization_id, name, title, owner_id) values ($1, 'חזרה', 'פנייה', $2) returning id, token",
          [org, rep.id],
        )
      ).rows[0],
    );
  });

  const setForm = (user: U, set: string) =>
    asUser(user.id, async (q) => (await q(`update public.forms set ${set} where id = $1`, [form.id])).rowCount ?? 0);
  const callback = async () =>
    asService(async (q) => (await q<{ r: { callback: { time_zone: string } | null } }>("select public.intake_form($1) as r", [form.token])).rows[0].r.callback);

  it("is off by default: the form offers nothing and a sent choice is ignored", async () => {
    expect(await callback()).toBeNull();
    const r = await submit(form.token, { full_name: "בלי בחירה", phone: "050-7000001", callback: "now" });
    expect(r.status).toBe("accepted");
    expect(await tasksOf("lead_id", r.lead_id!)).toEqual([]);
    // even garbage is ignored while the form does not offer the choice
    expect((await submit(form.token, { full_name: "זבל", phone: "050-7000002", callback: "whenever" })).status).toBe("accepted");
  });

  it("only owners and admins of the business turn it on", async () => {
    expect(await setForm(member, "callback_choice = true")).toBe(0);
    expect(await setForm(outsider, "callback_choice = true")).toBe(0);
    expect(await setForm(admin, "callback_choice = true")).toBe(1);
    expect(await setForm(owner, "callback_choice = true")).toBe(1);
    const grants = await asAdmin(async (q) =>
      (
        await q<{ privilege_type: string }>(
          `select privilege_type from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'forms' and grantee = 'authenticated'
              and column_name = 'callback_choice' order by privilege_type collate "C"`,
        )
      ).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await callback()).toEqual({ time_zone: "Asia/Jerusalem" });
  });

  it("'now' creates a high-priority call task due now for the new lead's owner, and the notification says so", async () => {
    const r = await submit(form.token, { full_name: "דנה לוי", phone: "050-7000003", callback: "now" });
    expect(r.status).toBe("accepted");
    const [task, ...more] = await tasksOf("lead_id", r.lead_id!);
    expect(more).toEqual([]);
    expect(task).toMatchObject({
      title: "שיחה חוזרת: דנה לוי",
      description: 'ביקשו בטופס "חזרה" שנחזור אליהם עכשיו.',
      task_type: "call",
      priority: 1,
      owner_id: rep.id,
      contact_id: null,
      remind_at: null,
    });
    expect(Math.abs(task.due_at.getTime() - Date.now())).toBeLessThan(60_000);
    const notes = await asAdmin(async (q) =>
      (
        await q<{ entity_type: string; body: string | null }>(
          "select entity_type, body from public.notifications where user_id = $1 and entity_id in ($2, $3) order by entity_type collate \"C\"",
          [rep.id, r.lead_id, task.id],
        )
      ).rows,
    );
    expect(notes).toEqual([
      { entity_type: "lead", body: "ביקשו שנחזור אליהם עכשיו" },
      { entity_type: "task", body: "ביקשו שנחזור אליהם עכשיו" },
    ]);
  });

  it("a slot creates a task due at the slot's start in the business's time zone, with a reminder then", async () => {
    const r = await submit(form.token, { full_name: "מיכל", phone: "050-7000004", callback: "tomorrow-15" });
    const [task] = await tasksOf("lead_id", r.lead_id!);
    const expected = await asAdmin(async (q) =>
      (
        await q<{ t: Date }>(
          "select ((now() at time zone 'Asia/Jerusalem')::date + 1 + time '15:00') at time zone 'Asia/Jerusalem' as t",
        )
      ).rows[0].t,
    );
    expect(task).toMatchObject({ title: "שיחה חוזרת: מיכל", priority: 2, owner_id: rep.id });
    expect(task.due_at.getTime()).toBe(expected.getTime());
    expect(task.remind_at?.getTime()).toBe(expected.getTime());
    expect(
      await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and body = 'ביקשו שנחזור אליהם מחר בין 15:00 ל-18:00'", [r.lead_id])),
    ).toBe(1);
  });

  it("follows the business's time zone", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set timezone = 'America/New_York' where id = $1", [org]));
    try {
      expect(await callback()).toEqual({ time_zone: "America/New_York" });
      const r = await submit(form.token, { full_name: "יוסי", phone: "050-7000005", callback: "tomorrow-09" });
      const [task] = await tasksOf("lead_id", r.lead_id!);
      const expected = await asAdmin(async (q) =>
        (
          await q<{ t: Date }>(
            "select ((now() at time zone 'America/New_York')::date + 1 + time '09:00') at time zone 'America/New_York' as t",
          )
        ).rows[0].t,
      );
      expect(task.due_at.getTime()).toBe(expected.getTime());
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("a repeat inquiry onto an existing lead creates the task for that lead's owner", async () => {
    const lead = await insertLead(member.id, org, { full_name: "לקוח קיים", phone: "050-7000006" });
    const r = await submit(form.token, { full_name: "לקוח קיים", phone: "0507000006", callback: "tomorrow-18" });
    expect(r).toMatchObject({ status: "duplicate", lead_id: lead });
    const [task] = await tasksOf("lead_id", lead);
    expect(task).toMatchObject({ owner_id: member.id, lead_id: lead, contact_id: null, title: "שיחה חוזרת: לקוח קיים" });
    // the inquiry notification and the inquiry entry carry the time
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.notifications where user_id = $1 and entity_id = $2 and type = 'inquiry' and body = 'ביקשו שנחזור אליהם מחר בין 18:00 ל-20:00'", [member.id, lead]),
      ),
    ).toBe(1);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.activities where lead_id = $1 and type = 'inquiry' and metadata ? 'callback_at'", [lead])),
    ).toBe(1);
  });

  it("a repeat inquiry onto an unassigned contact gives the task to the form's owner", async () => {
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone) values ($1, 'איש קשר', '050-7000009') returning id", [org]))
        .rows[0].id,
    );
    await asUser(owner.id, (q) => q("update public.contacts set owner_id = null where id = $1", [contact]));
    const r = await submit(form.token, { full_name: "איש קשר", phone: "+972 50 700 0009", callback: "now" });
    expect(r).toMatchObject({ status: "duplicate", contact_id: contact });
    const [task] = await tasksOf("contact_id", contact);
    expect(task).toMatchObject({ owner_id: rep.id, lead_id: null, contact_id: contact, priority: 1 });
  });

  it("a repeat inquiry onto a suspended member's lead gives the task to the form's owner", async () => {
    const gone = await addMember(org, owner.id, "member", "cb-gone");
    const lead = await insertLead(gone.id, org, { full_name: "לקוח של עובד שעזב", phone: "050-7000010" });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, gone.id]));
    const r = await submit(form.token, { full_name: "לקוח של עובד שעזב", phone: "050-7000010", callback: "now" });
    expect(r).toMatchObject({ status: "duplicate", lead_id: lead });
    const [task] = await tasksOf("lead_id", lead);
    expect(task.owner_id).toBe(rep.id);
    // a viewer as record owner is skipped the same way
    const viewer = await addMember(org, owner.id, "viewer", "cb-viewer");
    const lead2 = await insertLead(owner.id, org, { full_name: "לקוח של צופה", phone: "050-7000011" });
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [lead2, viewer.id]));
    await submit(form.token, { full_name: "לקוח של צופה", phone: "050-7000011", callback: "tomorrow-09" });
    expect((await tasksOf("lead_id", lead2))[0].owner_id).toBe(rep.id);
  });

  it("a webhook that sends a call-back choice is ignored", async () => {
    const hook = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, callback_choice) values ($1, 'webhook', 'Zapier', $2, true) returning token", [org, rep.id]))
        .rows[0].token,
    );
    const r = await asService(async (q) =>
      (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [hook, JSON.stringify({ full_name: "מזאפייר", phone: "050-7000012", callback: "now" })])).rows[0].r,
    );
    expect(r.status).toBe("accepted");
    expect(await tasksOf("lead_id", r.lead_id)).toEqual([]);
    // garbage too: no refusal
    const r2 = await asService(async (q) =>
      (await q<{ r: { status: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [hook, JSON.stringify({ phone: "050-7000013", callback: "later" })])).rows[0].r,
    );
    expect(r2.status).toBe("accepted");
  });

  it("refuses a choice that is not on the list, and writes nothing", async () => {
    const before = await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]));
    for (const bad of ["later", "today-10", "nextweek-09", "NOW", { at: "now" }]) {
      const err = await pgError(submit(form.token, { full_name: "שגוי", phone: "050-7000007", callback: bad }));
      expect(err).toMatchObject({ code: "22023", hint: "callback:invalid" });
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(before);
    // an empty choice means "no preference": a lead and no task
    const r = await submit(form.token, { full_name: "בלי העדפה", phone: "050-7000008", callback: " " });
    expect(await tasksOf("lead_id", r.lead_id!)).toEqual([]);
  });

  it("works out slot times and refuses a slot that has ended", async () => {
    const at = (choice: string, now: string, zone = "Asia/Jerusalem") =>
      asAdmin(async (q) => (await q<{ t: Date }>("select app.intake_callback_at($1, $2, $3::timestamptz) as t", [choice, zone, now])).rows[0].t);
    // 10:30 in Jerusalem (summer, UTC+3)
    const now = "2026-07-01T07:30:00Z";
    expect((await at("now", now)).getTime()).toBe((await zoned(now)).getTime());
    // a slot that has started: due now
    expect((await at("today-09", now)).getTime()).toBe((await zoned(now)).getTime());
    expect((await at("today-12", now)).getTime()).toBe((await zoned("2026-07-01T09:00:00Z")).getTime());
    expect((await at("tomorrow-09", now)).getTime()).toBe((await zoned("2026-07-02T06:00:00Z")).getTime());
    // an unknown zone falls back to Jerusalem
    expect((await at("today-18", now, "Mars/Base")).getTime()).toBe((await zoned("2026-07-01T15:00:00Z")).getTime());
    // 20:00 in Jerusalem: every slot of today has ended
    for (const choice of ["today-09", "today-12", "today-15", "today-18"]) {
      expect(await pgError(at(choice, "2026-07-01T17:00:00Z"))).toMatchObject({ code: "22023", hint: "callback:past" });
    }
    // only a known IANA name (or UTC) passes; the rest fall back to Jerusalem
    const zone = (z: string | null) => asAdmin(async (q) => (await q<{ z: string }>("select app.intake_zone($1) as z", [z])).rows[0].z);
    for (const z of ["Factory", "localtime", "Mars/Base", "EST5EDT,M3.2.0", "", null, "posixrules"]) {
      expect(await zone(z)).toBe("Asia/Jerusalem");
    }
    for (const z of ["UTC", "America/New_York", "America/Argentina/Buenos_Aires", "Etc/GMT+2"]) {
      expect(await zone(z)).toBe(z);
    }
    // labels
    const label = (choice: string) => asAdmin(async (q) => (await q<{ l: string | null }>("select app.intake_callback_label($1) as l", [choice])).rows[0].l);
    expect(await label("now")).toBe("עכשיו");
    expect(await label("today-09")).toBe("היום בין 09:00 ל-12:00");
    expect(await label("tomorrow-18")).toBe("מחר בין 18:00 ל-20:00");
    expect(await label("today-10")).toBeNull();
  });

  it("clients cannot call the helpers", async () => {
    for (const sql of [
      "select app.intake_callback_at('now', null, now())",
      "select app.intake_callback_label('now')",
      "select app.intake_zone('Asia/Jerusalem')",
      "select app.intake_callback_task(gen_random_uuid(), null, null, null, 'now', now(), 'x', 'y')",
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql)))).code).toBe("42501");
    }
  });
});
