import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isWorkingHours } from "../../src/features/profile/working-hours";
import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// USR-01: the personal profile. A user edits only their own row and only the
// personal columns; the shapes are checked in the database too.
describe("personal profile (USR-01)", () => {
  let owner: U, colleague: U, outsider: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("usr-owner");
    org = await createOrg(owner.id);
    colleague = await addMember(org, owner.id, "member", "usr-colleague");
    outsider = await createUser("usr-outsider");
    await createOrg(outsider.id, "עסק אחר");
  });

  const update = (user: U, target: U, set: string, params: unknown[] = []) =>
    asUser(user.id, async (q) => (await q(`update public.profiles set ${set} where id = $1`, [target.id, ...params])).rowCount);
  const profile = (id: string) =>
    asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.profiles where id = $1", [id])).rows[0]);

  it("a user saves their own personal fields; phone_e164 follows the phone", async () => {
    const hours = { sun: { start: "08:30", end: "16:00" }, thu: { start: "09:00", end: "13:00" } };
    expect(
      await update(owner, owner, "full_name = $2, phone = $3, timezone = $4, working_hours = $5, signature = $6, locale = 'he'", [
        "דנה כהן",
        "050-123-4567",
        "Europe/London",
        JSON.stringify(hours),
        "דנה כהן\nמנהלת מכירות",
      ]),
    ).toBe(1);
    const row = await profile(owner.id);
    expect(row).toMatchObject({ full_name: "דנה כהן", phone: "050-123-4567", phone_e164: "+972501234567", timezone: "Europe/London", working_hours: hours });
    expect(await update(owner, owner, "phone = null")).toBe(1);
    expect((await profile(owner.id)).phone_e164).toBeNull();
  });

  it("nobody edits another user's profile; colleagues read it, outsiders do not", async () => {
    expect(await update(colleague, owner, "signature = 'זיוף'")).toBe(0);
    expect(await update(outsider, owner, "timezone = 'UTC'")).toBe(0);
    await update(owner, owner, "signature = 'חתימה'");
    expect(await asUser(colleague.id, (q) => count(q, "select 1 from public.profiles where id = $1 and signature = 'חתימה'", [owner.id]))).toBe(1);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.profiles where id = $1", [owner.id]))).toBe(0);
  });

  it("phone_e164, email and id are not the client's to write", async () => {
    for (const set of ["phone_e164 = '+972500000000'", "email = 'x@example.test'", "created_at = now()"]) {
      expect((await pgError(update(owner, owner, set))).code).toBe("42501");
    }
    const grants = await asAdmin(async (q) =>
      (
        await q<{ column_name: string }>(
          `select column_name from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated' and privilege_type = 'UPDATE'
            order by 1`,
        )
      ).rows.map((r) => r.column_name),
    );
    expect(grants).toEqual(["avatar_url", "full_name", "locale", "phone", "signature", "timezone", "working_hours"]);
  });

  it("working hours must have the exact shape", async () => {
    const bad = [
      [],
      { sunday: { start: "09:00", end: "17:00" } },
      { sun: { start: "9:00", end: "17:00" } },
      { sun: { start: "17:00", end: "09:00" } },
      { sun: { start: "09:00", end: "09:00" } },
      { sun: { start: "09:00", end: "24:00" } },
      { sun: { start: "09:00" } },
      { sun: { start: "09:00", end: "17:00", note: "x" } },
      { sun: [] },
      { sun: { start: 900, end: 1700 } },
      "09:00-17:00",
    ];
    for (const value of bad) {
      expect((await pgError(update(owner, owner, "working_hours = $2", [JSON.stringify(value)]))).code).toBe("23514");
    }
    expect(await update(owner, owner, "working_hours = '{}'")).toBe(1);
    expect(await update(owner, owner, "working_hours = null")).toBe(1);
  });

  it("app and database agree on the working hours shape", async () => {
    const samples: unknown[] = [
      {},
      { sat: { start: "00:00", end: "23:59" } },
      { sun: { start: "09:00", end: "17:00" }, mon: { start: "10:00", end: "12:00" } },
      { sun: { start: "17:00", end: "09:00" } },
      { xyz: { start: "09:00", end: "17:00" } },
      { sun: { start: "09:00", end: "17:00", x: 1 } },
      { sun: { start: "25:00", end: "26:00" } },
      { sun: null },
      [],
      "x",
      1,
    ];
    for (const sample of samples) {
      const db = await asAdmin(async (q) => (await q<{ v: boolean }>("select app.working_hours_ok($1::jsonb) as v", [JSON.stringify(sample)])).rows[0].v);
      expect(isWorkingHours(sample), JSON.stringify(sample)).toBe(db);
    }
  });

  it("signature up to 500 characters, a known time zone, Hebrew or English, a short name", async () => {
    expect(await update(owner, owner, "signature = $2", ["א".repeat(500)])).toBe(1);
    expect((await pgError(update(owner, owner, "signature = $2", ["א".repeat(501)]))).code).toBe("23514");
    expect((await pgError(update(owner, owner, "timezone = 'not a zone'"))).hint).toBe("profile:timezone");
    expect((await pgError(update(owner, owner, "timezone = 'Asia/Atlantis'"))).hint).toBe("profile:timezone");
    expect(await update(owner, owner, "timezone = 'Asia/Jerusalem'")).toBe(1);
    expect(await update(owner, owner, "timezone = null")).toBe(1);
    expect((await pgError(update(owner, owner, "locale = 'fr'"))).hint).toBe("profile:locale");
    expect(await update(owner, owner, "locale = 'en'")).toBe(1);
    expect(await update(owner, owner, "locale = 'he'")).toBe(1);
    expect((await pgError(update(owner, owner, "full_name = $2", ["א".repeat(121)]))).hint).toBe("profile:full_name");
    expect((await pgError(update(owner, owner, "phone = $2", ["1".repeat(41)]))).hint).toBe("profile:phone");
  });

  describe("photo (bucket avatars)", () => {
    const put = (user: U, name: string) => asUser(user.id, (q) => q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [name]));
    const see = (user: U, name: string) => asUser(user.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'avatars' and name = $1", [name]));

    it("the bucket is private and limited to 2 MB", async () => {
      const bucket = await asAdmin(async (q) => (await q<{ public: boolean; file_size_limit: string }>("select public, file_size_limit from storage.buckets where id = 'avatars'")).rows[0]);
      expect(bucket.public).toBe(false);
      expect(Number(bucket.file_size_limit)).toBe(2 * 1024 * 1024);
    });

    it("a user uploads only into their own folder, with a uuid name", async () => {
      expect((await pgError(put(owner, `${colleague.id}/${randomUUID()}`))).code).toBe("42501");
      expect((await pgError(put(owner, `${owner.id}/photo.png`))).code).toBe("42501");
      expect((await pgError(put(owner, `${owner.id}/${randomUUID()}/x`))).code).toBe("42501");
      expect((await pgError(put(owner, `${owner.id}/../${colleague.id}/${randomUUID()}`))).code).toBe("42501");
      const name = `${owner.id}/${randomUUID()}`;
      await put(owner, name);
      expect(await see(owner, name)).toBe(1);
      expect(await see(colleague, name)).toBe(1);
      expect(await see(outsider, name)).toBe(0);
    });

    it("an organization that requires two-step verification hides colleagues' photos from a password-only session", async () => {
      const name = `${owner.id}/${randomUUID()}`;
      await put(owner, name);
      await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
      try {
        expect(await see(colleague, name)).toBe(0);
        expect(await asMfaUser(colleague.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'avatars' and name = $1", [name]))).toBe(1);
        // the user's own photo stays readable, as their own profile row does
        expect(await asMfaUser(owner.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'avatars' and name = $1", [name]))).toBe(1);
        expect(await see(owner, name)).toBe(1);
      } finally {
        await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
      }
    });

    it("avatar_url must be the user's own uploaded photo", async () => {
      const mine = `${owner.id}/${randomUUID()}`;
      const theirs = `${colleague.id}/${randomUUID()}`;
      await put(colleague, theirs);
      expect((await pgError(update(owner, owner, "avatar_url = $2", [theirs]))).hint).toBe("profile:avatar");
      expect((await pgError(update(owner, owner, "avatar_url = $2", [mine]))).hint).toBe("profile:avatar");
      expect((await pgError(update(owner, owner, "avatar_url = 'https://example.test/x.png'"))).hint).toBe("profile:avatar");
      await put(owner, mine);
      expect(await update(owner, owner, "avatar_url = $2", [mine])).toBe(1);
      expect(await update(owner, owner, "avatar_url = null")).toBe(1);
    });

    it("objects are never overwritten, and only their user deletes them", async () => {
      const name = `${owner.id}/${randomUUID()}`;
      await put(owner, name);
      await asUser(owner.id, async (q) => expect((await q("update storage.objects set owner = $2 where name = $1", [name, owner.id])).rowCount).toBe(0));
      await asUser(colleague.id, async (q) => expect((await q("delete from storage.objects where name = $1", [name])).rowCount).toBe(0));
      await asUser(owner.id, async (q) => expect((await q("delete from storage.objects where name = $1", [name])).rowCount).toBe(1));
    });
  });
});
