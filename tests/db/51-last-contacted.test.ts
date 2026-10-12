import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// LEAD-02: last_contacted_at of a lead / contact follows the contact entries a person logs.
describe("last contact from the timeline (LEAD-02)", () => {
  let owner: U, author: U, colleague: U, stranger: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("lc-owner");
    org = await createOrg(owner.id);
    author = await addMember(org, owner.id, "member", "lc-author");
    colleague = await addMember(org, owner.id, "member", "lc-colleague");
    stranger = await createUser("lc-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
  });

  const leadRow = (id: string) =>
    asAdmin(async (q) =>
      (await q<{ last: Date | null; updated_at: Date; updated_by: string | null }>("select last_contacted_at as last, updated_at, updated_by from public.leads where id = $1", [id])).rows[0],
    );
  const log = (user: U, lead: string, type = "note", occurred: string | null = null) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string; occurred_at: Date }>(
          "insert into public.activities (organization_id, type, body, lead_id, occurred_at) values ($1, $2, 'שיחה', $3, coalesce($4::timestamptz, now())) returning id, occurred_at",
          [org, type, lead, occurred],
        )
      ).rows[0],
    );

  it("a note, call, meeting, email, WhatsApp or SMS a person logs sets the lead's last contact", async () => {
    for (const type of ["note", "call", "meeting", "email", "whatsapp", "sms"]) {
      const lead = await insertLead(author.id, org);
      expect((await leadRow(lead)).last).toBeNull();
      const entry = await log(author, lead, type);
      expect((await leadRow(lead)).last?.toISOString(), type).toBe(entry.occurred_at.toISOString());
    }
  });

  it("other entry types and entries no person wrote do not count", async () => {
    const lead = await insertLead(author.id, org);
    await log(author, lead, "status_change");
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'מערכת', $2)", [org, lead]));
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'inquiry', 'פנייה', $2)", [org, lead]));
    expect((await leadRow(lead)).last).toBeNull();
  });

  it("only moves forward; a future entry is not contact yet; an older one does not move it back", async () => {
    const lead = await insertLead(author.id, org);
    const first = await log(author, lead, "call", new Date(Date.now() - 3 * 86_400_000).toISOString());
    expect((await leadRow(lead)).last?.toISOString()).toBe(first.occurred_at.toISOString());
    await log(author, lead, "meeting", new Date(Date.now() + 2 * 86_400_000).toISOString());
    expect((await leadRow(lead)).last?.toISOString()).toBe(first.occurred_at.toISOString());
    await log(author, lead, "note", new Date(Date.now() - 10 * 86_400_000).toISOString());
    expect((await leadRow(lead)).last?.toISOString()).toBe(first.occurred_at.toISOString());
    // moving the entry's time later moves the last contact with it
    const later = new Date(Date.now() - 86_400_000).toISOString();
    expect(await asUser(author.id, async (q) => (await q("update public.activities set occurred_at = $1 where id = $2", [later, first.id])).rowCount)).toBe(1);
    expect((await leadRow(lead)).last?.toISOString()).toBe(new Date(later).toISOString());
  });

  it("works for someone who may log on the lead but may not edit it, and is not an edit of the lead", async () => {
    const lead = await insertLead(author.id, org);
    const before = await leadRow(lead);
    // the colleague cannot edit the author's lead
    expect(await asUser(colleague.id, async (q) => (await q("update public.leads set full_name = 'x' where id = $1", [lead])).rowCount)).toBe(0);
    await log(colleague, lead, "call");
    const after = await leadRow(lead);
    expect(after.last).not.toBeNull();
    expect(after.updated_at.toISOString()).toBe(before.updated_at.toISOString());
    expect(after.updated_by).toBe(before.updated_by);
    // no automation starts from it: the event is written already handled, marked as an automation's
    const events = await asAdmin(async (q) =>
      (await q<{ origin: string | null; processed: boolean }>("select payload ->> 'origin' as origin, processed_at is not null as processed from public.outbox_events where entity_id = $1 and event_type = 'lead.updated'", [lead])).rows,
    );
    expect(events).toEqual([{ origin: "automation", processed: true }]);
    // the flags are back to what they were after the stamp
    const flags = await asUser(author.id, async (q) => {
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'עוד', $2)", [org, lead]);
      return (await q<{ a: string | null; c: string | null }>("select current_setting('app.automation_running', true) as a, current_setting('app.contact_stamp', true) as c")).rows[0];
    });
    expect(flags.a ?? "").not.toBe("on");
    expect(flags.c ?? "").not.toBe("on");
    // a real edit afterwards is still a normal update
    await asUser(author.id, (q) => q("update public.leads set full_name = 'שם חדש' where id = $1", [lead]));
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1 and event_type = 'lead.updated' and processed_at is null", [lead]))).toBe(1);
  });

  it("inside an automation run the automation flag stays on after the stamp", async () => {
    const lead = await insertLead(author.id, org);
    const flag = await asAdmin(async (q) => {
      await q("select set_config('app.automation_running', 'on', true)");
      await q("insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'note', 'אוטומציה', $2, $3)", [org, lead, author.id]);
      return (await q<{ a: string }>("select current_setting('app.automation_running', true) as a")).rows[0].a;
    });
    expect(flag).toBe("on");
    expect((await leadRow(lead)).last).not.toBeNull();
  });

  it("sets the contact's last contact too, and touches only the record the entry belongs to", async () => {
    const contact = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    const other = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'רון') returning id", [org])).rows[0].id,
    );
    await asUser(author.id, (q) => q("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'whatsapp', 'הודעה', $2)", [org, contact]));
    const last = (id: string) => asAdmin(async (q) => (await q<{ last: Date | null }>("select last_contacted_at as last from public.contacts where id = $1", [id])).rows[0].last);
    expect(await last(contact)).not.toBeNull();
    expect(await last(other)).toBeNull();
  });

  it("another organization's entries cannot reach this organization's lead", async () => {
    const lead = await insertLead(author.id, org);
    const error = await pgError(
      asUser(stranger.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'זר', $2)", [otherOrg, lead])),
    );
    expect(error.code).toBe("42501");
    const blocked = await pgError(asUser(stranger.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'זר', $2)", [org, lead])));
    expect(blocked.code).toBe("42501");
    expect((await leadRow(lead)).last).toBeNull();
  });

  it("while the stamp flag is on, nothing but the last contact may change", async () => {
    const lead = await insertLead(author.id, org);
    const error = await pgError(
      asAdmin(async (q) => {
        await q("select set_config('app.contact_stamp', 'on', true)");
        await q("update public.leads set full_name = 'x' where id = $1", [lead]);
      }),
    );
    expect(error.code).toBe("42501");
  });
});
