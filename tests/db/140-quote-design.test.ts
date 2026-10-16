import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-05: the design of quotes, one row per business. Members read it; owners and admins of a writable
 * business write it; nobody removes it; the colour is '#rrggbb' or none; the texts have their limits.
 */
describe("quote design (QUO-05)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const upsert = (u: U, values: Record<string, unknown>) =>
    run(u, (q) => {
      const keys = Object.keys(values);
      return q(
        `insert into public.quote_designs (organization_id${keys.map((k) => `, ${k}`).join("")}) values ($1${keys.map((_, i) => `, $${i + 2}`).join("")})
         on conflict (organization_id) do update set ${keys.map((k) => `${k} = excluded.${k}`).join(", ") || "show_logo = excluded.show_logo"}
         returning id, updated_by`,
        [org, ...Object.values(values)],
      );
    });

  beforeAll(async () => {
    owner = await createUser("qd-owner");
    org = await createOrg(owner.id, "עסק העיצוב");
    admin = await addMember(org, owner.id, "admin", "qd-admin");
    member = await addMember(org, owner.id, "member", "qd-member");
    viewer = await addMember(org, owner.id, "viewer", "qd-viewer");
  });

  it("owners and admins write the one row; members and viewers read it and change nothing; nobody deletes it", async () => {
    const made = await upsert(admin, { header_text: "כותרת", accent_color: "#1e56d6" });
    expect(made.rows[0].updated_by).toBe(admin.id);
    await upsert(owner, { footer_text: "תחתית" });
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_designs where organization_id = $1", [org]))).toBe(1);
    for (const u of [member, viewer]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quote_designs where organization_id = $1", [org])), u.email).toBe(1);
      expect((await pgError(upsert(u, { header_text: "x" }))).code, u.email).toBe("42501");
      expect(await run(u, async (q) => (await q("update public.quote_designs set header_text = 'x' where organization_id = $1", [org])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("update public.quote_designs set header_text = 'x'")).rowCount), u.email).toBe(0);
    }
    for (const u of [owner, member]) {
      expect((await pgError(run(u, (q) => q("delete from public.quote_designs where organization_id = $1", [org])))).code, u.email).toBe("42501");
    }
    // in a business with no row yet, a member or viewer cannot add one
    const fresh = await createOrg(owner.id, "עסק בלי עיצוב עדיין");
    const freshMember = await addMember(fresh, owner.id, "member", "qd-fresh-member");
    const freshViewer = await addMember(fresh, owner.id, "viewer", "qd-fresh-viewer");
    for (const u of [freshMember, freshViewer]) {
      expect((await pgError(run(u, (q) => q("insert into public.quote_designs (organization_id, header_text) values ($1, 'x')", [fresh])))).code, u.email).toBe("42501");
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_designs where organization_id = $1", [fresh]))).toBe(0);
    // the author column is the server's
    expect((await pgError(run(owner, (q) => q("update public.quote_designs set updated_by = $2 where organization_id = $1", [org, member.id])))).code).toBe("42501");
  });

  it("a read-only business changes nothing", async () => {
    await upsert(admin, { header_text: "לפני" });
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      for (const u of [owner, admin]) {
        expect(await run(u, async (q) => (await q("update public.quote_designs set header_text = 'אחרי' where organization_id = $1", [org])).rowCount), u.email).toBe(0);
      }
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    // a business with no row yet cannot add one while read-only either
    const other = await createOrg(owner.id, "עסק בלי עיצוב");
    const otherStatus = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [other])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [other]));
    try {
      expect((await pgError(run(owner, (q) => q("insert into public.quote_designs (organization_id) values ($1)", [other])))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [otherStatus, other]));
    }
  });

  it("checks the colour and the length of the texts", async () => {
    for (const bad of ["#ABCDEF", "red", "#12345", "#1234567"]) {
      expect((await pgError(upsert(admin, { accent_color: bad }))).code, bad).toBe("23514");
    }
    expect((await pgError(upsert(admin, { header_text: "א".repeat(501) }))).code).toBe("23514");
    expect((await pgError(upsert(admin, { footer_text: "א".repeat(1001) }))).code).toBe("23514");
    expect((await pgError(upsert(admin, { header_text: "   " }))).code).toBe("23514");
    await upsert(admin, { accent_color: null, header_text: null });
    expect(await asAdmin(async (q) => (await q("select accent_color, header_text from public.quote_designs where organization_id = $1", [org])).rows[0])).toEqual({
      accent_color: null,
      header_text: null,
    });
  });

  it("the update policy checks the new row as it checks the old one", async () => {
    // organization_id has no update grant, so only the policy text shows a weakening of the new-row check
    const row = await asAdmin(async (q) =>
      (await q<{ qual: string; with_check: string }>("select qual, with_check from pg_policies where schemaname = 'public' and policyname = 'quote_designs_update'")).rows[0],
    );
    expect(row.with_check).toBe(row.qual);
    expect(row.qual).toMatch(/is_admin\(organization_id\) AND app\.org_writable\(organization_id\)/);
  });
});
