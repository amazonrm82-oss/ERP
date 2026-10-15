import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// FLD-04: the business's logo (public bucket org-logos) and main colour.
// Owners and admins set them; the hosted form reads them through intake_form().
describe("business branding (FLD-04)", () => {
  let owner: U, admin: U, manager: U, member: U, outsider: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("brand-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "brand-admin");
    manager = await addMember(org, owner.id, "manager", "brand-manager");
    member = await addMember(org, owner.id, "member", "brand-member");
    outsider = await createUser("brand-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  const update = (user: U, set: string, params: unknown[] = [], target = org) =>
    asUser(user.id, async (q) => (await q(`update public.organizations set ${set} where id = $1`, [target, ...params])).rowCount);
  const put = (user: U, name: string) => asUser(user.id, (q) => q("insert into storage.objects (bucket_id, name) values ('org-logos', $1)", [name]));
  const see = (user: U, name: string) => asUser(user.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'org-logos' and name = $1", [name]));
  const row = () =>
    asAdmin(async (q) => (await q<{ logo_path: string | null; brand_color: string | null }>("select logo_path, brand_color from public.organizations where id = $1", [org])).rows[0]);

  it("owners and admins set the colour; it must be #rrggbb in lower case", async () => {
    expect(await update(owner, "brand_color = '#1e56d6'")).toBe(1);
    expect(await update(admin, "brand_color = '#ffd400'")).toBe(1);
    expect((await row()).brand_color).toBe("#ffd400");
    for (const bad of ["#FFD400", "ffd400", "#fff", "red", "#ffd4000", "#ffd40g"]) {
      expect((await pgError(update(owner, "brand_color = $2", [bad]))).code).toBe("23514");
    }
    expect(await update(owner, "brand_color = null")).toBe(1);
  });

  it("managers, members and other businesses change nothing", async () => {
    for (const user of [manager, member]) expect(await update(user, "brand_color = '#000000'")).toBe(0);
    expect(await update(outsider, "brand_color = '#000000'")).toBe(0);
    expect(await update(owner, "brand_color = '#000000'", [], otherOrg)).toBe(0);
    expect((await row()).brand_color).toBeNull();
  });

  it("the two columns are granted for update like the other profile columns", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ column_name: string }>(
          `select column_name from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'organizations' and grantee = 'authenticated'
              and privilege_type = 'UPDATE' and column_name in ('logo_path', 'brand_color') order by 1`,
        )
      ).rows.map((r) => r.column_name),
    );
    expect(grants).toEqual(["brand_color", "logo_path"]);
  });

  describe("logo (bucket org-logos)", () => {
    it("the bucket is public and limited to 1 MB", async () => {
      const bucket = await asAdmin(async (q) => (await q<{ public: boolean; file_size_limit: string }>("select public, file_size_limit from storage.buckets where id = 'org-logos'")).rows[0]);
      expect(bucket.public).toBe(true);
      expect(Number(bucket.file_size_limit)).toBe(1024 * 1024);
    });

    it("only owners and admins upload, only into their organization's folder, with a uuid name", async () => {
      for (const user of [manager, member, outsider]) expect((await pgError(put(user, `${org}/${randomUUID()}`))).code).toBe("42501");
      expect((await pgError(put(owner, `${otherOrg}/${randomUUID()}`))).code).toBe("42501");
      expect((await pgError(put(owner, `${org}/logo.png`))).code).toBe("42501");
      expect((await pgError(put(owner, `${org}/${randomUUID()}/x`))).code).toBe("42501");
      expect((await pgError(put(owner, `${org}/../${otherOrg}/${randomUUID()}`))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q("insert into storage.objects (bucket_id, name) values ('org-logos', $1)", [`${org}/${randomUUID()}`])))).code).toBe("42501");
      const name = `${org}/${randomUUID()}`;
      await put(admin, name);
      // members list their own organization's logos; others do not (the public address needs no listing)
      expect(await see(member, name)).toBe(1);
      expect(await see(outsider, name)).toBe(0);
    });

    it("objects are never overwritten, and only owners and admins delete them", async () => {
      const name = `${org}/${randomUUID()}`;
      await put(owner, name);
      await asUser(owner.id, async (q) => expect((await q("update storage.objects set owner = $2 where name = $1", [name, owner.id])).rowCount).toBe(0));
      for (const user of [member, manager, outsider]) {
        await asUser(user.id, async (q) => expect((await q("delete from storage.objects where name = $1", [name])).rowCount).toBe(0));
      }
      await asUser(admin.id, async (q) => expect((await q("delete from storage.objects where name = $1", [name])).rowCount).toBe(1));
    });

    it("logo_path must be an uploaded logo of this organization", async () => {
      const mine = `${org}/${randomUUID()}`;
      const theirs = `${otherOrg}/${randomUUID()}`;
      await put(outsider, theirs);
      expect((await pgError(update(owner, "logo_path = $2", [theirs]))).hint).toBe("branding:logo");
      expect((await pgError(update(owner, "logo_path = $2", [mine]))).hint).toBe("branding:logo");
      expect((await pgError(update(owner, "logo_path = 'https://example.test/x.png'"))).hint).toBe("branding:logo");
      await put(owner, mine);
      expect(await update(member, "logo_path = $2", [mine])).toBe(0);
      expect(await update(admin, "logo_path = $2", [mine])).toBe(1);
      expect((await row()).logo_path).toBe(mine);
      // other columns of the organization still save while the logo stays
      expect(await update(owner, "name = 'עסק ממותג'")).toBe(1);
      expect(await update(owner, "logo_path = null")).toBe(1);
    });

    it("an admin of two businesses cannot point one business's logo at the other's folder", async () => {
      // admin of org also becomes admin of otherOrg, through a normal invitation
      const adminEmail = await asAdmin(async (q) => (await q<{ email: string }>("select email from auth.users where id = $1", [admin.id])).rows[0].email);
      const token = await asUser(outsider.id, async (q) =>
        (await q<{ token: string }>("select public.create_invitation($1, $2, 'admin') as token", [otherOrg, adminEmail])).rows[0].token,
      );
      await asUser(admin.id, (q) => q("select public.accept_invitation($1)", [token]));
      const inOther = `${otherOrg}/${randomUUID()}`;
      // the upload itself is allowed: they are an admin there
      await put(admin, inOther);
      expect(await see(admin, inOther)).toBe(1);
      expect((await pgError(update(admin, "logo_path = $2", [inOther]))).hint).toBe("branding:logo");
      // the same object is fine as the other business's own logo
      expect(await update(admin, "logo_path = $2", [inOther], otherOrg)).toBe(1);
      expect(await update(admin, "logo_path = null", [], otherOrg)).toBe(1);
    });
  });

  it("the hosted form gets the logo and the colour, and nothing else of the organization", async () => {
    const logo = `${org}/${randomUUID()}`;
    await put(owner, logo);
    await update(owner, "logo_path = $2, brand_color = '#e91e63'", [logo]);
    const form = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name, title) values ($1, 'מיתוג', 'פנייה') returning token", [org])).rows[0],
    );
    const shown = await asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.intake_form($1) as r", [form.token])).rows[0].r);
    expect(shown.brand).toEqual({ logo, color: "#e91e63" });
    expect(Object.keys(shown).sort()).toEqual(["brand", "built_with", "callback", "channel_choice", "fields", "intro", "locale_choice", "submit_label", "thanks", "title"]);
    await update(owner, "logo_path = null, brand_color = null");
    const plain = await asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.intake_form($1) as r", [form.token])).rows[0].r);
    expect(plain.brand).toEqual({ logo: null, color: null });
    // still closed to clients
    expect((await pgError(asUser(owner.id, (q) => q("select public.intake_form($1)", [form.token])))).code).toBe("42501");
  });

  it("the new helpers are closed to anon", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ fn: string; anon: boolean; auth: boolean }>(
          `select p.oid::regprocedure::text as fn,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname in ('org_logo_org', 'organizations_branding_check') order by p.oid::regprocedure::text collate "C"`,
        )
      ).rows,
    );
    expect(rows).toEqual([
      { fn: "app.org_logo_org(text)", anon: false, auth: true },
      { fn: "app.organizations_branding_check()", anon: false, auth: true },
    ]);
  });
});
