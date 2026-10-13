import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Summary = {
  next_task: { id: string; due_at: string | null } | null;
  next_meeting: { id: string; title: string; starts_at: string } | null;
  open_tasks: number;
};

/**
 * REC-10 follow-up (after CAL-01): on a contact or company card a planned meeting
 * is a next action too. public.record_summary() returns the nearest planned
 * meeting that has not ended (next_meeting) next to the nearest open task
 * (next_task); the card shows whichever comes first. The function is security
 * invoker, so RLS (meetings_select, contacts_select) decides which meeting a
 * viewer gets: never one they cannot read.
 */
describe("record_summary: the next planned meeting as a next action", () => {
  let owner: U, rep: U;
  let org: string;
  let company: string, ownersContact: string, repsContact: string;

  const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

  const newMeeting = (user: U, links: { contact?: string; company?: string }, start: string, end: string, title: string, status = "planned") =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, contact_id, company_id)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [org, title, start, end, status, links.contact ?? null, links.company ?? null],
        )
      ).rows[0].id,
    );

  const summary = (user: U, type: "contact" | "company", id: string) =>
    asUser(user.id, async (q) => (await q<{ s: Summary }>("select public.record_summary($1, $2, $3) as s", [org, type, id])).rows[0].s);

  beforeAll(async () => {
    owner = await createUser("snm-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "snm-rep");
    // members see only what they own
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    company = await asUser(rep.id, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברת פגישות') returning id", [org])).rows[0].id,
    );
    ownersContact = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id) values ($1, 'של הבעלים', $2) returning id", [
          org,
          company,
        ])
      ).rows[0].id,
    );
    repsContact = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.contacts (organization_id, first_name, company_id) values ($1, 'של הנציג', $2) returning id", [
          org,
          company,
        ])
      ).rows[0].id,
    );
  });

  it("ignores cancelled, no-show, held and ended meetings; the nearest planned one wins", async () => {
    expect((await summary(rep, "contact", repsContact)).next_meeting).toBeNull();
    await newMeeting(rep, { contact: repsContact }, hours(1), hours(2), "בוטלה", "cancelled");
    await newMeeting(rep, { contact: repsContact }, hours(1), hours(2), "לא הגיע", "no_show");
    await newMeeting(rep, { contact: repsContact }, hours(-3), hours(-2), "התקיימה", "held");
    await newMeeting(rep, { contact: repsContact }, hours(-5), hours(-4), "עברה ולא סומנה");
    expect((await summary(rep, "contact", repsContact)).next_meeting).toBeNull();

    await newMeeting(rep, { contact: repsContact }, hours(72), hours(73), "מאוחרת");
    const nearer = await newMeeting(rep, { contact: repsContact }, hours(24), hours(25), "קרובה");
    const s = await summary(rep, "contact", repsContact);
    expect(s.next_meeting).toMatchObject({ id: nearer, title: "קרובה" });
    expect(Date.parse(s.next_meeting!.starts_at)).toBeGreaterThan(Date.now());
  });

  it("a meeting that has started and not ended yet still counts", async () => {
    const now = await newMeeting(rep, { contact: repsContact }, hours(-0.5), hours(0.5), "עכשיו");
    try {
      expect((await summary(rep, "contact", repsContact)).next_meeting?.id).toBe(now);
    } finally {
      await asUser(rep.id, (q) => q("update public.meetings set status = 'cancelled' where organization_id = $1 and id = $2", [org, now]));
    }
  });

  it("returns the task and the meeting side by side, so the card can show the earlier one", async () => {
    const task = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.tasks (organization_id, title, due_at, contact_id) values ($1, 'להתקשר', $2, $3) returning id", [
          org,
          hours(48),
          repsContact,
        ])
      ).rows[0].id,
    );
    const s = await summary(rep, "contact", repsContact);
    expect(s.next_task?.id).toBe(task);
    expect(s.open_tasks).toBe(1);
    expect(s.next_meeting?.title).toBe("קרובה");
    expect(Date.parse(s.next_meeting!.starts_at)).toBeLessThan(Date.parse(s.next_task!.due_at!));
  });

  it("a company counts its own meetings and its live contacts'", async () => {
    const own = await newMeeting(rep, { company }, hours(12), hours(13), "של החברה");
    expect((await summary(rep, "company", company)).next_meeting?.id).toBe(own);
    const viaContact = await newMeeting(rep, { contact: repsContact }, hours(6), hours(7), "דרך איש הקשר");
    expect((await summary(rep, "company", company)).next_meeting?.id).toBe(viaContact);
    // a contact in the recycle bin no longer counts for the company
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [repsContact]));
    try {
      expect((await summary(rep, "company", company)).next_meeting?.id).toBe(own);
    } finally {
      await asAdmin((q) => q("update public.contacts set deleted_at = null where id = $1", [repsContact]));
    }
  });

  it("never reveals a meeting the viewer may not read", async () => {
    // the owner's meeting with the owner's contact, sooner than all of the rep's
    const hidden = await newMeeting(owner, { contact: ownersContact }, hours(2), hours(3), "פגישה של הבעלים");
    expect((await summary(owner, "company", company)).next_meeting?.id).toBe(hidden);
    // the rep reads the company, but neither the owner's contact nor the meeting
    const forRep = await summary(rep, "company", company);
    expect(forRep.next_meeting?.id).not.toBe(hidden);
    expect(forRep.next_meeting?.title).toBe("דרך איש הקשר");
    const seen = await asUser(rep.id, async (q) => (await q("select 1 from public.meetings where id = $1", [hidden])).rowCount);
    expect(seen).toBe(0);
  });

  it("someone from another organization gets no meeting", async () => {
    const outsider = await createUser("snm-outsider");
    await createOrg(outsider.id, "עסק אחר");
    expect((await summary(outsider, "company", company)).next_meeting).toBeNull();
    expect((await summary(outsider, "contact", repsContact)).next_meeting).toBeNull();
  });

  it("still runs with the caller's rights and is not open to anon", async () => {
    const row = await asAdmin(
      async (q) =>
        (
          await q<{ definer: boolean; anon: boolean; auth: boolean }>(
            `select p.prosecdef as definer,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as auth
               from pg_proc p where p.oid = 'public.record_summary(uuid, text, uuid)'::regprocedure`,
          )
        ).rows[0],
    );
    expect(row).toEqual({ definer: false, anon: false, auth: true });
  });
});
