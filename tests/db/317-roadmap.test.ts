import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

// TRU-01: the roadmap. Items are written only by the platform owner or support (aal2, logged); members read published
// items through one definer function; an owner or admin casts the business's single vote; counts only, never who voted.

const staffIds: string[] = [];
const itemIds: string[] = [];
const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};

afterAll(async () => {
  await asAdmin((q) => q("delete from app.roadmap_items where id = any($1)", [itemIds]));
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

type Item = { id: string; title: string; description: string; status: string; votes: number; voted: boolean; can_vote: boolean };

const add = async (userId: string, opts: { title?: string; status?: string; published?: boolean; requests?: string[] } = {}) => {
  const id = await asMfaUser(userId, async (q) =>
    (
      await q<{ id: string }>("select public.platform_add_roadmap_item($1, $2, $3, $4, 0, $5::uuid[]) as id", [
        opts.title ?? "שליחת מיילים ללקוחות",
        "תיאור קצר שכתב הצוות",
        opts.status ?? "planned",
        opts.published ?? true,
        opts.requests ?? [],
      ])
    ).rows[0].id,
  );
  itemIds.push(id);
  return id;
};
const seen = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ r: Item[] }>("select public.roadmap_items_for($1) as r", [org])).rows[0].r);
const vote = (userId: string, org: string, item: string, on = true) =>
  asUser(userId, async (q) => (await q<{ r: { votes: number; voted: boolean } }>("select public.roadmap_vote($1, $2, $3) as r", [org, item, on])).rows[0].r);
const find = (list: Item[], id: string) => list.find((i) => i.id === id);

describe("TRU-01: roadmap", () => {
  let owner: { id: string };
  let support: { id: string };
  let finance: { id: string };
  let alice: { id: string };
  let bob: { id: string };
  let carol: { id: string };
  let dave: { id: string };
  let vic: { id: string };
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    owner = await createUser("tru01-owner");
    support = await createUser("tru01-support");
    finance = await createUser("tru01-finance");
    await makeStaff(owner.id, "owner");
    await makeStaff(support.id, "support");
    await makeStaff(finance.id, "finance");
    alice = await createUser("tru01-alice");
    bob = await createUser("tru01-bob");
    orgA = await createOrg(alice.id, "עסק א");
    orgB = await createOrg(bob.id, "עסק ב");
    carol = await addMember(orgA, alice.id, "member", "tru01-carol");
    dave = await addMember(orgA, alice.id, "admin", "tru01-dave");
    vic = await addMember(orgA, alice.id, "viewer", "tru01-vic");
  });

  it("only the platform owner or support with two-step verification write items; it is logged", async () => {
    const sql = "select public.platform_add_roadmap_item('x', 'y', 'planned', true, 0, '{}')";
    expect((await pgError(asMfaUser(finance.id, (q) => q(sql)))).code).toBe("42501");
    expect((await pgError(asMfaUser(alice.id, (q) => q(sql)))).code).toBe("42501");
    expect((await pgError(asUser(support.id, (q) => q(sql)))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q(sql)))).code).toBe("42501");

    const id = await add(support.id, { title: "  ייבוא   מאקסל\nמהיר " });
    const row = await asAdmin(async (q) => (await q<{ title: string; created_by: string }>("select title, created_by from app.roadmap_items where id = $1", [id])).rows[0]);
    expect(row.title).toBe("ייבוא מאקסל מהיר");
    expect(row.created_by).toBe(support.id);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'roadmap.add' and details->>'id' = $1", [id]))).toBe(1);

    await asMfaUser(owner.id, (q) => q("select public.platform_update_roadmap_item($1, 'כותרת חדשה', 'תיאור', 'building', true, 5, '{}')", [id]));
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'roadmap.update' and details->>'id' = $1 and details->>'status_before' = 'planned'", [id]))).toBe(1);
    expect((await pgError(asMfaUser(finance.id, (q) => q("select public.platform_update_roadmap_item($1, 'x', 'y', 'done', true, 0, '{}')", [id])))).code).toBe("42501");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_update_roadmap_item($1, 'x', 'y', 'done', true, 0, '{}')", [crypto.randomUUID()])))).code).toBe("P0002");
  });

  it("refuses bad input", async () => {
    const bad = async (sql: string) => (await pgError(asMfaUser(owner.id, (q) => q(sql)))).code;
    expect(await bad("select public.platform_add_roadmap_item('', 'y', 'planned', true, 0, '{}')")).toBe("22023");
    expect(await bad(`select public.platform_add_roadmap_item('${"א".repeat(121)}', 'y', 'planned', true, 0, '{}')`)).toBe("22023");
    expect(await bad("select public.platform_add_roadmap_item('x', ' ', 'planned', true, 0, '{}')")).toBe("22023");
    expect(await bad("select public.platform_add_roadmap_item('x', 'y', 'someday', true, 0, '{}')")).toBe("22023");
    expect(await bad("select public.platform_add_roadmap_item('x', 'y', 'planned', true, 999999, '{}')")).toBe("22023");
    expect(await bad(`select public.platform_add_roadmap_item('x', 'y', 'planned', true, 0, array['${crypto.randomUUID()}']::uuid[])`)).toBe("22023");
  });

  it("links support requests by id only; the business never sees them", async () => {
    const request = await asUser(carol.id, async (q) =>
      (await q<{ id: string }>("insert into public.support_requests (organization_id, category, subject, message) values ($1, 'feature', 'בקשה של לקוח', 'טקסט פרטי של הלקוח') returning id", [orgA])).rows[0].id,
    );
    const id = await add(owner.id, { title: "פריט מבקשה", requests: [request, request] });
    const stored = await asAdmin(async (q) => (await q<{ r: string[] }>("select request_ids as r from app.roadmap_items where id = $1", [id])).rows[0].r);
    expect(stored).toEqual([request]);
    type L = { l: { total: number; items: { id: string; request_ids: string[] | null }[] } };
    // the owner and support read the linked ids; finance and readonly get null (they do not read support requests)
    for (const who of [owner.id, support.id]) {
      const list = await asMfaUser(who, async (q) => (await q<L>("select public.platform_list_roadmap_items() as l")).rows[0].l);
      expect(list.items.find((i) => i.id === id)?.request_ids).toEqual([request]);
    }
    const forFinance = await asMfaUser(finance.id, async (q) => (await q<L>("select public.platform_list_roadmap_items() as l")).rows[0].l);
    expect(forFinance.items.find((i) => i.id === id)?.request_ids).toBeNull();
    expect(JSON.stringify(forFinance)).not.toContain(request);
    // nothing of the request, not even its id, reaches a member
    const text = JSON.stringify(await seen(alice.id, orgA));
    expect(text).not.toContain(request);
    expect(text).not.toContain("טקסט פרטי");
  });

  it("members see published items only; outsiders and anon see nothing; no API role reads the tables", async () => {
    const pub = await add(owner.id, { title: "מפורסם" });
    const hidden = await add(owner.id, { title: "טיוטה", published: false });
    const forCarol = await seen(carol.id, orgA);
    expect(find(forCarol, pub)).toBeTruthy();
    expect(find(forCarol, hidden)).toBeUndefined();
    expect(Object.keys(find(forCarol, pub)!).sort()).toEqual(["can_vote", "description", "id", "status", "title", "voted", "votes"]);
    // bob is not a member of A
    expect(await seen(bob.id, orgA)).toEqual([]);
    expect((await pgError(asAnon((q) => q("select public.roadmap_items_for($1)", [orgA])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.roadmap_vote($1, $2, true)", [orgA, pub])))).code).toBe("42501");
    expect((await pgError(asUser(alice.id, (q) => q("select * from app.roadmap_items")))).code).toBe("42501");
    expect((await pgError(asUser(alice.id, (q) => q("select * from app.roadmap_votes")))).code).toBe("42501");
    // a hidden item cannot be voted on
    expect((await pgError(vote(alice.id, orgA, hidden))).code).toBe("P0002");
  });

  it("one vote per business: owners and admins cast it, members and viewers cannot; withdrawing and voting again", async () => {
    const id = await add(owner.id, { title: "הצבעה" });
    expect(find(await seen(carol.id, orgA), id)?.can_vote).toBe(false);
    expect(find(await seen(alice.id, orgA), id)?.can_vote).toBe(true);
    for (const who of [carol.id, vic.id]) {
      const err = await pgError(vote(who, orgA, id));
      expect(err.code).toBe("P0001");
      expect(err.hint).toBe("roadmap:vote_admin");
    }
    // bob cannot vote for A
    expect((await pgError(vote(bob.id, orgA, id))).code).toBe("42501");

    expect(await vote(alice.id, orgA, id)).toEqual({ votes: 1, voted: true });
    // the admin of the same business votes again: still one vote for the business
    expect(await vote(dave.id, orgA, id)).toEqual({ votes: 1, voted: true });
    expect(await asAdmin((q) => count(q, "select 1 from app.roadmap_votes where item_id = $1", [id]))).toBe(1);
    // another business adds its own
    expect(await vote(bob.id, orgB, id)).toEqual({ votes: 2, voted: true });
    // the member of A sees that A voted and the count, never which businesses
    const forCarol = find(await seen(carol.id, orgA), id)!;
    expect(forCarol.voted).toBe(true);
    expect(forCarol.votes).toBe(2);
    expect(JSON.stringify(await seen(carol.id, orgA))).not.toContain(orgB);

    expect(await vote(dave.id, orgA, id, false)).toEqual({ votes: 1, voted: false });
    expect(await vote(dave.id, orgA, id, false)).toEqual({ votes: 1, voted: false });
    expect(find(await seen(bob.id, orgB), id)).toMatchObject({ votes: 1, voted: true });
    expect(await vote(alice.id, orgA, id)).toEqual({ votes: 2, voted: true });
    // the row stays (never deleted), only marked
    expect(await asAdmin((q) => count(q, "select 1 from app.roadmap_votes where item_id = $1 and organization_id = $2 and withdrawn_at is null", [id, orgA]))).toBe(1);

    const list = await asMfaUser(finance.id, async (q) => (await q<{ l: { total: number; items: { id: string; votes: number }[] } }>("select public.platform_list_roadmap_items() as l")).rows[0].l);
    expect(list.total).toBe(await asAdmin((q) => count(q, "select 1 from app.roadmap_items")));
    const row = list.items.find((i) => i.id === id)!;
    expect(row.votes).toBe(2);
    expect(JSON.stringify(row)).not.toContain(orgA);
    expect((await pgError(asMfaUser(alice.id, (q) => q("select public.platform_list_roadmap_items()")))).code).toBe("42501");
  });

  it("a done item takes no votes; its count stays", async () => {
    const id = await add(owner.id, { title: "נגמר" });
    await vote(alice.id, orgA, id);
    await asMfaUser(owner.id, (q) => q("select public.platform_update_roadmap_item($1, 'נגמר', 'תיאור', 'done', true, 0, '{}')", [id]));
    expect((await pgError(vote(bob.id, orgB, id))).hint).toBe("roadmap:done");
    expect(find(await seen(alice.id, orgA), id)).toMatchObject({ votes: 1, voted: true, can_vote: false });
  });

  it("a suspended member reads nothing and cannot vote; a closed business cannot vote", async () => {
    const id = await add(owner.id, { title: "סגור" });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [orgA, dave.id]));
    try {
      expect(await seen(dave.id, orgA)).toEqual([]);
      expect((await pgError(vote(dave.id, orgA, id))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [orgA, dave.id]));
    }
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [orgA]));
    try {
      // the owner of a closed business still reads, but does not vote
      expect(find(await seen(alice.id, orgA), id)?.can_vote).toBe(false);
      expect((await pgError(vote(alice.id, orgA, id))).hint).toBe("roadmap:closed");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [orgA]));
    }
  });

  it("a deleted business's vote no longer counts", async () => {
    const id = await add(owner.id, { title: "מחיקה" });
    const other = await createUser("tru01-other");
    const orgC = await createOrg(other.id, "עסק ג");
    await vote(other.id, orgC, id);
    expect((await vote(alice.id, orgA, id)).votes).toBe(2);
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [orgC]));
    expect(find(await seen(alice.id, orgA), id)?.votes).toBe(1);
    // a deleted business can neither vote again nor take its vote back
    expect(find(await seen(other.id, orgC), id)?.can_vote).toBe(false);
    for (const on of [true, false]) {
      const err = await pgError(vote(other.id, orgC, id, on));
      expect(err.code).toBe("P0001");
      expect(err.hint).toBe("roadmap:closed");
    }
    expect(await asAdmin((q) => count(q, "select 1 from app.roadmap_votes where item_id = $1 and organization_id = $2 and withdrawn_at is null", [id, orgC]))).toBe(1);
  });

  it("platform support in an open support session reads but does not vote", async () => {
    const id = await add(owner.id, { title: "תמיכה" });
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [orgB]));
    await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [orgB]));
    try {
      const list = await asMfaUser(support.id, async (q) => (await q<{ r: Item[] }>("select public.roadmap_items_for($1) as r", [orgB])).rows[0].r);
      expect(find(list, id)?.can_vote).toBe(false);
      expect((await pgError(asMfaUser(support.id, (q) => q("select public.roadmap_vote($1, $2, true)", [orgB, id])))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [orgB]));
    }
  });
});
