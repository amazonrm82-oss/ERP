import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * BIZ-01, the owner's answer (316) ב of 12 November 2026 (migration 021243): owners and admins replace the business page's
 * secret link; the old link answers "not found" at once, the new one works, and the audit log never holds a token.
 */
describe("business page: a new link (316) ב", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string;
  let page: { id: string; token: string };
  let seq = 0;
  const hash = () => `bpl-${process.pid}-${++seq}`.padStart(64, "0");
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const view = (token: string) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.business_page_public($1, $2) as r", [token, hash()])).r);
  const renew = (u: U, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.business_page_link_create($1) as t", [orgId])).t);

  beforeAll(async () => {
    owner = await createUser("bpl-owner");
    org = await createOrg(owner.id, "עסק הקישור");
    admin = await addMember(org, owner.id, "admin", "bpl-admin");
    manager = await addMember(org, owner.id, "manager", "bpl-manager");
    member = await addMember(org, owner.id, "member", "bpl-member");
    viewer = await addMember(org, owner.id, "viewer", "bpl-viewer");
    outsider = await createUser("bpl-outsider");
    await createOrg(outsider.id, "עסק זר");
    page = await asUser(owner.id, (q) =>
      one<{ id: string; token: string }>(q, "insert into public.business_pages (organization_id, is_active, about) values ($1, true, 'דף') returning id, token", [org]),
    );
  });

  it("the old token is not found at once, the new one works, the form keeps working", async () => {
    expect(await view(page.token)).toMatchObject({ business: "עסק הקישור" });
    const fresh = await renew(admin);
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh).not.toBe(page.token);
    expect((await pgError(view(page.token))).code).toBe("P0002");
    expect(await view(fresh)).toMatchObject({ business: "עסק הקישור" });
    const reply = await asService(async (q) =>
      (await one<{ r: unknown }>(q, "select public.business_page_submit($1, $2, $3, 'test', false) as r", [fresh, JSON.stringify({ full_name: "פונה", phone: "050-7002001" }), hash()])).r,
    );
    expect(reply).toEqual({ status: "accepted" });
    const again = await renew(owner);
    expect((await pgError(view(fresh))).code).toBe("P0002");
    expect(await view(again)).toMatchObject({ business: "עסק הקישור" });
    page.token = again;
  });

  it("only owners and admins of the business; never in a read-only business", async () => {
    for (const u of [manager, member, viewer, outsider]) expect((await pgError(renew(u))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select public.business_page_link_create($1)", [org])))).code).toBe("42501");
    const status = await asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.organizations where id = $1", [org])).status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(renew(owner))).hint).toBe("org:read_only");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
    }
    expect(await view(page.token)).toMatchObject({ business: "עסק הקישור" });
  });

  it("a business without a page gets not found", async () => {
    const lone = await createUser("bpl-lone");
    const loneOrg = await createOrg(lone.id, "בלי דף");
    expect((await pgError(renew(lone, loneOrg))).code).toBe("P0002");
  });

  it("the audit log says a link was made, never which", async () => {
    const before = await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'business_page_link'", [org]));
    const token = await renew(owner);
    const entries = await asAdmin(async (q) =>
      (await q<{ action: string; changes: unknown; actor_id: string; entity_id: string }>(
        "select action, changes, actor_id, entity_id from public.audit_log where organization_id = $1 and action = 'business_page_link' order by created_at",
        [org],
      )).rows,
    );
    expect(entries.length).toBe(before + 1);
    expect(entries.at(-1)).toEqual({ action: "business_page_link", changes: { link: "created" }, actor_id: owner.id, entity_id: page.id });
    const all = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where organization_id = $1", [org])).rows);
    for (const t of [token, page.token]) expect(JSON.stringify(all)).not.toContain(t);
    // an ordinary change of the page is still audited
    await asUser(owner.id, (q) => q("update public.business_pages set about = 'דף חדש' where id = $1", [page.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'business_pages' and action = 'update' and changes ? 'about'", [org]))).toBe(1);
  });
});
