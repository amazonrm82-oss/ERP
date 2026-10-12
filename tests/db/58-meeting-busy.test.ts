import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Busy = { user_id: string; meeting_id: string | null; title: string | null; starts_at: Date; ends_at: Date };

/**
 * CAL-05: public.meeting_busy() tells when the people of a meeting are busy,
 * also for meetings the caller may not see (visibility 'own'): those come with
 * times only (id and title null), the ones the caller may read with both.
 * Cancelled and no-show meetings, back to back meetings and the meeting being
 * edited do not count. Writers only (no viewers), inside their organization.
 */
describe("busy times for conflict warnings (CAL-05)", () => {
  let owner: U, rep: U, other: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;

  const from = "2026-11-02T08:00:00Z";
  const to = "2026-11-02T09:00:00Z";

  const newMeeting = (user: U, orgId: string, start: string, end: string, status = "planned", title = "פגישה סודית") =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.meetings (organization_id, title, starts_at, ends_at, status) values ($1, $2, $3, $4, $5) returning id", [
          orgId,
          title,
          start,
          end,
          status,
        ])
      ).rows[0].id,
    );

  const busy = (caller: U, orgId: string, users: string[], f = from, t = to, exclude: string | null = null) =>
    asUser(caller.id, async (q) =>
      (await q<Busy>("select * from public.meeting_busy($1, $2::uuid[], $3, $4, $5)", [orgId, users, f, t, exclude])).rows,
    );

  beforeAll(async () => {
    owner = await createUser("busy-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "busy-rep");
    other = await addMember(org, owner.id, "member", "busy-other");
    viewer = await addMember(org, owner.id, "viewer", "busy-viewer");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    stranger = await createUser("busy-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
  });

  it("returns a colleague's meeting the caller cannot read with times only, a readable one with id and title", async () => {
    const meeting = await newMeeting(rep, org, "2026-11-02T08:30:00Z", "2026-11-02T09:30:00Z");
    // other cannot read it (visibility 'own')
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.meetings where id = $1", [meeting]))).toBe(0);

    const rows = await busy(other, org, [rep.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: rep.id, meeting_id: null, title: null });
    expect(rows[0].starts_at.toISOString()).toBe("2026-11-02T08:30:00.000Z");
    expect(rows[0].ends_at.toISOString()).toBe("2026-11-02T09:30:00.000Z");
    expect(Object.keys(rows[0]).sort()).toEqual(["ends_at", "meeting_id", "starts_at", "title", "user_id"]);

    // the organizer and the owner (admin) may read it: id and title come back
    for (const caller of [rep, owner]) {
      expect(await busy(caller, org, [rep.id])).toMatchObject([{ user_id: rep.id, meeting_id: meeting, title: "פגישה סודית" }]);
    }
  });

  it("excluding a meeting the caller cannot read changes nothing (it would tell who is in it)", async () => {
    const window = { f: "2026-11-04T08:00:00Z", t: "2026-11-04T09:00:00Z" };
    const hidden = await newMeeting(rep, org, "2026-11-04T08:00:00Z", "2026-11-04T09:00:00Z");
    const rows = await busy(other, org, [rep.id], window.f, window.t, hidden);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: rep.id, meeting_id: null, title: null });
    // the organizer, who may read it, does get it left out
    expect(await busy(rep, org, [rep.id], window.f, window.t, hidden)).toHaveLength(0);
  });

  it("a viewer, who never schedules, is refused", async () => {
    expect((await pgError(busy(viewer, org, [rep.id]))).code).toBe("42501");
  });

  it("counts meetings a person takes part in, not only the ones they organize", async () => {
    const meeting = await newMeeting(owner, org, "2026-11-02T07:00:00Z", "2026-11-02T08:15:00Z");
    await asUser(owner.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, meeting, other.id]));
    // rep cannot read the owner's meeting: times only
    expect((await busy(rep, org, [other.id])).map((r) => [r.user_id, r.meeting_id, r.title])).toEqual([[other.id, null, null]]);
    // other takes part, so may read it
    expect((await busy(other, org, [other.id])).map((r) => [r.user_id, r.meeting_id])).toEqual([[other.id, meeting]]);
  });

  it("leaves out cancelled, no-show, back to back, and the excluded meeting", async () => {
    const window = { f: "2026-11-03T08:00:00Z", t: "2026-11-03T09:00:00Z" };
    await newMeeting(rep, org, "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z", "cancelled");
    await newMeeting(rep, org, "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z", "no_show");
    await newMeeting(rep, org, "2026-11-03T07:00:00Z", "2026-11-03T08:00:00Z");
    await newMeeting(rep, org, "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z");
    expect(await busy(other, org, [rep.id], window.f, window.t)).toHaveLength(0);

    const held = await newMeeting(rep, org, "2026-11-03T08:10:00Z", "2026-11-03T08:20:00Z", "held");
    expect((await busy(rep, org, [rep.id], window.f, window.t)).map((r) => r.meeting_id)).toEqual([held]);
    expect(await busy(rep, org, [rep.id], window.f, window.t, held)).toHaveLength(0);
  });

  it("answers only for members of the organization, and only to its members", async () => {
    // the stranger's own meeting in their organization, at the same time
    await newMeeting(stranger, otherOrg, from, to);
    expect(await busy(rep, org, [stranger.id])).toHaveLength(0);

    for (const attempt of [busy(stranger, org, [rep.id]), busy(rep, otherOrg, [stranger.id])]) {
      expect((await pgError(attempt)).code).toBe("42501");
    }
    const anon = await pgError(asAnon((q) => q("select * from public.meeting_busy($1, $2::uuid[], $3, $4)", [org, [rep.id], from, to])));
    expect(anon.code).toBe("42501");
  });

  it("refuses an oversized question", async () => {
    const many = Array.from({ length: 52 }, () => rep.id);
    expect((await pgError(busy(rep, org, many))).code).toBe("22023");
    expect((await pgError(busy(rep, org, [rep.id], from, "2026-11-20T09:00:00Z"))).code).toBe("22023");
    expect((await pgError(busy(rep, org, [rep.id], to, from))).code).toBe("22023");
  });

  it("is security definer with a pinned search path, executable by authenticated only", async () => {
    const fn = await asAdmin(async (q) =>
      (
        await q<{ secdef: boolean; config: string[] | null; anon: boolean; auth: boolean; pub: boolean }>(`
          select p.prosecdef as secdef, p.proconfig as config,
                 has_function_privilege('anon', p.oid, 'execute') as anon,
                 has_function_privilege('authenticated', p.oid, 'execute') as auth,
                 exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'meeting_busy'`)
      ).rows,
    );
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatchObject({ secdef: true, anon: false, auth: true, pub: false });
    expect(fn[0].config).toContain('search_path=""');
  });
});
