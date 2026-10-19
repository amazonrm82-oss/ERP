import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_ACTIVITY_TYPES } from "@/features/activity-types/types";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// TASK-08 (migration 020545): one list of activity and task types per business, each under one of the six base kinds.
describe("activity and task types (TASK-08)", () => {
  let owner: U, admin: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let visit: string, demo: string, chat: string, otherVisit: string;

  const typeOf = (o: string, key: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.activity_types where organization_id = $1 and key = $2", [o, key])).rows[0].id);
  const addType = (userId: string, o: string, base: string, name: string) =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("insert into public.activity_types (organization_id, base_type, name) values ($1, $2, $3) returning id", [o, base, name])).rows[0].id,
    );
  const logEntry = (userId: string, lead: string, type: string, typeId: string | null) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, activity_type_id) values ($1, $2, 'תיעוד', $3, $4) returning id",
          [org, type, lead, typeId],
        )
      ).rows[0].id,
    );
  const task = (id: string) =>
    asAdmin(async (q) => (await q<{ task_type: string; activity_type_id: string | null }>("select task_type, activity_type_id from public.tasks where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("at-owner");
    org = await createOrg(owner.id, "עסק סוגים");
    admin = await addMember(org, owner.id, "admin", "at-admin");
    member = await addMember(org, owner.id, "member", "at-member");
    outsider = await createUser("at-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר לסוגים");
    visit = await addType(admin.id, org, "meeting", "ביקור");
    demo = await addType(admin.id, org, "call", "הדגמה בטלפון");
    chat = await addType(admin.id, org, "whatsapp", "צ'אט מהאתר");
    otherVisit = await addType(outsider.id, otherOrg, "meeting", "ביקור");
  });

  it("every new business starts with the six kinds under today's names (the app's list), and seeding is once", async () => {
    const fresh = await createOrg((await createUser("at-fresh")).id, "עסק חדש");
    const rows = await asAdmin(
      async (q) =>
        (await q<{ key: string; base_type: string; name: string }>("select key, base_type, name from public.activity_types where organization_id = $1 order by position", [fresh])).rows,
    );
    expect(rows).toEqual(DEFAULT_ACTIVITY_TYPES.map((d) => ({ key: d.key, base_type: d.key, name: d.name })));
    // a list that is not empty is never seeded again
    await asAdmin((q) => q("select app.seed_activity_types($1)", [fresh]));
    expect(await asAdmin((q) => count(q, "select 1 from public.activity_types where organization_id = $1", [fresh]))).toBe(6);
  });

  it("the base kind and the key are fixed: no client may change them; a key must match its kind", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("update public.activity_types set base_type = 'note' where id = $1", [visit])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.activity_types set key = 'meeting' where id = $1", [visit])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.activity_types (organization_id, base_type, name, key) values ($1, 'call', 'x', 'call')", [org])))).code,
    ).toBe("42501");
    expect((await pgError(asAdmin((q) => q("update public.activity_types set key = 'call' where id = $1", [visit])))).code).toBe("23514");
    // only the closed list of icons
    expect((await pgError(asUser(owner.id, (q) => q("update public.activity_types set icon = 'rocket' where id = $1", [visit])))).code).toBe("23514");
    expect(await asUser(owner.id, async (q) => (await q("update public.activity_types set icon = 'home' where id = $1", [visit])).rowCount)).toBe(1);
  });

  it("at most 50 per business; an outsider gets RLS's plain refusal, never the cap", async () => {
    const big = await createOrg((await createUser("at-big")).id, "עסק גדול");
    const bigOwner = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.memberships where organization_id = $1 and role = 'owner'", [big])).rows[0].user_id);
    await asAdmin((q) =>
      q("insert into public.activity_types (organization_id, base_type, name) select $1, 'note', 'סוג ' || g from generate_series(1, 44) g", [big]),
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.activity_types where organization_id = $1", [big]))).toBe(50);
    expect(await pgError(addType(bigOwner, big, "note", "עוד אחד"))).toMatchObject({ code: "P0001", hint: "activity_types:max" });
    const outsiderTry = await pgError(addType(outsider.id, big, "note", "של זר"));
    expect(outsiderTry.code).toBe("42501");
    expect(outsiderTry.hint ?? null).toBeNull();
  });

  it("a logged entry carries a type of its own kind; the kind still drives last contact", async () => {
    const lead = await insertLead(member.id, org, { full_name: "ליד סוגים" });
    await logEntry(member.id, lead, "meeting", visit);
    const stamped = await asAdmin(async (q) => (await q<{ t: Date | null }>("select last_contacted_at as t from public.leads where id = $1", [lead])).rows[0].t);
    expect(stamped).not.toBeNull();
    // a type of another kind, or of another business, is refused
    expect(await pgError(logEntry(member.id, lead, "call", visit))).toMatchObject({ code: "P0001", hint: "activity_type:invalid" });
    expect((await pgError(logEntry(member.id, lead, "meeting", otherVisit))).hint).toBe("activity_type:invalid");
    // a hidden type is not offered to a person, but stays on what has it
    const entry = await logEntry(member.id, lead, "whatsapp", chat);
    await asUser(owner.id, (q) => q("update public.activity_types set is_active = false where id = $1", [chat]));
    try {
      expect((await pgError(logEntry(member.id, lead, "whatsapp", chat))).hint).toBe("activity_type:invalid");
      expect(await asUser(member.id, async (q) => (await q("update public.activities set body = 'נערך' where id = $1", [entry])).rowCount)).toBe(1);
      // a server writer is not asked about hidden types (only about the kind)
      await asAdmin((q) => q("insert into public.activities (organization_id, type, lead_id, activity_type_id) values ($1, 'whatsapp', $2, $3)", [org, lead, chat]));
    } finally {
      await asUser(owner.id, (q) => q("update public.activity_types set is_active = true where id = $1", [chat]));
    }
    // a person cannot change the type of a logged entry afterwards (no update grant)
    expect((await pgError(asUser(member.id, (q) => q("update public.activities set activity_type_id = $2 where id = $1", [entry, null])))).code).toBe("42501");
  });

  it("a task's type sets its code from the kind; a code alone clears the type", async () => {
    const created = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, activity_type_id) values ($1, 'לבקר', $2) returning id", [org, visit])).rows[0].id,
    );
    expect(await task(created)).toEqual({ task_type: "meeting", activity_type_id: visit });
    // a call type
    await asUser(member.id, (q) => q("update public.tasks set activity_type_id = $2 where id = $1", [created, demo]));
    expect(await task(created)).toEqual({ task_type: "call", activity_type_id: demo });
    // any other kind gives the plain code
    await asUser(member.id, (q) => q("update public.tasks set activity_type_id = $2 where id = $1", [created, chat]));
    expect(await task(created)).toEqual({ task_type: "todo", activity_type_id: chat });
    // the type kept while another column changes
    await asUser(member.id, (q) => q("update public.tasks set title = 'לבקר שוב' where id = $1", [created]));
    expect(await task(created)).toEqual({ task_type: "todo", activity_type_id: chat });
    // the fixed "מעקב" (a code alone) leaves the list's type, also when an automation sets it
    await asUser(member.id, (q) => q("update public.tasks set task_type = 'follow_up' where id = $1", [created]));
    expect(await task(created)).toEqual({ task_type: "follow_up", activity_type_id: null });
    await asUser(member.id, (q) => q("update public.tasks set activity_type_id = $2 where id = $1", [created, visit]));
    await asAdmin((q) => q("update public.tasks set task_type = 'todo' where id = $1", [created]));
    expect(await task(created)).toEqual({ task_type: "todo", activity_type_id: null });
    // a hidden type or one of another business is refused
    await asUser(owner.id, (q) => q("update public.activity_types set is_active = false where id = $1", [demo]));
    try {
      expect((await pgError(asUser(member.id, (q) => q("update public.tasks set activity_type_id = $2 where id = $1", [created, demo])))).hint).toBe("activity_type:invalid");
    } finally {
      await asUser(owner.id, (q) => q("update public.activity_types set is_active = true where id = $1", [demo]));
    }
    expect((await pgError(asUser(member.id, (q) => q("update public.tasks set activity_type_id = $2 where id = $1", [created, otherVisit])))).hint).toBe("activity_type:invalid");
  });

  it("the next occurrence of a recurring task keeps its type", async () => {
    const first = await asUser(member.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.tasks (organization_id, title, due_at, recurrence, activity_type_id) values ($1, 'ביקור שבועי', now(), '{"kind": "daily"}', $2) returning id`,
          [org, visit],
        )
      ).rows[0].id,
    );
    await asUser(member.id, (q) => q("update public.tasks set status = 'done' where id = $1", [first]));
    const next = await asAdmin(
      async (q) => (await q<{ task_type: string; activity_type_id: string | null }>("select task_type, activity_type_id from public.tasks where recurrence_source_id = $1", [first])).rows[0],
    );
    expect(next).toEqual({ task_type: "meeting", activity_type_id: visit });
  });

  it("deleting a type keeps the entries and tasks, with their kind", async () => {
    const gone = await addType(admin.id, org, "meeting", "יימחק");
    const lead = await insertLead(member.id, org, { full_name: "ליד מחיקה" });
    const entry = await logEntry(member.id, lead, "meeting", gone);
    const t = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, activity_type_id) values ($1, 'עם סוג', $2) returning id", [org, gone])).rows[0].id,
    );
    expect(await asUser(admin.id, async (q) => (await q("delete from public.activity_types where id = $1", [gone])).rowCount)).toBe(1);
    expect(await asAdmin(async (q) => (await q<{ type: string; a: string | null }>("select type, activity_type_id as a from public.activities where id = $1", [entry])).rows[0])).toEqual({
      type: "meeting",
      a: null,
    });
    expect(await task(t)).toEqual({ task_type: "meeting", activity_type_id: null });
  });

  it("the list is ordered in one call; a member may read it but not change it", async () => {
    const ids = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from public.activity_types where organization_id = $1 order by position, created_at", [org])).rows.map((r) => r.id),
    );
    const reversed = [...ids].reverse();
    await asUser(admin.id, (q) => q("select public.reorder_positions('activity_types', $1, $2)", [org, reversed]));
    const after = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from public.activity_types where organization_id = $1 order by position", [org])).rows.map((r) => r.id),
    );
    expect(after).toEqual(reversed);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.activity_types where organization_id = $1", [org]))).toBe(ids.length);
    expect((await pgError(asUser(member.id, (q) => q("select public.reorder_positions('activity_types', $1, $2)", [org, ids]))) ).code).toBe("42501");
    expect(await typeOf(org, "note")).toBeTruthy();
  });
});
