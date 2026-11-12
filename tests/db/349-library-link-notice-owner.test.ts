import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * LIB-02, the owner's answer (299) ב of 12 November 2026 (migration 021241): the first opening of a tracked library link
 * tells the maker while an active member who reads the record; else the record's current owner while an active member who
 * is not a viewer and reads the record; else the active owners and admins.
 */
describe("library link: who is told on the first opening (299) ב", () => {
  let owner: U, admin: U, maker: U, rep: U, viewer: U, gone: U;
  let org: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const lead = async (ownerId: string | null) => {
    const status = await defaultLeadStatus(org);
    return asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, owner_id) values ($1, $2, 'דנה כהן', $3) returning id", [org, status, ownerId])).id,
    );
  };
  const item = (title: string) =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title, url) values ($1, 'link', $2, 'https://example.com/a') returning id", [org, title])).id,
    );
  const create = (u: U, itemId: string, leadId: string) =>
    asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.library_link_create($1, $2, 'lead', $3) as t", [org, itemId, leadId])).t);
  const open = (token: string) =>
    asService((q) => q("select public.library_link_public($1, $2)", [token, sha256(`owner-notice-${++n}`)]));
  const notices = (u: U) => asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'library_viewed'", [u.id]));
  const snapshot = async () => {
    const out: Record<string, number> = {};
    for (const [name, u] of Object.entries({ owner, admin, maker, rep, viewer, gone })) out[name] = await notices(u);
    return out;
  };
  const delta = async (before: Record<string, number>) => {
    const after = await snapshot();
    return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]]));
  };
  const setOwner = (leadId: string, ownerId: string | null) => asAdmin((q) => q("update public.leads set owner_id = $2 where id = $1", [leadId, ownerId]));
  const leave = (u: U) => asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, u.id]));
  const back = (u: U) => asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, u.id]));

  beforeAll(async () => {
    owner = await createUser("ln-owner");
    org = await createOrg(owner.id, "עסק ההודעות");
    admin = await addMember(org, owner.id, "admin", "ln-admin");
    maker = await addMember(org, owner.id, "member", "ln-maker");
    rep = await addMember(org, owner.id, "member", "ln-rep");
    viewer = await addMember(org, owner.id, "viewer", "ln-viewer");
    gone = await addMember(org, owner.id, "member", "ln-gone");
  });

  it("the maker, while an active member who reads the record (unchanged)", async () => {
    const leadId = await lead(maker.id);
    const token = await create(maker, await item("פריט א"), leadId);
    await setOwner(leadId, rep.id);
    const before = await snapshot();
    await open(token);
    await open(token);
    expect(await delta(before)).toEqual({ owner: 0, admin: 0, maker: 1, rep: 0, viewer: 0, gone: 0 });
  });

  it("the maker left: the record's current owner, with the item's title only", async () => {
    const leadId = await lead(maker.id);
    const token = await create(maker, await item("פריט ב"), leadId);
    await setOwner(leadId, rep.id);
    await leave(maker);
    try {
      const before = await snapshot();
      await open(token);
      await open(token);
      expect(await delta(before)).toEqual({ owner: 0, admin: 0, maker: 0, rep: 1, viewer: 0, gone: 0 });
      const notice = await asAdmin(async (q) =>
        one<{ title: string; body: string; entity_type: string; entity_id: string }>(
          q,
          "select title, body, entity_type, entity_id from public.notifications where user_id = $1 and type = 'library_viewed' order by created_at desc limit 1",
          [rep.id],
        ),
      );
      expect(notice).toEqual({ title: "הלקוח פתח קישור שנשלח מהספרייה", body: "פריט ב", entity_type: "lead", entity_id: leadId });
    } finally {
      await back(maker);
    }
  });

  it("the maker left and the record's owner is not usable (none, a viewer, or suspended): the owners and admins", async () => {
    await leave(gone);
    try {
      // no owner
      let leadId = await lead(maker.id);
      let token = await create(maker, await item("פריט ג"), leadId);
      await leave(maker);
      await setOwner(leadId, null);
      let before = await snapshot();
      await open(token);
      expect(await delta(before)).toEqual({ owner: 1, admin: 1, maker: 0, rep: 0, viewer: 0, gone: 0 });

      // a viewer owns it
      await back(maker);
      leadId = await lead(maker.id);
      token = await create(maker, await item("פריט ד"), leadId);
      await leave(maker);
      await setOwner(leadId, viewer.id);
      before = await snapshot();
      await open(token);
      expect(await delta(before)).toEqual({ owner: 1, admin: 1, maker: 0, rep: 0, viewer: 0, gone: 0 });

      // a suspended member owns it
      await back(maker);
      leadId = await lead(maker.id);
      token = await create(maker, await item("פריט ה"), leadId);
      await leave(maker);
      await setOwner(leadId, gone.id);
      before = await snapshot();
      await open(token);
      expect(await delta(before)).toEqual({ owner: 1, admin: 1, maker: 0, rep: 0, viewer: 0, gone: 0 });
    } finally {
      await back(maker);
      await back(gone);
    }
  });
});
