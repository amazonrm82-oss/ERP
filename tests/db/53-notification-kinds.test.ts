import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const ALL_KINDS = [
  "assigned", "task_reminder", "inquiry", "automation", "lead_new", "mention", "follow",
  "meeting_scheduled", "meeting_reminder", "meeting_cancelled", "automation_failed", "quote", "payment", "response_overdue",
];

/** USR-06: the full list of notification kinds, meeting_scheduled and automation_failed. */
describe("notification kinds", () => {
  let owner: U, admin: U, manager: U, rep: U, other: U, spare: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("kinds-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "kinds-admin");
    manager = await addMember(org, owner.id, "manager", "kinds-manager");
    rep = await addMember(org, owner.id, "member", "kinds-rep");
    other = await addMember(org, owner.id, "member", "kinds-other");
    spare = await addMember(org, owner.id, "member", "kinds-spare");
  });

  const notes = (userId: string, type: string) =>
    asAdmin(async (q) =>
      (await q<{ title: string; body: string | null; entity_type: string | null; entity_id: string | null }>(
        "select title, body, entity_type, entity_id from public.notifications where user_id = $1 and organization_id = $2 and type = $3 order by created_at",
        [userId, org, type],
      )).rows,
    );

  it("every kind can be stored and chosen; 'system' only stored; anything else is refused", async () => {
    await asAdmin(async (q) => {
      for (const kind of [...ALL_KINDS, "system"]) {
        await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, $3, 'x')", [org, spare.id, kind]);
      }
      expect(await count(q, "select 1 from public.notifications where user_id = $1", [spare.id])).toBe(ALL_KINDS.length + 1);
    });
    expect((await pgError(asAdmin((q) => q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'whatever', 'x')", [org, spare.id])))).code).toBe("23514");
    await asUser(spare.id, (q) => q("select public.set_notification_settings($1, $2)", [ALL_KINDS, []]));
    await asUser(spare.id, (q) => q("select public.set_notification_settings($1, $2)", [[], ALL_KINDS]));
    expect((await pgError(asUser(spare.id, (q) => q("select public.set_notification_settings($1, '{}')", [["system"]])))).code).toBe("23514");
    expect((await pgError(asUser(spare.id, (q) => q("select public.set_notification_settings('{}', $1)", [["nope"]])))).code).toBe("23514");
    // a new kind obeys the user's choice like the old ones
    await asUser(spare.id, (q) => q("select public.set_notification_settings($1, '{}')", [["mention"]]));
    await asAdmin((q) => q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'mention', 'מושתק')", [org, spare.id]));
    expect((await notes(spare.id, "mention")).map((n) => n.title)).toEqual(["x"]);
    await asUser(spare.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
  });

  describe("meeting scheduled", () => {
    const createMeeting = (as: U, title: string, opts: { owner?: string; startsIn?: string; status?: string } = {}) =>
      asUser(as.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.meetings (organization_id, title, starts_at, ends_at, status, owner_id)
             values ($1, $2, now() + $3::interval, now() + $3::interval + interval '1 hour', $4, $5) returning id`,
            [org, title, opts.startsIn ?? "2 days", opts.status ?? "planned", opts.owner ?? null],
          )
        ).rows[0].id,
      );
    const addParticipant = (as: U, meeting: string, userId: string) =>
      asUser(as.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, meeting, userId]));

    it("a team member put in a meeting by someone else is told once, with the time and a link", async () => {
      const meeting = await createMeeting(rep, "פגישת היכרות");
      await addParticipant(rep, meeting, rep.id); // themselves: nothing
      await addParticipant(rep, meeting, other.id);
      expect(await notes(rep.id, "meeting_scheduled")).toEqual([]);
      const told = await notes(other.id, "meeting_scheduled");
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ title: "נקבעה לכם פגישה: פגישת היכרות", entity_type: "meeting", entity_id: meeting });
      expect(told[0].body).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
    });

    it("the organizer set by someone else is told once, even when also added as a participant", async () => {
      const meeting = await createMeeting(owner, "פגישה עם ספק", { owner: manager.id });
      await addParticipant(owner, meeting, manager.id);
      const told = await notes(manager.id, "meeting_scheduled");
      expect(told.filter((n) => n.entity_id === meeting)).toHaveLength(1);
      // handing it over to someone else tells them
      await asUser(owner.id, (q) => q("update public.meetings set owner_id = $1 where id = $2", [admin.id, meeting]));
      expect((await notes(admin.id, "meeting_scheduled")).filter((n) => n.entity_id === meeting)).toHaveLength(1);
    });

    it("past or cancelled meetings, and the person who did it, are not told", async () => {
      const past = await createMeeting(owner, "פגישה שהייתה", { startsIn: "-2 days" });
      const cancelled = await createMeeting(owner, "פגישה שבוטלה", { status: "cancelled" });
      await addParticipant(owner, past, rep.id);
      await addParticipant(owner, cancelled, rep.id);
      const own = await createMeeting(owner, "שלי");
      await addParticipant(owner, own, owner.id);
      const told = [...(await notes(rep.id, "meeting_scheduled")), ...(await notes(owner.id, "meeting_scheduled"))];
      expect(told.filter((n) => [past, cancelled, own].includes(n.entity_id ?? ""))).toEqual([]);
    });

    it("a suspended member is not told", async () => {
      const suspended = await addMember(org, owner.id, "member", "kinds-suspended");
      await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]));
      const meeting = await createMeeting(owner, "פגישה בלי מושעה");
      // inserted by the server: the client policies may refuse a suspended member anyway
      await asAdmin((q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, meeting, suspended.id]));
      expect(await notes(suspended.id, "meeting_scheduled")).toEqual([]);
    });

    it("a handover of someone's meetings sends no meeting notice to the new organizer", async () => {
      const leaving = await addMember(org, owner.id, "member", "kinds-leaving");
      const taking = await addMember(org, owner.id, "member", "kinds-taking");
      const meeting = await createMeeting(leaving, "פגישה שעוברת");
      const moved = await asUser(owner.id, async (q) =>
        (await q<{ r: { meetings: number } }>("select public.transfer_records($1, $2, $3) as r", [org, leaving.id, taking.id])).rows[0].r,
      );
      expect(moved.meetings).toBe(1);
      expect(await asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.meetings where id = $1", [meeting])).rows[0].owner_id)).toBe(taking.id);
      expect(await notes(taking.id, "meeting_scheduled")).toEqual([]);
    });

    it("merging records moves their meetings without meeting notices", async () => {
      const keep = await insertLead(rep.id, org, { full_name: "ליד לשמירה" });
      const dup = await insertLead(rep.id, org, { full_name: "ליד כפול" });
      const meeting = await asUser(rep.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id)
             values ($1, 'פגישה עם הכפול', now() + interval '3 days', now() + interval '3 days 1 hour', $2) returning id`,
            [org, dup],
          )
        ).rows[0].id,
      );
      await addParticipant(rep, meeting, manager.id);
      const before = await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and type = 'meeting_scheduled'", [org]));
      await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dup]));
      expect(await asAdmin(async (q) => (await q<{ lead_id: string }>("select lead_id from public.meetings where id = $1", [meeting])).rows[0].lead_id)).toBe(keep);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and type = 'meeting_scheduled'", [org]))).toBe(before);
    });

    it("a member who muted it gets nothing", async () => {
      await asUser(other.id, (q) => q("select public.set_notification_settings($1, '{}')", [["meeting_scheduled"]]));
      const meeting = await createMeeting(rep, "פגישה שקטה");
      await addParticipant(rep, meeting, other.id);
      expect((await notes(other.id, "meeting_scheduled")).filter((n) => n.entity_id === meeting)).toEqual([]);
      await asUser(other.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
    });
  });

  describe("automation failed", () => {
    let otherOrgTag: string;

    beforeAll(async () => {
      const stranger = await createUser("kinds-stranger");
      const otherOrg = await createOrg(stranger.id, "עסק אחר");
      otherOrgTag = await asUser(stranger.id, async (q) =>
        (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id,
      );
      await asAdmin((q) => q("select app.process_outbox(5000)")); // start from a clean queue
    });

    const createRule = (name: string, actions: unknown[]) =>
      asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, actions)
             values ($1, $2, 'lead', 'created', $3) returning id`,
            [org, name, JSON.stringify(actions)],
          )
        ).rows[0].id,
      );
    const processOutbox = () => asAdmin((q) => q("select app.process_outbox(5000)"));
    const deactivate = (id: string) => asUser(owner.id, (q) => q("update public.automations set is_active = false where id = $1", [id]));

    it("owners and admins are told when a run fails, at most once a day per rule; others are not", async () => {
      const rule = await createRule("תיוג שבור", [{ type: "add_tag", tag_id: otherOrgTag }]);
      await insertLead(rep.id, org, { full_name: "ליד ראשון" });
      await processOutbox();
      expect(await asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and status = 'failed'", [rule]))).toBe(1);
      for (const boss of [owner, admin]) {
        const told = await notes(boss.id, "automation_failed");
        expect(told).toEqual([
          { title: "אוטומציה נכשלה: תיוג שבור", body: "אפשר לראות מה לא עבד ביומן ההרצות של האוטומציה.", entity_type: "automation", entity_id: rule },
        ]);
      }
      for (const nobody of [manager, rep]) {
        expect(await notes(nobody.id, "automation_failed")).toEqual([]);
      }

      // the next failure the same day: no second notice, read or not
      await insertLead(rep.id, org, { full_name: "ליד שני" });
      await processOutbox();
      expect(await notes(owner.id, "automation_failed")).toHaveLength(1);
      await asUser(owner.id, (q) => q("update public.notifications set read_at = now() where type = 'automation_failed'"));
      await insertLead(rep.id, org, { full_name: "ליד שלישי" });
      await processOutbox();
      expect(await notes(owner.id, "automation_failed")).toHaveLength(1);

      // a day later the rule still fails: told again
      await asAdmin((q) => q("update public.notifications set created_at = now() - interval '25 hours' where type = 'automation_failed' and entity_id = $1", [rule]));
      await insertLead(rep.id, org, { full_name: "ליד רביעי" });
      await processOutbox();
      expect(await notes(owner.id, "automation_failed")).toHaveLength(2);
      expect(await notes(admin.id, "automation_failed")).toHaveLength(2);
      await deactivate(rule);
    });

    it("a partly failed run says so; a successful run tells nobody", async () => {
      const partial = await createRule("חצי עובד", [
        { type: "add_tag", tag_id: otherOrgTag },
        { type: "create_task", title: "משימה" },
      ]);
      const fine = await createRule("עובד", [{ type: "create_task", title: "משימה תקינה" }]);
      await insertLead(rep.id, org, { full_name: "ליד חמישי" });
      await processOutbox();
      expect((await notes(admin.id, "automation_failed")).filter((n) => n.entity_id === partial).map((n) => n.title)).toEqual([
        "אוטומציה נכשלה בחלקה: חצי עובד",
      ]);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1", [fine]))).toBe(0);
      await deactivate(partial);
      await deactivate(fine);
    });

    it("clients cannot fake a run's status to send notices", async () => {
      expect((await pgError(asUser(owner.id, (q) => q("update public.automation_runs set status = 'failed'")))).code).toBe("42501");
    });
  });
});
