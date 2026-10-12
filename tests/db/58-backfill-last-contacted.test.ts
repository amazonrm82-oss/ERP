import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, closePool, createOrg, createUser, insertLead, TEST_DB_URL } from "./helpers";

afterAll(closePool);

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20261006008000_backfill_last_contacted.sql"), "utf8");

type U = { id: string };
type Subject = { lead_id?: string; contact_id?: string };
type Entry = { type: string; at: Date; author: string | null; isPrivate?: boolean };

const DAY = 86_400_000;

/** Runs the migration text on its own connection and returns its notices. */
async function runBackfill(preamble?: string): Promise<{ notices: string[]; flags?: { a: string | null; c: string | null } }> {
  const client = new Client({ connectionString: TEST_DB_URL });
  const notices: string[] = [];
  client.on("notice", (n) => notices.push(n.message ?? ""));
  await client.connect();
  try {
    await client.query("begin");
    if (preamble) await client.query(preamble);
    await client.query(MIGRATION);
    const flags = (
      await client.query<{ a: string | null; c: string | null }>(
        "select current_setting('app.automation_running', true) as a, current_setting('app.contact_stamp', true) as c",
      )
    ).rows[0];
    await client.query("commit");
    return { notices, flags };
  } finally {
    await client.end();
  }
}

const filled = (notices: string[]) => {
  const line = notices.find((n) => n.includes("leads filled"));
  const m = line?.match(/leads filled (\d+), contacts filled (\d+)/);
  return m ? { leads: Number(m[1]), contacts: Number(m[2]) } : undefined;
};

// LEAD-02 backfill (owner's go-ahead of 12 October 2026): records with no last contact get it from the timeline.
describe("one-time backfill of last contact (LEAD-02)", () => {
  let owner: U, author: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("bf-owner");
    org = await createOrg(owner.id);
    author = await addMember(org, owner.id, "member", "bf-author");
  });

  const newContact = (name: string) =>
    asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone, email, created_by) values ($1, $2, '050-1234567', 'a@b.co', $3) returning id", [org, name, author.id]))
        .rows[0].id,
    );

  /** An entry logged the normal way: the live trigger stamps it. */
  const logLive = (subject: Subject, e: Entry) =>
    asAdmin((q) =>
      q(
        "insert into public.activities (organization_id, type, body, lead_id, contact_id, occurred_at, created_by, is_private) values ($1, $2, 'x', $3, $4, $5, $6, $7)",
        [org, e.type, subject.lead_id ?? null, subject.contact_id ?? null, e.at, e.author, e.isPrivate ?? false],
      ),
    );
  /** An entry as it was logged before 0057: no trigger ran. */
  const logOld = (subject: Subject, e: Entry) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        "insert into public.activities (organization_id, type, body, lead_id, contact_id, occurred_at, created_by, is_private) values ($1, $2, 'x', $3, $4, $5, $6, $7)",
        [org, e.type, subject.lead_id ?? null, subject.contact_id ?? null, e.at, e.author, e.isPrivate ?? false],
      );
    });

  type Row = { last: Date | null; first: Date | null; updated_at: Date; updated_by: string | null };
  const leadRow = (id: string) =>
    asAdmin(async (q) =>
      (await q<Row>("select last_contacted_at as last, first_contacted_at as first, updated_at, updated_by from public.leads where id = $1", [id])).rows[0],
    );
  const contactRow = (id: string) =>
    asAdmin(async (q) =>
      (await q<Row>("select last_contacted_at as last, null::timestamptz as first, updated_at, updated_by from public.contacts where id = $1", [id])).rows[0],
    );
  const events = (id: string) =>
    asAdmin(async (q) =>
      (
        await q<{ origin: string | null; processed: boolean }>(
          "select payload ->> 'origin' as origin, processed_at is not null as processed from public.outbox_events where entity_id = $1 and event_type <> 'lead.created' and event_type <> 'contact.created' order by created_at",
          [id],
        )
      ).rows,
    );
  const notifications = (ids: string[]) =>
    asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.notifications where entity_id = any($1)", [ids])).rows[0].n));

  // the same timeline, logged on one record the live way and on another one before 0057
  const timeline = (base: number, authorId: string): Entry[] => [
    { type: "note", at: new Date(base - 5 * DAY), author: authorId },
    { type: "call", at: new Date(base - 1 * DAY), author: authorId }, // the latest that counts
    { type: "whatsapp", at: new Date(base - 3 * DAY), author: authorId },
    { type: "note", at: new Date(base), author: authorId, isPrivate: true }, // private
    { type: "status_change", at: new Date(base), author: authorId }, // system entry
    { type: "inquiry", at: new Date(base), author: authorId }, // not a contact type
    { type: "note", at: new Date(base), author: null }, // nobody wrote it
    { type: "meeting", at: new Date(Date.now() + 2 * DAY), author: authorId }, // planned
  ];

  it("fills exactly what the live stamp would, leaves set values alone, is not an edit, and runs twice harmlessly", async () => {
    const base = Date.now() - 10 * DAY;
    const entries = timeline(base, author.id);
    const expected = entries[1].at.toISOString();

    const liveLead = await insertLead(author.id, org);
    const oldLead = await insertLead(author.id, org);
    const liveContact = await newContact("חי");
    const oldContact = await newContact("ישן");
    for (const e of entries) {
      await logLive({ lead_id: liveLead }, e);
      await logOld({ lead_id: oldLead }, e);
      await logLive({ contact_id: liveContact }, e);
      await logOld({ contact_id: oldContact }, e);
    }

    // a record that already has a value keeps it, even with a newer old entry
    const setLead = await insertLead(author.id, org);
    await logLive({ lead_id: setLead }, { type: "call", at: new Date(base - 7 * DAY), author: author.id });
    await logOld({ lead_id: setLead }, { type: "call", at: new Date(base - 1 * DAY), author: author.id });
    const setBefore = await leadRow(setLead);
    expect(setBefore.last?.toISOString()).toBe(new Date(base - 7 * DAY).toISOString());

    // only entries that do not count: stays empty
    const noneLead = await insertLead(author.id, org);
    for (const e of [entries[3], entries[4], entries[5], entries[6], entries[7]]) await logOld({ lead_id: noneLead }, e);

    // in the recycle bin: filled like the live stamp would
    const trashedLead = await insertLead(author.id, org);
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [trashedLead]));
    await logOld({ lead_id: trashedLead }, entries[1]);

    // one entry on both a lead and a contact fills both
    const bothLead = await insertLead(author.id, org);
    const bothContact = await newContact("שניהם");
    await logOld({ lead_id: bothLead, contact_id: bothContact }, entries[0]);

    const ours = [oldLead, oldContact, setLead, noneLead, trashedLead, bothLead, bothContact];
    const before = new Map<string, Row>();
    for (const id of [oldLead, setLead, noneLead, trashedLead, bothLead]) before.set(id, await leadRow(id));
    for (const id of [oldContact, bothContact]) before.set(id, await contactRow(id));
    expect(before.get(oldLead)?.last).toBeNull();
    expect(before.get(oldContact)?.last).toBeNull();
    const auditBefore = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.audit_log where entity_id = any($1)", [ours])).rows[0].n));
    const notesBefore = await notifications(ours);
    const setEventsBefore = await events(setLead);

    const first = await runBackfill();
    const counts = filled(first.notices);
    expect(counts?.leads).toBeGreaterThanOrEqual(3);
    expect(counts?.contacts).toBeGreaterThanOrEqual(2);
    expect(first.notices.some((n) => n.includes("still without contact"))).toBe(true);

    // same result as the live trigger for the same timeline
    expect((await leadRow(liveLead)).last?.toISOString()).toBe(expected);
    expect((await leadRow(oldLead)).last?.toISOString()).toBe(expected);
    expect((await contactRow(liveContact)).last?.toISOString()).toBe(expected);
    expect((await contactRow(oldContact)).last?.toISOString()).toBe(expected);
    expect((await leadRow(trashedLead)).last?.toISOString()).toBe(expected);
    expect((await leadRow(bothLead)).last?.toISOString()).toBe(entries[0].at.toISOString());
    expect((await contactRow(bothContact)).last?.toISOString()).toBe(entries[0].at.toISOString());
    // untouched
    expect((await leadRow(setLead)).last?.toISOString()).toBe(setBefore.last?.toISOString());
    expect((await leadRow(noneLead)).last).toBeNull();

    // not an edit: updated_at / updated_by kept; first contact not touched
    for (const id of [oldLead, setLead, noneLead, trashedLead, bothLead]) {
      const row = await leadRow(id);
      expect(row.updated_at.toISOString(), id).toBe(before.get(id)?.updated_at.toISOString());
      expect(row.updated_by, id).toBe(before.get(id)?.updated_by);
      expect(row.first, id).toBeNull();
    }
    for (const id of [oldContact, bothContact]) {
      const row = await contactRow(id);
      expect(row.updated_at.toISOString(), id).toBe(before.get(id)?.updated_at.toISOString());
      expect(row.updated_by, id).toBe(before.get(id)?.updated_by);
    }
    // phone and email unchanged by the normalize trigger
    const c = await asAdmin(async (q) => (await q<{ phone_e164: string; email: string }>("select phone_e164, email from public.contacts where id = $1", [oldContact])).rows[0]);
    expect(c).toEqual({ phone_e164: "+972501234567", email: "a@b.co" });

    // no automation: every event is the automation's, already handled; nothing for untouched rows
    const trashedEvents = (await events(trashedLead)).filter((e) => e.origin === "automation");
    expect(trashedEvents).toEqual([{ origin: "automation", processed: true }]);
    for (const id of [oldLead, oldContact, bothLead, bothContact]) {
      expect(await events(id), id).toEqual([{ origin: "automation", processed: true }]);
    }
    expect(await events(setLead)).toEqual(setEventsBefore); // only the live stamp's, from before
    expect(await events(noneLead)).toEqual([]);
    // no notification
    expect(await notifications(ours)).toBe(notesBefore);
    // the audit log records the change of last_contacted_at only, once per filled record
    const audit = await asAdmin(async (q) =>
      (
        await q<{ keys: string[] }>(
          "select array(select jsonb_object_keys(changes)) as keys from public.audit_log where entity_id = any($1) and action = 'update' order by created_at",
          [[oldLead, oldContact, bothLead, bothContact]],
        )
      ).rows,
    );
    expect(audit).toEqual(Array(4).fill({ keys: ["last_contacted_at"] }));
    const auditAfter = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.audit_log where entity_id = any($1)", [ours])).rows[0].n));
    expect(auditAfter - auditBefore).toBe(5); // oldLead, oldContact, trashedLead, bothLead, bothContact

    // the second run changes nothing
    const snapshot = async () => [
      ...(await Promise.all([oldLead, setLead, noneLead, trashedLead, bothLead].map(leadRow))),
      ...(await Promise.all([oldContact, bothContact].map(contactRow))),
    ];
    const afterFirst = await snapshot();
    const eventsAfterFirst = await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.outbox_events where entity_id = any($1)", [ours])).rows[0].n));
    const second = await runBackfill();
    expect(filled(second.notices)).toEqual({ leads: 0, contacts: 0 });
    expect(await snapshot()).toEqual(afterFirst);
    expect(await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.outbox_events where entity_id = any($1)", [ours])).rows[0].n))).toBe(eventsAfterFirst);
    expect(await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.audit_log where entity_id = any($1)", [ours])).rows[0].n))).toBe(auditAfter);
  });

  it("an entry a few minutes ahead counts as now, like the live stamp", async () => {
    const lead = await insertLead(author.id, org);
    const at = new Date(Date.now() + 2 * 60_000);
    await logOld({ lead_id: lead }, { type: "call", at, author: author.id });
    const t0 = Date.now();
    await runBackfill();
    const last = (await leadRow(lead)).last;
    expect(last).not.toBeNull();
    expect(last!.getTime()).toBeLessThan(at.getTime());
    expect(last!.getTime()).toBeGreaterThanOrEqual(t0 - 5_000);
  });

  it("puts the session flags back as they were", async () => {
    const lead = await insertLead(author.id, org);
    await logOld({ lead_id: lead }, { type: "note", at: new Date(Date.now() - DAY), author: author.id });
    const plain = await runBackfill();
    expect(plain.flags?.a ?? "").not.toBe("on");
    expect(plain.flags?.c ?? "").not.toBe("on");
    const inside = await runBackfill("select set_config('app.automation_running', 'on', true)");
    expect(inside.flags?.a).toBe("on");
    expect(inside.flags?.c ?? "").not.toBe("on");
  });
});
