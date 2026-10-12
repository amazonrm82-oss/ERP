import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * RVW-1: a meeting that took place is contact with the customer. Marking it
 * "held" writes one timeline entry (type 'meeting') on its records, so last
 * contact, the waiting leads screen, the activity report and the card summary
 * see it; a planned meeting is a next step for stuck deals and the card summary.
 */
describe("a held meeting counts as contact (RVW-1)", () => {
  let owner: U, rep: U, other: U;
  let org: string;

  const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

  const newMeeting = (
    user: U,
    links: { lead?: string; contact?: string; deal?: string },
    opts: { start?: string; end?: string; status?: string; title?: string } = {},
  ) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, lead_id, contact_id, deal_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [org, opts.title ?? "פגישת היכרות", opts.start ?? hoursAgo(3), opts.end ?? hoursAgo(2), opts.status ?? "planned", links.lead ?? null, links.contact ?? null, links.deal ?? null],
        )
      ).rows[0].id,
    );

  const setStatus = (user: U, meeting: string, status: string, outcome: string | null = null) =>
    asUser(user.id, async (q) =>
      (await q("update public.meetings set status = $3, outcome = $4 where organization_id = $1 and id = $2 returning id", [org, meeting, status, outcome])).rowCount,
    );

  const entries = (meeting: string) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string; type: string; body: string; occurred_at: Date; created_by: string | null; lead_id: string | null; contact_id: string | null; deal_id: string | null }>(
          "select id, type, body, occurred_at, created_by, lead_id, contact_id, deal_id from public.activities where organization_id = $1 and metadata ->> 'meeting_id' = $2",
          [org, meeting],
        )
      ).rows,
    );

  const lastContact = (lead: string) =>
    asAdmin(async (q) => (await q<{ last: Date | null }>("select last_contacted_at as last from public.leads where id = $1", [lead])).rows[0].last);

  // the question src/features/leads/waiting.ts asks, with the user's rights
  const answered = (user: U, lead: string) =>
    asUser(user.id, (q) =>
      count(
        q,
        "select 1 from public.activities where organization_id = $1 and lead_id = $2 and type = any(array['note','call','meeting','email','whatsapp','sms']) and created_by is not null",
        [org, lead],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("mc-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "mc-rep");
    other = await addMember(org, owner.id, "member", "mc-other");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("marking a meeting held stamps last contact, takes the lead off the waiting list, and writes one timeline entry", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "ליד שנפגשו איתו" });
    const start = hoursAgo(5);
    const meeting = await newMeeting(rep, { lead }, { start, end: hoursAgo(4) });
    expect(await entries(meeting)).toHaveLength(0);
    expect(await lastContact(lead)).toBeNull();
    expect(await answered(rep, lead)).toBe(0);

    expect(await setStatus(rep, meeting, "held", "סוכם לשלוח הצעה")).toBe(1);
    const rows = await entries(meeting);
    expect(rows).toHaveLength(1);
    // the organizer (rep) is the author
    expect(rows[0]).toMatchObject({ type: "meeting", created_by: rep.id, lead_id: lead, contact_id: null, deal_id: null });
    expect(rows[0].body).toBe("פגישת היכרות\n\nסוכם לשלוח הצעה");
    expect(rows[0].occurred_at.toISOString()).toBe(new Date(start).toISOString());
    expect((await lastContact(lead))?.toISOString()).toBe(new Date(start).toISOString());
    expect(await answered(rep, lead)).toBe(1);
  });

  it("appears once, even when un-marked and marked held again; un-marking leaves the entry", async () => {
    const lead = await insertLead(rep.id, org);
    const meeting = await newMeeting(rep, { lead });
    await setStatus(rep, meeting, "held");
    await setStatus(rep, meeting, "planned");
    expect(await entries(meeting)).toHaveLength(1);
    await setStatus(rep, meeting, "held", "שוב");
    await setStatus(rep, meeting, "held", "ושוב");
    const rows = await entries(meeting);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("פגישת היכרות");
  });

  it("a meeting saved as held right away writes its entry too", async () => {
    const lead = await insertLead(rep.id, org);
    const meeting = await newMeeting(rep, { lead }, { status: "held" });
    expect(await entries(meeting)).toHaveLength(1);
    expect(await answered(rep, lead)).toBe(1);
  });

  it("an internal meeting (no linked record) writes nothing", async () => {
    const meeting = await newMeeting(rep, {});
    expect(await setStatus(rep, meeting, "held", "פגישת צוות")).toBe(1);
    expect(await entries(meeting)).toHaveLength(0);
  });

  it("cancelled or no-show is not contact", async () => {
    const lead = await insertLead(rep.id, org);
    const meeting = await newMeeting(rep, { lead });
    await setStatus(rep, meeting, "no_show");
    await setStatus(rep, meeting, "cancelled");
    expect(await entries(meeting)).toHaveLength(0);
    expect(await lastContact(lead)).toBeNull();
  });

  it("a meeting marked held before its start is dated now, so it counts", async () => {
    const lead = await insertLead(rep.id, org);
    const meeting = await newMeeting(rep, { lead }, { start: hoursAgo(-24), end: hoursAgo(-25) });
    await setStatus(rep, meeting, "held");
    const [row] = await entries(meeting);
    expect(row.occurred_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await lastContact(lead)).not.toBeNull();
  });

  it("a participant who cannot see the lead may mark it held; the organizer is the author, and the participant cannot reach the entry", async () => {
    const lead = await insertLead(rep.id, org);
    const meeting = await newMeeting(rep, { lead });
    await asUser(rep.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, meeting, other.id]));
    expect(await setStatus(other, meeting, "held", "הלך טוב")).toBe(1);
    const [row] = await entries(meeting);
    expect(row.created_by).toBe(rep.id);
    expect(await answered(rep, lead)).toBe(1);
    expect(await answered(other, lead)).toBe(0);
    // not the author, cannot see the lead: no edit, no delete
    expect((await asUser(other.id, (q) => q("update public.activities set body = 'x' where id = $1", [row.id]))).rowCount).toBe(0);
    expect((await asUser(other.id, (q) => q("delete from public.activities where id = $1", [row.id]))).rowCount).toBe(0);
    expect((await entries(meeting))[0].body).toBe("פגישת היכרות\n\nהלך טוב");
    // the activity report credits the organizer, not the participant
    const report = await asUser(owner.id, async (q) =>
      (
        await q<{ r: { by_user: { user_id: string; meeting: number }[] } }>(
          "select public.report_activity($1, now() - interval '2 days', now() + interval '1 day', $2) as r",
          [org, other.id],
        )
      ).rows[0].r,
    );
    expect(report.by_user.find((u) => u.user_id === other.id)?.meeting ?? 0).toBe(0);
  });

  it("the meeting_id key is the server's: a browser cannot forge it, change it or remove it", async () => {
    const lead = await insertLead(rep.id, org);
    const meeting = await newMeeting(rep, { lead });
    // forged on insert: refused, and the real entry is still written later
    const forged = await pgError(
      asUser(rep.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id, metadata) values ($1, 'meeting', 'מזויף', $2, jsonb_build_object('meeting_id', $3::text))", [org, lead, meeting]),
      ),
    );
    expect(forged).toMatchObject({ code: "42501", hint: "meeting:entry" });
    // forged on update of an ordinary entry
    const note = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'meeting', 'רגילה', $2) returning id", [org, lead])).rows[0].id,
    );
    const onUpdate = await pgError(
      asUser(rep.id, (q) => q("update public.activities set metadata = jsonb_build_object('meeting_id', $2::text) where id = $1", [note, meeting])),
    );
    expect(onUpdate).toMatchObject({ code: "42501", hint: "meeting:entry" });
    // an ordinary metadata change is still fine
    expect((await asUser(rep.id, (q) => q("update public.activities set metadata = '{\"x\": 1}' where id = $1 returning id", [note]))).rowCount).toBe(1);

    await setStatus(rep, meeting, "held");
    const [entry] = await entries(meeting);
    expect(entry.created_by).toBe(rep.id);
    // the author may not remove or change the key either
    const removed = await pgError(asUser(rep.id, (q) => q("update public.activities set metadata = '{}' where id = $1", [entry.id])));
    expect(removed).toMatchObject({ code: "42501", hint: "meeting:entry" });
    const changed = await pgError(
      asUser(rep.id, (q) => q("update public.activities set metadata = jsonb_build_object('meeting_id', gen_random_uuid()::text) where id = $1", [entry.id])),
    );
    expect(changed).toMatchObject({ code: "42501", hint: "meeting:entry" });
    // keeping the key while editing the text is allowed
    expect(
      (await asUser(rep.id, (q) => q("update public.activities set body = 'עודכן', metadata = metadata || '{\"y\": 2}' where id = $1 returning id", [entry.id]))).rowCount,
    ).toBe(1);
    await setStatus(rep, meeting, "planned");
    await setStatus(rep, meeting, "held");
    expect(await entries(meeting)).toHaveLength(1);
  });

  it("the activity report counts it as the person's meeting", async () => {
    const lead = await insertLead(rep.id, org);
    const before = await asUser(owner.id, async (q) =>
      (
        await q<{ r: { by_user: { user_id: string; meeting: number }[] } }>(
          "select public.report_activity($1, now() - interval '2 days', now() + interval '1 day', $2) as r",
          [org, rep.id],
        )
      ).rows[0].r,
    );
    const meetingsBefore = before.by_user.find((u) => u.user_id === rep.id)?.meeting ?? 0;
    const meeting = await newMeeting(rep, { lead });
    await setStatus(rep, meeting, "held");
    const after = await asUser(owner.id, async (q) =>
      (
        await q<{ r: { by_user: { user_id: string; meeting: number }[] } }>(
          "select public.report_activity($1, now() - interval '2 days', now() + interval '1 day', $2) as r",
          [org, rep.id],
        )
      ).rows[0].r,
    );
    expect(after.by_user.find((u) => u.user_id === rep.id)?.meeting).toBe(meetingsBefore + 1);
  });

  it("a deal with a planned meeting ahead has a next step; one that already ended does not", async () => {
    const { pipelineId, stages } = await defaultPipeline(org);
    const stage = stages.find((s) => s.kind === "open")!.id;
    const deal = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה עם פגישה', $2, $3) returning id",
          [org, pipelineId, stage],
        )
      ).rows[0].id,
    );
    const stuck = async () =>
      asUser(owner.id, async (q) =>
        ((await q<{ r: { id: string; no_next_step: boolean; next_meeting_at: string | null }[] }>("select public.report_stuck_deals($1) as r", [org])).rows[0].r).find(
          (row) => row.id === deal,
        ),
      );
    expect((await stuck())?.no_next_step).toBe(true);

    // planned, but already over: not a next step
    await newMeeting(rep, { deal }, { start: hoursAgo(3), end: hoursAgo(2) });
    expect((await stuck())?.no_next_step).toBe(true);

    await newMeeting(rep, { deal }, { start: hoursAgo(-48), end: hoursAgo(-49) });
    // not idle and with a next step: off the stuck list
    expect(await stuck()).toBeUndefined();
  });

  it("the card summary shows the next planned meeting of a contact", async () => {
    const contact = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    const summary = () =>
      asUser(rep.id, async (q) =>
        (await q<{ s: { next_meeting: { id: string; title: string } | null } }>("select public.record_summary($1, 'contact', $2) as s", [org, contact])).rows[0].s,
      );
    expect((await summary()).next_meeting).toBeNull();
    await newMeeting(rep, { contact }, { title: "מאוחרת", start: hoursAgo(-72), end: hoursAgo(-73) });
    const soon = await newMeeting(rep, { contact }, { title: "קרובה", start: hoursAgo(-24), end: hoursAgo(-25) });
    await newMeeting(rep, { contact }, { title: "בוטלה", start: hoursAgo(-2), end: hoursAgo(-3), status: "cancelled" });
    expect((await summary()).next_meeting).toMatchObject({ id: soon, title: "קרובה" });
    // another member who cannot see the contact or the meeting gets nothing
    const hidden = await asUser(other.id, async (q) =>
      (await q<{ s: { next_meeting: unknown } }>("select public.record_summary($1, 'contact', $2) as s", [org, contact])).rows[0].s,
    );
    expect(hidden.next_meeting).toBeNull();
  });

  it("the trigger function is not callable by clients", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ anon: boolean; auth: boolean }>(
          `select has_function_privilege('anon', 'app.meeting_held_activity()', 'execute')
                  or has_function_privilege('anon', 'app.activities_verify_meeting_entry()', 'execute') as anon,
                  has_function_privilege('authenticated', 'app.meeting_held_activity()', 'execute')
                  or has_function_privilege('authenticated', 'app.activities_verify_meeting_entry()', 'execute') as auth`,
        )
      ).rows[0],
    );
    expect(grants).toEqual({ anon: false, auth: false });
  });
});
