import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Buffers = { before: number; after: number };

/** The one-time fill statement of the CAL-10 migration, between its markers. */
function fillStatement(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_meeting_buffers.sql"));
  if (!file) throw new Error("no migration *_meeting_buffers.sql");
  const text = readFileSync(path.join(dir, file), "utf8");
  const match = /-- fill:start\n([\s\S]*?)-- fill:end/.exec(text);
  if (!match) throw new Error("no fill markers");
  return match[1];
}

/**
 * CAL-10 (owner, 15 October 2026): the buffers are copied onto the meeting when it is booked; a later
 * change to the type affects only new meetings; the meeting's own buffers are what meeting_busy checks.
 */
describe("buffers on the meeting itself (CAL-10)", () => {
  let owner: U, member: U, other: U;
  let org: string;

  const newType = (name: string, before: number, after: number) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meeting_types (organization_id, name, buffer_before_minutes, buffer_after_minutes) values ($1, $2, $3, $4) returning id",
          [org, name, before, after],
        )
      ).rows[0].id,
    );
  const newMeeting = (user: U, start: string, end: string, extra: Record<string, unknown> = {}) =>
    asUser(user.id, async (q) => {
      const cols = ["organization_id", "title", "starts_at", "ends_at", ...Object.keys(extra)];
      const params = [org, "פגישה", start, end, ...Object.values(extra)];
      return (
        await q<{ id: string }>(
          `insert into public.meetings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          params,
        )
      ).rows[0].id;
    });
  const buffersOf = (id: string): Promise<Buffers> =>
    asAdmin(async (q) =>
      (await q<Buffers>("select buffer_before_minutes as before, buffer_after_minutes as after from public.meetings where id = $1", [id])).rows[0],
    );
  const update = (user: U, id: string, set: Record<string, unknown>) =>
    asUser(user.id, async (q) => {
      const cols = Object.keys(set);
      return (
        await q(`update public.meetings set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`, [id, ...Object.values(set)])
      ).rowCount;
    });

  beforeAll(async () => {
    owner = await createUser("buf-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "buf-member");
    other = await addMember(org, owner.id, "member", "buf-other");
  });

  it("a new meeting takes its type's buffers, a buffer sent by the person wins, and no type is 0", async () => {
    const type = await newType("ייעוץ עם מרווח", 15, 30);
    expect(await buffersOf(await newMeeting(member, "2027-01-04T10:00:00Z", "2027-01-04T11:00:00Z", { meeting_type_id: type }))).toEqual({ before: 15, after: 30 });
    expect(
      await buffersOf(await newMeeting(member, "2027-01-04T12:00:00Z", "2027-01-04T13:00:00Z", { meeting_type_id: type, buffer_before_minutes: 0 })),
    ).toEqual({ before: 0, after: 30 });
    expect(await buffersOf(await newMeeting(member, "2027-01-04T14:00:00Z", "2027-01-04T15:00:00Z"))).toEqual({ before: 0, after: 0 });
    expect(await buffersOf(await newMeeting(member, "2027-01-04T16:00:00Z", "2027-01-04T17:00:00Z", { buffer_after_minutes: 45 }))).toEqual({ before: 0, after: 45 });
  });

  it("a later change to the type, or deleting it, leaves booked meetings as they are", async () => {
    const type = await newType("סוג שישתנה", 10, 10);
    const booked = await newMeeting(member, "2027-01-05T10:00:00Z", "2027-01-05T11:00:00Z", { meeting_type_id: type });
    await asUser(owner.id, (q) => q("update public.meeting_types set buffer_before_minutes = 60, buffer_after_minutes = 60 where id = $1", [type]));
    expect(await buffersOf(booked)).toEqual({ before: 10, after: 10 });
    // a new meeting takes the new values
    expect(await buffersOf(await newMeeting(member, "2027-01-05T14:00:00Z", "2027-01-05T15:00:00Z", { meeting_type_id: type }))).toEqual({ before: 60, after: 60 });
    // the type deleted: its link goes, the buffers stay
    await asUser(owner.id, (q) => q("delete from public.meeting_types where id = $1", [type]));
    expect(await buffersOf(booked)).toEqual({ before: 10, after: 10 });
  });

  it("on an edit: another type brings its buffers unless the same edit sets them; clearing the type keeps them; null is the type's", async () => {
    const a = await newType("סוג א", 5, 5);
    const b = await newType("סוג ב", 20, 40);
    const id = await newMeeting(member, "2027-01-06T10:00:00Z", "2027-01-06T11:00:00Z", { meeting_type_id: a });
    // edited by hand
    expect(await update(member, id, { buffer_before_minutes: 25 })).toBe(1);
    expect(await buffersOf(id)).toEqual({ before: 25, after: 5 });
    // another type, buffers not touched in the same edit: the new type's
    await update(member, id, { meeting_type_id: b });
    expect(await buffersOf(id)).toEqual({ before: 20, after: 40 });
    // another type with one buffer set in the same edit: that one is kept, the other is the type's
    await update(member, id, { meeting_type_id: a, buffer_after_minutes: 90 });
    expect(await buffersOf(id)).toEqual({ before: 5, after: 90 });
    // the type cleared: the buffers stay
    await update(member, id, { meeting_type_id: null });
    expect(await buffersOf(id)).toEqual({ before: 5, after: 90 });
    // null: the current type's, else 0
    await update(member, id, { buffer_after_minutes: null });
    expect(await buffersOf(id)).toEqual({ before: 5, after: 0 });
    await update(member, id, { meeting_type_id: b });
    await update(member, id, { buffer_before_minutes: null, buffer_after_minutes: null });
    expect(await buffersOf(id)).toEqual({ before: 20, after: 40 });
  });

  it("the range is 0..240, and only those who may edit the meeting change its buffers", async () => {
    const id = await newMeeting(member, "2027-01-07T10:00:00Z", "2027-01-07T11:00:00Z");
    expect((await pgError(update(member, id, { buffer_before_minutes: 241 }))).code).toBe("23514");
    expect((await pgError(update(member, id, { buffer_after_minutes: -1 }))).code).toBe("23514");
    expect((await pgError(newMeeting(member, "2027-01-07T12:00:00Z", "2027-01-07T13:00:00Z", { buffer_before_minutes: 300 }))).code).toBe("23514");
    expect(await update(member, id, { buffer_before_minutes: 240 })).toBe(1);
    // someone else's meeting: 0 rows (RLS)
    expect(await update(other, id, { buffer_before_minutes: 10 })).toBe(0);
    expect(await buffersOf(id)).toEqual({ before: 240, after: 0 });
  });

  it("meeting_busy counts the meeting's own buffers", async () => {
    const type = await newType("סוג לבדיקת עומס", 30, 30);
    const id = await newMeeting(member, "2027-01-08T10:00:00Z", "2027-01-08T11:00:00Z", { meeting_type_id: type });
    const busy = (from: string, to: string) =>
      asUser(member.id, async (q) =>
        (await q<{ meeting_id: string; busy_from: Date; busy_to: Date }>("select meeting_id, busy_from, busy_to from public.meeting_busy($1, $2::uuid[], $3, $4)", [org, [member.id], from, to])).rows,
      );
    expect((await busy("2027-01-08T11:00:00Z", "2027-01-08T11:20:00Z")).map((r) => r.busy_to.toISOString())).toEqual(["2027-01-08T11:30:00.000Z"]);
    // the type changes: the meeting does not
    await asUser(owner.id, (q) => q("update public.meeting_types set buffer_after_minutes = 0 where id = $1", [type]));
    expect(await busy("2027-01-08T11:00:00Z", "2027-01-08T11:20:00Z")).toHaveLength(1);
    // the meeting's own buffer is changed
    await update(member, id, { buffer_after_minutes: 0 });
    expect(await busy("2027-01-08T11:00:00Z", "2027-01-08T11:20:00Z")).toHaveLength(0);
    const rows = await busy("2027-01-08T09:00:00Z", "2027-01-08T12:00:00Z");
    expect(rows.map((r) => [r.meeting_id, r.busy_from.toISOString(), r.busy_to.toISOString()])).toEqual([[id, "2027-01-08T09:30:00.000Z", "2027-01-08T11:00:00.000Z"]]);
  });

  it("a series passes the buffers, or takes the type's when none are sent", async () => {
    const type = await newType("סוג לסדרה", 10, 20);
    const times = [0, 1, 2].map((n) => {
      const day = new Date(Date.UTC(2027, 1, 1 + 7 * n)).toISOString().slice(0, 10);
      return { starts_at: `${day}T08:00:00Z`, ends_at: `${day}T09:00:00Z` };
    });
    const create = (meeting: Record<string, unknown>, at = times) =>
      asUser(member.id, async (q) =>
        (
          await q<{ r: { ids: string[] } }>("select public.create_meeting_series($1, $2, $3, '{}'::uuid[]) as r", [
            org,
            JSON.stringify({ title: "סדרה", meeting_type: "in_person", meeting_type_id: type, ...meeting }),
            JSON.stringify(at),
          ])
        ).rows[0].r.ids,
      );
    const own = await create({ buffer_before_minutes: 0, buffer_after_minutes: 45 });
    for (const id of own) expect(await buffersOf(id)).toEqual({ before: 0, after: 45 });
    const later = times.map((t) => ({ starts_at: t.starts_at.replace("T08", "T12"), ends_at: t.ends_at.replace("T09", "T13") }));
    const fromType = await create({}, later);
    for (const id of fromType) expect(await buffersOf(id)).toEqual({ before: 10, after: 20 });
  });

  it("the one-time fill gives a meeting without buffers its current type's (0 without a type), and changes nothing else", async () => {
    const type = await newType("סוג למילוי", 15, 25);
    const typed = await newMeeting(member, "2027-01-11T10:00:00Z", "2027-01-11T11:00:00Z", { meeting_type_id: type });
    const plain = await newMeeting(member, "2027-01-11T12:00:00Z", "2027-01-11T13:00:00Z");
    const kept = await newMeeting(member, "2027-01-11T14:00:00Z", "2027-01-11T15:00:00Z", { meeting_type_id: type, buffer_before_minutes: 50 });
    const result = await asAdmin(async (q) => {
      // the state before the migration: the columns empty on two meetings
      await q("alter table public.meetings alter column buffer_before_minutes drop not null, alter column buffer_after_minutes drop not null");
      await q("alter table public.meetings disable trigger meetings_buffers");
      await q("update public.meetings set buffer_before_minutes = null, buffer_after_minutes = null where id = any($1::uuid[])", [[typed, plain]]);
      await q("alter table public.meetings enable trigger meetings_buffers");
      const fill = await q(fillStatement());
      const again = await q(fillStatement());
      await q("alter table public.meetings alter column buffer_before_minutes set not null, alter column buffer_after_minutes set not null");
      return { filled: fill.rowCount, again: again.rowCount };
    });
    expect(result.filled).toBe(2);
    expect(result.again).toBe(0);
    expect(await buffersOf(typed)).toEqual({ before: 15, after: 25 });
    expect(await buffersOf(plain)).toEqual({ before: 0, after: 0 });
    expect(await buffersOf(kept)).toEqual({ before: 50, after: 25 });
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where buffer_before_minutes is null or buffer_after_minutes is null"))).toBe(0);
  });

  it("the series notice skip looks only at a notice of the last 15 minutes (CAL-09 review)", async () => {
    // a notice is sent only for a meeting still ahead (app.meeting_notice), so the weeks start from the database's own today
    const base = await asAdmin(async (q) => (await q<{ d: string }>("select (current_date + 30)::text as d")).rows[0].d);
    const times = [0, 1, 2].map((n) => {
      const day = new Date(Date.parse(`${base}T00:00:00Z`) + 7 * n * 86_400_000).toISOString().slice(0, 10);
      return { starts_at: `${day}T08:00:00Z`, ends_at: `${day}T09:00:00Z` };
    });
    const ids = await asUser(member.id, async (q) =>
      (
        await q<{ r: { ids: string[] } }>("select public.create_meeting_series($1, $2, $3, $4::uuid[]) as r", [
          org,
          JSON.stringify({ title: "סדרה להתראות", meeting_type: "in_person" }),
          JSON.stringify(times),
          [other.id],
        ])
      ).rows[0].r.ids,
    );
    const notices = () => asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'meeting_scheduled' and entity_id = any($2::uuid[])", [other.id, ids]));
    expect(await notices()).toBe(1);
    // the unread notice is older than 15 minutes: a later invitation in the series is told
    await asAdmin((q) => q("update public.notifications set created_at = now() - interval '16 minutes' where user_id = $1 and entity_id = any($2::uuid[])", [other.id, ids]));
    await asUser(member.id, (q) => q("delete from public.meeting_participants where meeting_id = $1 and user_id = $2", [ids[2], other.id]));
    await asUser(member.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, ids[2], other.id]));
    expect(await notices()).toBe(2);
  });
});
