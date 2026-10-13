import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type FeedEvent = { id: string; title: string; starts_at: string; ends_at: string; location: string | null; video_url: string | null; status: string; updated_at: string };
type Feed = { ok: boolean; reason?: string; calendar?: { name: string; time_zone: string }; events?: FeedEvent[] };

/**
 * CAL-07: a personal, secret calendar link. Only the hash of the token is kept
 * (app.calendar_feeds); public.calendar_feed_events(token) is for the server
 * route (service_role) and returns only the meetings the link's owner
 * organizes or takes part in, in that organization, with no notes. A wrong,
 * replaced or turned-off token, a suspended member and a suspended
 * organization get nothing; a read-only organization keeps its feed.
 */
describe("personal calendar feed (CAL-07)", () => {
  let owner: U, rep: U, other: U;
  let org: string, otherOrg: string;
  let stranger: U;

  const day = (offset: number, hour = 9) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  const newMeeting = (user: U, orgId: string, title: string, offset = 3, extra: { status?: string; description?: string; outcome?: string } = {}) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, location, video_url, status, description, outcome)
           values ($1, $2, $3, $4, 'המשרד, רחוב הרצל 1', 'https://meet.example/abc', $5, $6, $7) returning id`,
          [orgId, title, day(offset), day(offset, 10), extra.status ?? "planned", extra.description ?? null, extra.outcome ?? null],
        )
      ).rows[0].id,
    );

  const create = (user: U, orgId: string) =>
    asUser(user.id, async (q) => (await q<{ token: string }>("select public.calendar_feed_create($1) as token", [orgId])).rows[0].token);

  const feed = (token: string) =>
    asService(async (q) => (await q<{ feed: Feed }>("select public.calendar_feed_events($1) as feed", [token])).rows[0].feed);

  beforeAll(async () => {
    owner = await createUser("feed-owner");
    org = await createOrg(owner.id, "עסק היומן");
    rep = await addMember(org, owner.id, "member", "feed-rep");
    other = await addMember(org, owner.id, "member", "feed-other");
    stranger = await createUser("feed-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
  });

  it("makes an unguessable token, keeps only its hash, and shows it once", async () => {
    const token = await create(rep, org);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin(async (q) =>
      (await q<{ token_hash: string }>("select token_hash from app.calendar_feeds where organization_id = $1 and user_id = $2", [org, rep.id])).rows[0],
    );
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(token);
    const status = await asUser(rep.id, async (q) => (await q<{ s: { active: boolean } }>("select public.calendar_feed_status($1) as s", [org])).rows[0].s);
    expect(status.active).toBe(true);
    expect(Object.keys(status).sort()).toEqual(["active", "created_at", "last_used_at"]);
    // two links are never the same
    expect(await create(other, org)).not.toBe(token);
  });

  it("returns the meetings the person organizes or takes part in, without notes or other people's meetings", async () => {
    const mine = await newMeeting(rep, org, "פגישה שלי", 2, { description: "הערות סודיות", outcome: "תוצאה סודית" });
    const joined = await newMeeting(owner, org, "פגישה שהוזמנתי", 4);
    await asUser(owner.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, joined, rep.id]));
    const notMine = await newMeeting(other, org, "פגישה של אחר", 5);
    const cancelled = await newMeeting(rep, org, "פגישה שבוטלה", 6, { status: "cancelled" });
    const tooOld = await newMeeting(rep, org, "פגישה ישנה", -40);
    const tooFar = await newMeeting(rep, org, "פגישה רחוקה", 400);
    await newMeeting(stranger, otherOrg, "פגישה בעסק אחר", 3);

    const token = await create(rep, org);
    const result = await feed(token);
    expect(result.ok).toBe(true);
    expect(result.calendar).toEqual({ name: "עסק היומן", time_zone: "Asia/Jerusalem" });
    const ids = result.events!.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([mine, joined, cancelled]));
    expect(ids).not.toContain(notMine);
    expect(ids).not.toContain(tooOld);
    expect(ids).not.toContain(tooFar);
    for (const event of result.events!) {
      expect(Object.keys(event).sort()).toEqual(["ends_at", "id", "location", "starts_at", "status", "title", "updated_at", "video_url"]);
    }
    expect(JSON.stringify(result)).not.toContain("סודי");
    expect(result.events!.find((e) => e.id === cancelled)!.status).toBe("cancelled");

    // a person removed from the meeting no longer sees it
    await asUser(owner.id, (q) => q("delete from public.meeting_participants where meeting_id = $1 and user_id = $2", [joined, rep.id]));
    expect((await feed(token)).events!.map((e) => e.id)).not.toContain(joined);
  });

  it("a wrong, malformed, replaced or turned-off token gets nothing", async () => {
    for (const bad of ["", "abc", "x".repeat(64), "'; select 1; --".padEnd(64, "a")]) {
      expect(await feed(bad)).toEqual({ ok: false });
    }
    const first = await create(rep, org);
    expect((await feed(first)).ok).toBe(true);
    const second = await create(rep, org);
    expect(await feed(first)).toEqual({ ok: false });
    expect((await feed(second)).ok).toBe(true);

    await asUser(rep.id, (q) => q("select public.calendar_feed_revoke($1)", [org]));
    expect(await feed(second)).toEqual({ ok: false });
    const status = await asUser(rep.id, async (q) => (await q<{ s: { active: boolean } }>("select public.calendar_feed_status($1) as s", [org])).rows[0].s);
    expect(status).toEqual({ active: false, created_at: null, last_used_at: null });
  });

  it("suspending a member turns the link off for good; reactivating does not bring it back", async () => {
    const token = await create(other, org);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, other.id]));
    expect(await feed(token)).toEqual({ ok: false });
    expect(await asAdmin((q) => count(q, "select 1 from app.calendar_feeds where user_id = $1 and token_hash is not null", [other.id]))).toBe(0);
    // a suspended member cannot make a new link either
    expect((await pgError(create(other, org))).code).toBe("42501");
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, other.id]));
    expect(await feed(token)).toEqual({ ok: false });
    // a new link works
    expect((await feed(await create(other, org))).ok).toBe(true);
  });

  it("making a link needs the second step where the business requires it, and is not for a support session", async () => {
    const mfaOwner = await createUser("feed-mfa-owner");
    const mfaOrg = await createOrg(mfaOwner.id, "עסק עם אימות");
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [mfaOrg]));
    expect((await pgError(create(mfaOwner, mfaOrg))).code).toBe("42501");
    const token = await asMfaUser(mfaOwner.id, async (q) => (await q<{ token: string }>("select public.calendar_feed_create($1) as token", [mfaOrg])).rows[0].token);
    expect((await feed(token)).ok).toBe(true);

    // platform support in an open, customer-approved session reads the business but is not a member
    const support = await createUser("feed-support");
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support')", [support.id]);
      await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]);
    });
    expect(await asMfaUser(support.id, (q) => count(q, "select 1 from public.organizations where id = $1", [org]))).toBe(1);
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.calendar_feed_create($1)", [org])))).code).toBe("42501");
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.calendar_feed_status($1)", [org])))).code).toBe("42501");
  });

  it("keeps working while the organization is read-only, and stops when it is suspended", async () => {
    const token = await create(rep, org);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    expect((await feed(token)).ok).toBe(true);
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    expect(await feed(token)).toEqual({ ok: false });
    // a member of a suspended business has no access at all (0161); its owner is told why
    expect((await pgError(create(rep, org))).code).toBe("42501");
    expect((await pgError(create(owner, org))).hint).toBe("org:suspended");
    await asAdmin((q) => q("update public.organizations set status = 'trial' where id = $1", [org]));
    expect((await feed(token)).ok).toBe(true);
  });

  it("a link belongs to one person in one organization", async () => {
    // a stranger cannot make a link in an organization they are not in, nor see its status
    expect((await pgError(create(stranger, org))).code).toBe("42501");
    expect((await pgError(asUser(stranger.id, (q) => q("select public.calendar_feed_status($1)", [org])))).code).toBe("42501");
    // revoking in someone else's organization touches nothing
    const token = await create(rep, org);
    await asUser(stranger.id, (q) => q("select public.calendar_feed_revoke($1)", [org]));
    expect((await feed(token)).ok).toBe(true);
    // the stranger's feed in their own organization shows only that organization's meetings
    const theirs = await create(stranger, otherOrg);
    const result = await feed(theirs);
    expect(result.calendar!.name).toBe("עסק אחר");
    expect(result.events!.map((e) => e.title)).toEqual(["פגישה בעסק אחר"]);
  });

  it("a removed member's link goes with the membership", async () => {
    const leaver = await addMember(org, owner.id, "member", "feed-leaver");
    await create(leaver, org);
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaver.id]));
    expect(await asAdmin((q) => count(q, "select 1 from app.calendar_feeds where user_id = $1", [leaver.id]))).toBe(0);
  });

  it("limits fetches to 60 per 10 minutes per link", async () => {
    const token = await create(owner, org);
    const results = await asService(async (q) => {
      const out: Feed[] = [];
      for (let i = 0; i < 61; i++) {
        out.push((await q<{ feed: Feed }>("select public.calendar_feed_events($1) as feed", [token])).rows[0].feed);
      }
      return out;
    });
    expect(results[59].ok).toBe(true);
    expect(results[60]).toEqual({ ok: false, reason: "rate" });
    // a new 10-minute window
    await asAdmin((q) => q("update app.calendar_feeds set window_started_at = now() - interval '11 minutes' where organization_id = $1 and user_id = $2", [org, owner.id]));
    expect((await feed(token)).ok).toBe(true);
  });

  it("only the server reads a feed; clients have no access to the links table", async () => {
    const token = await create(rep, org);
    for (const attempt of [
      () => asAnon((q) => q("select public.calendar_feed_events($1)", [token])),
      () => asUser(rep.id, (q) => q("select public.calendar_feed_events($1)", [token])),
      () => asUser(rep.id, (q) => q("select * from app.calendar_feeds")),
      () => asAnon((q) => q("select public.calendar_feed_create($1)", [org])),
      () => asAnon((q) => q("select public.calendar_feed_revoke($1)", [org])),
      () => asAnon((q) => q("select public.calendar_feed_status($1)", [org])),
    ]) {
      expect((await pgError(attempt())).code).toBe("42501");
    }
    const grants = await asAdmin(async (q) =>
      (
        await q<{ fn: string; role: string }>(
          `select p.oid::regprocedure::text as fn, r.role
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            cross join unnest(array['anon', 'authenticated', 'service_role']) r(role)
            where n.nspname = 'public' and p.proname like 'calendar\\_feed\\_%'
              and has_function_privilege(r.role, p.oid, 'execute')
            order by 1, 2`,
        )
      ).rows.map((r) => `${r.fn} ${r.role}`),
    );
    expect(grants).toEqual([
      "calendar_feed_create(uuid) authenticated",
      "calendar_feed_create(uuid) service_role",
      "calendar_feed_events(text) service_role",
      "calendar_feed_revoke(uuid) authenticated",
      "calendar_feed_revoke(uuid) service_role",
      "calendar_feed_status(uuid) authenticated",
      "calendar_feed_status(uuid) service_role",
    ]);
  });
});
