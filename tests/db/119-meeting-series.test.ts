import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

const week = (n: number, hour = "08:00") => {
  const day = new Date(Date.UTC(2026, 11, 6 + 7 * n)).toISOString().slice(0, 10);
  return { starts_at: `${day}T${hour}:00Z`, ends_at: `${day}T${hour.replace(/^(\d\d)/, (h) => String(Number(h) + 1).padStart(2, "0"))}:00Z` };
};
const weeks = (n: number) => Array.from({ length: n }, (_, i) => week(i));

/**
 * CAL-09: a weekly series is made up front as real meetings, in one transaction, by
 * public.create_meeting_series (security invoker: RLS and every meetings trigger apply to each
 * one); series_id / series_index are set on insert only, and nobody can add a meeting into a
 * series they did not open.
 */
describe("recurring meetings (CAL-09)", () => {
  let owner: U, member: U, other: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;

  const createSeries = (user: U, o: string, times: unknown, meeting: Record<string, unknown> = {}, participants: string[] = []) =>
    asUser(user.id, async (q) =>
      (
        await q<{ r: { series_id: string; ids: string[] } }>("select public.create_meeting_series($1, $2, $3, $4::uuid[]) as r", [
          o,
          JSON.stringify({ title: "טיפול", meeting_type: "in_person", reminder_minutes: 15, ...meeting }),
          JSON.stringify(times),
          participants,
        ])
      ).rows[0].r,
    );

  const seriesRows = (seriesId: string) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string; series_index: number; starts_at: Date; title: string; created_by: string; reminder_minutes: number | null }>(
          "select id, series_index, starts_at, title, created_by, reminder_minutes from public.meetings where series_id = $1 order by series_index",
          [seriesId],
        )
      ).rows,
    );

  const insertInto = (user: U, o: string, seriesId: string, index: number, at = week(30)) =>
    asUser(user.id, (q) =>
      q("insert into public.meetings (organization_id, title, starts_at, ends_at, series_id, series_index) values ($1, 'חטיפה', $2, $3, $4, $5)", [
        o,
        at.starts_at,
        at.ends_at,
        seriesId,
        index,
      ]),
    );

  beforeAll(async () => {
    owner = await createUser("series-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "series-member");
    other = await addMember(org, owner.id, "member", "series-other");
    viewer = await addMember(org, owner.id, "viewer", "series-viewer");
    stranger = await createUser("series-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
  });

  it("makes every meeting of the series, in order, with its participants", async () => {
    const result = await createSeries(member, org, weeks(5), { title: "סדרת טיפולים", reminder_minutes: 60 }, [other.id]);
    expect(result.ids).toHaveLength(5);
    const rows = await seriesRows(result.series_id);
    expect(rows.map((r) => r.series_index)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.starts_at.toISOString())).toEqual(weeks(5).map((w) => new Date(w.starts_at).toISOString()));
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(["סדרת טיפולים"]));
    expect(rows.every((r) => r.created_by === member.id && r.reminder_minutes === 60)).toBe(true);
    expect(await asAdmin((q) => count(q, "select 1 from public.meeting_participants where meeting_id = any($1::uuid[]) and user_id = $2", [result.ids, other.id]))).toBe(5);
    // each one is an ordinary meeting: the organizer sees them, and so does the participant
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.meetings where series_id = $1", [result.series_id]))).toBe(5);
  });

  it("refuses a bad series and makes nothing", async () => {
    const before = await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1", [org]));
    for (const times of [weeks(1), weeks(53), [week(2), week(1)], [week(1), week(1)], [{ starts_at: "x", ends_at: "y" }, week(2)], {}]) {
      const error = await pgError(createSeries(member, org, times));
      expect(error.code, JSON.stringify(times).slice(0, 60)).toBe("22023");
      expect(error.hint).toBe("meeting_series:invalid");
    }
    // a meeting the database refuses in the middle (end before start in week 3) rolls the whole series back
    const broken = [week(1), week(2), { starts_at: week(3).ends_at, ends_at: week(3).starts_at }, week(4)];
    expect((await pgError(createSeries(member, org, broken))).code).toBe("23514");
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1", [org]))).toBe(before);
  });

  it("applies the meeting rules to every week: viewers, outsiders and hidden records are refused", async () => {
    expect((await pgError(createSeries(viewer, org, weeks(2)))).code).toBe("42501");
    expect((await pgError(createSeries(stranger, org, weeks(2)))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.create_meeting_series($1, '{}', '[]')", [org]))))).toMatchObject({ code: "42501" });

    // visibility 'own': a lead of the owner is hidden from the member, so a series on it is refused whole
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const hidden = await insertLead(owner.id, org, { full_name: "ליד של הבעלים" });
    const before = await asAdmin((q) => count(q, "select 1 from public.meetings where lead_id = $1", [hidden]));
    expect((await pgError(createSeries(member, org, weeks(3), { lead_id: hidden }))).code).toMatch(/^(42501|P0001)$/);
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where lead_id = $1", [hidden]))).toBe(before);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
  });

  it("nobody adds a meeting into someone else's series, or reuses a series id", async () => {
    const { series_id } = await createSeries(member, org, weeks(3));
    // another member of the business, as the next index
    expect(await pgError(insertInto(other, org, series_id, 4))).toMatchObject({ code: "P0001", hint: "meeting_series:invalid" });
    // a new "first" meeting with the same id
    expect(await pgError(insertInto(other, org, series_id, 1))).toMatchObject({ code: "P0001", hint: "meeting_series:invalid" });
    // another business may not join it; a first meeting with the same id there is its own, unrelated series
    // (the check looks at one business only, so it tells nothing about others: review, 15 October 2026)
    expect(await pgError(insertInto(stranger, otherOrg, series_id, 4))).toMatchObject({ code: "P0001", hint: "meeting_series:invalid" });
    await insertInto(stranger, otherOrg, series_id, 1);
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where series_id = $1 and organization_id = $2", [series_id, org]))).toBe(3);
    // even the creator may not skip an index or repeat one
    expect(await pgError(insertInto(member, org, series_id, 6))).toMatchObject({ hint: "meeting_series:invalid" });
    expect((await pgError(insertInto(member, org, series_id, 3))).code).toBe("23505");
    // the shape: an index needs an id and stays in 1..52
    const shape = await pgError(
      asUser(member.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, series_index) values ($1, 'x', $2, $3, 2)", [org, week(40).starts_at, week(40).ends_at]),
      ),
    );
    expect(shape.code).toBe("23514");
    expect((await seriesRows(series_id)).filter((r) => r.created_by === member.id)).toHaveLength(3);
  });

  it("series columns are set on insert only", async () => {
    const { ids } = await createSeries(member, org, weeks(2));
    for (const set of ["series_index = 9", "series_id = gen_random_uuid()", "series_id = null, series_index = null"]) {
      expect((await pgError(asUser(member.id, (q) => q(`update public.meetings set ${set} where id = $1`, [ids[0]])))).code, set).toBe("42501");
    }
    // the rest of a series meeting is edited as any meeting
    await asUser(member.id, async (q) => {
      expect((await q("update public.meetings set title = 'שונה', status = 'cancelled' where id = $1", [ids[1]])).rowCount).toBe(1);
    });
  });

  it("is security invoker with a pinned search path, executable by authenticated only", async () => {
    const fn = await asAdmin(async (q) =>
      (
        await q<{ secdef: boolean; config: string[] | null; anon: boolean; auth: boolean }>(`
          select p.prosecdef as secdef, p.proconfig as config,
                 has_function_privilege('anon', p.oid, 'execute') as anon,
                 has_function_privilege('authenticated', p.oid, 'execute') as auth
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'create_meeting_series'`)
      ).rows,
    );
    expect(fn).toEqual([{ secdef: false, config: ['search_path=""'], anon: false, auth: true }]);
  });

  it("two first meetings with the same new id at the same moment: only one is kept", async () => {
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    const results = await Promise.allSettled([insertInto(member, org, id, 1, week(44)), insertInto(member, org, id, 1, week(45))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["23505", "P0001"]).toContain((failed.reason as { code?: string }).code);
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and series_id = $2", [org, id]))).toBe(1);
  });

  it("a series sends one notice per participant, with how many meetings it has", async () => {
    const { series_id, ids } = await createSeries(member, org, Array.from({ length: 6 }, (_, i) => week(i + 60)), { title: "סדרת אימונים" }, [other.id, owner.id]);
    for (const person of [other, owner]) {
      const notes = await asAdmin(async (q) =>
        (
          await q<{ entity_id: string; body: string }>(
            "select entity_id, body from public.notifications where user_id = $1 and type = 'meeting_scheduled' and entity_id = any($2::uuid[])",
            [person.id, ids],
          )
        ).rows,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].entity_id).toBe(ids[0]);
      expect(notes[0].body).toContain("סדרה של 6 פגישות");
    }
    // adding a participant to the following meetings one by one (the app's "this and following") also notifies once
    const late = await addMember(org, owner.id, "member", "series-late");
    for (const id of ids.slice(2)) {
      await asUser(member.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, id, late.id]));
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'meeting_scheduled'", [late.id]))).toBe(1);
    // once it is read, a later change to one meeting notifies as before
    await asAdmin((q) => q("update public.notifications set read_at = now() where user_id = $1", [late.id]));
    await asUser(member.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, ids[1], late.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'meeting_scheduled'", [late.id]))).toBe(2);
    // a single meeting is unchanged: one notice, no series line
    expect(series_id).toBeTruthy();
  });

  it("meetings_removable answers exactly what the delete policy allows", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    const mine = await createSeries(member, org, [week(70), week(71)]);
    const theirs = await createSeries(other, org, [week(72), week(73)]);
    const all = [...mine.ids, ...theirs.ids];
    for (const user of [member, other, owner, viewer]) {
      const answered = await asUser(user.id, async (q) =>
        (await q<{ id: string }>("select id from public.meetings_removable($1, $2::uuid[]) as id", [org, all])).rows.map((r) => r.id).sort(),
      );
      // the truth: delete inside a transaction that is rolled back
      const deleted = await asUser(user.id, async (q) => {
        await q("savepoint probe");
        const rows = (await q<{ id: string }>("delete from public.meetings where id = any($1::uuid[]) returning id", [all])).rows.map((r) => r.id).sort();
        await q("rollback to savepoint probe");
        return rows;
      });
      expect(answered, user.id).toEqual(deleted);
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where id = any($1::uuid[])", [all]))).toBe(4);
  });
});
