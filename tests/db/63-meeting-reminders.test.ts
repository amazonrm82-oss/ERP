import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/** CAL-06: a reminder to the organizer and the team participants, X minutes before a meeting. */
describe("meeting reminders", () => {
  let owner: U, rep: U, other: U, quiet: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("remind-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "remind-rep");
    other = await addMember(org, owner.id, "member", "remind-other");
    quiet = await addMember(org, owner.id, "member", "remind-quiet");
  });

  const send = () => asAdmin(async (q) => (await q<{ n: number }>("select app.send_meeting_reminders() as n")).rows[0].n);

  const createMeeting = (as: U, title: string, opts: { startsIn: string; reminder?: number | null; status?: string }) =>
    asUser(as.id, async (q) => {
      const withReminder = opts.reminder !== undefined;
      const res = await q<{ id: string }>(
        `insert into public.meetings (organization_id, title, starts_at, ends_at, status${withReminder ? ", reminder_minutes" : ""})
         values ($1, $2, now() + $3::interval, now() + $3::interval + interval '1 hour', $4${withReminder ? ", $5" : ""}) returning id`,
        withReminder ? [org, title, opts.startsIn, opts.status ?? "planned", opts.reminder] : [org, title, opts.startsIn, opts.status ?? "planned"],
      );
      return res.rows[0].id;
    });

  const addParticipant = (as: U, meeting: string, userId: string) =>
    asUser(as.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, meeting, userId]));

  const reminders = (meeting: string) =>
    asAdmin(async (q) =>
      (
        await q<{ user_id: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null }>(
          "select user_id, title, body, entity_type, entity_id from public.notifications where organization_id = $1 and type = 'meeting_reminder' and entity_id = $2 order by user_id",
          [org, meeting],
        )
      ).rows,
    );
  const remindedUsers = async (meeting: string) => (await reminders(meeting)).map((r) => r.user_id).sort();

  it("a new meeting reminds 15 minutes before by default; members choose 5, 15, 30, 60, a day or none, nothing else", async () => {
    const meeting = await createMeeting(rep, "ברירת מחדל", { startsIn: "3 days" });
    const reminder = () => asAdmin(async (q) => (await q<{ r: number | null }>("select reminder_minutes as r from public.meetings where id = $1", [meeting])).rows[0].r);
    expect(await reminder()).toBe(15);
    for (const minutes of [5, 30, 60, 1440, null]) {
      await asUser(rep.id, async (q) => {
        expect((await q("update public.meetings set reminder_minutes = $1 where id = $2 returning id", [minutes, meeting])).rowCount).toBe(1);
      });
      expect(await reminder()).toBe(minutes);
    }
    expect((await pgError(asUser(rep.id, (q) => q("update public.meetings set reminder_minutes = 10 where id = $1", [meeting])))).code).toBe("23514");
    // the meeting policies still decide who: a colleague with no part in it cannot change it
    await asUser(quiet.id, async (q) => {
      expect((await q("update public.meetings set reminder_minutes = 5 where id = $1", [meeting])).rowCount).toBe(0);
    });
  });

  it("when the time comes, the organizer and each participant are reminded once, in the bell, with the start and a link", async () => {
    const meeting = await createMeeting(rep, "פגישת היכרות", { startsIn: "10 minutes" });
    await addParticipant(rep, meeting, rep.id); // the organizer as a participant too: still one reminder
    await addParticipant(rep, meeting, other.id);
    await send();
    const sent = await reminders(meeting);
    expect(sent.map((r) => r.user_id).sort()).toEqual([rep.id, other.id].sort());
    for (const r of sent) {
      expect(r).toMatchObject({ title: "תזכורת לפגישה: פגישת היכרות", entity_type: "meeting", entity_id: meeting });
      expect(r.body).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
    }
    // the next runs send nothing more
    await send();
    await send();
    expect(await reminders(meeting)).toHaveLength(2);
    // not a change to the meeting: no audit entry, the row is not touched
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and action = 'update'", [meeting]))).toBe(0);
  });

  it("someone added after the reminder went out is reminded on the next run", async () => {
    const meeting = await createMeeting(owner, "מצטרף מאוחר", { startsIn: "10 minutes" });
    await send();
    expect(await remindedUsers(meeting)).toEqual([owner.id]);
    await addParticipant(owner, meeting, quiet.id);
    await send();
    expect(await remindedUsers(meeting)).toEqual([owner.id, quiet.id].sort());
  });

  it("not before its time, not after the start, and never with no reminder", async () => {
    const early = await createMeeting(owner, "עוד מוקדם", { startsIn: "20 minutes" });
    const hour = await createMeeting(owner, "שעה לפני", { startsIn: "50 minutes", reminder: 60 });
    const day = await createMeeting(owner, "יום לפני", { startsIn: "23 hours", reminder: 1440 });
    const dayLater = await createMeeting(owner, "יותר מיום", { startsIn: "25 hours", reminder: 1440 });
    const started = await createMeeting(owner, "כבר התחילה", { startsIn: "-5 minutes" });
    const none = await createMeeting(owner, "בלי תזכורת", { startsIn: "3 minutes", reminder: null });
    await send();
    expect(await remindedUsers(early)).toEqual([]);
    expect(await remindedUsers(hour)).toEqual([owner.id]);
    expect(await remindedUsers(day)).toEqual([owner.id]);
    expect(await remindedUsers(dayLater)).toEqual([]);
    expect(await remindedUsers(started)).toEqual([]);
    expect(await remindedUsers(none)).toEqual([]);
  });

  it("cancelled, held and no-show meetings are not reminded", async () => {
    const ids = [];
    for (const status of ["cancelled", "held", "no_show"]) ids.push(await createMeeting(owner, `סטטוס ${status}`, { startsIn: "5 minutes", status }));
    await send();
    for (const id of ids) expect(await remindedUsers(id)).toEqual([]);
  });

  it("moving the meeting arms the reminder again", async () => {
    const meeting = await createMeeting(rep, "פגישה שזזה", { startsIn: "10 minutes" });
    await send();
    expect(await reminders(meeting)).toHaveLength(1);
    await asUser(rep.id, (q) => q("update public.meetings set starts_at = now() + interval '12 minutes', ends_at = now() + interval '72 minutes' where id = $1", [meeting]));
    await send();
    expect(await reminders(meeting)).toHaveLength(2);
    // changing something else does not
    await asUser(rep.id, (q) => q("update public.meetings set title = 'פגישה שזזה פעם אחת' where id = $1", [meeting]));
    await send();
    expect(await reminders(meeting)).toHaveLength(2);
  });

  it("a suspended member is not reminded; a muted kind is not stored", async () => {
    const suspended = await addMember(org, owner.id, "member", "remind-suspended");
    const muted = await addMember(org, owner.id, "member", "remind-muted");
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]));
    await asUser(muted.id, (q) => q("select public.set_notification_settings($1, '{}')", [["meeting_reminder"]]));
    const meeting = await createMeeting(owner, "בלי מושעה", { startsIn: "10 minutes" });
    await asAdmin((q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3), ($1, $2, $4)", [org, meeting, suspended.id, muted.id]));
    await send();
    expect(await remindedUsers(meeting)).toEqual([owner.id]);
  });

  it("a read-only or suspended organization sends no reminders until it is active again", async () => {
    const boss = await createUser("remind-ro-owner");
    const roOrg = await createOrg(boss.id);
    const meeting = await asUser(boss.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'בארגון מוקפא', now() + interval '10 minutes', now() + interval '70 minutes') returning id",
          [roOrg],
        )
      ).rows[0].id,
    );
    const sentTo = () => asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and type = 'meeting_reminder' and entity_id = $2", [roOrg, meeting]));
    for (const state of ["read_only", "suspended"]) {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [state, roOrg]));
      await send();
      expect(await sentTo(), state).toBe(0);
    }
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [roOrg]));
    await send();
    expect(await sentTo()).toBe(1);
  });

  it("only the server sends reminders and reads what was sent", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select app.send_meeting_reminders()")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select 1 from app.meeting_reminders_sent")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'meeting_reminder', 'x')", [org, owner.id])))).code).toBe("42501");
  });

  it("a deleted meeting takes its sent marks with it", async () => {
    const meeting = await createMeeting(owner, "פגישה למחיקה", { startsIn: "10 minutes" });
    await send();
    expect(await asAdmin((q) => count(q, "select 1 from app.meeting_reminders_sent where meeting_id = $1", [meeting]))).toBe(1);
    await asUser(owner.id, (q) => q("delete from public.meetings where id = $1", [meeting]));
    expect(await asAdmin((q) => count(q, "select 1 from app.meeting_reminders_sent where meeting_id = $1", [meeting]))).toBe(0);
  });
});
