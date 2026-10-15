import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, count, createUser, pgError } from "./helpers";

afterAll(closePool);

type Orphan = { bucket: string; path: string };

const queued = (path: string) =>
  asAdmin(async (q) => (await q<{ bucket: string }>("select bucket from app.orphan_files where storage_path = $1", [path])).rows[0]?.bucket ?? null);

/** A user with an uploaded photo (and, optionally, more uploads in their folder). */
async function userWithPhoto(label: string, extra = 0) {
  const user = await createUser(label);
  const photo = `${user.id}/${randomUUID()}`;
  const others = Array.from({ length: extra }, () => `${user.id}/${randomUUID()}`);
  await asUser(user.id, async (q) => {
    for (const name of [photo, ...others]) await q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [name]);
    await q("update public.profiles set avatar_url = $1 where id = $2", [photo, user.id]);
  });
  return { user, photo, others };
}

const claimObjects = () =>
  asService(async (q) => (await q<{ r: Orphan[] }>("select public.claim_orphan_objects(1000) as r")).rows[0].r);

// USR-01, owner's decision of 12 October 2026: the photo of a deleted account is
// removed by the nightly file cleanup, through the same queue and route.
describe("profile photos in the nightly file cleanup (USR-01)", () => {
  it("a deleted account queues its photo and the other uploads in its folder, bucket avatars", async () => {
    const { user, photo, others } = await userWithPhoto("avatar-gone", 2);
    expect(await queued(photo)).toBeNull();
    await asAdmin((q) => q("delete from auth.users where id = $1", [user.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.profiles where id = $1", [user.id]))).toBe(0);
    for (const path of [photo, ...others]) expect(await queued(path)).toBe("avatars");
  });

  it("a replaced or removed photo queues the old one; the photo in use is never claimed", async () => {
    const { user, photo } = await userWithPhoto("avatar-swap");
    const next = `${user.id}/${randomUUID()}`;
    await asUser(user.id, async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('avatars', $1)", [next]);
      await q("update public.profiles set avatar_url = $1 where id = $2", [next, user.id]);
    });
    expect(await queued(photo)).toBe("avatars");
    expect(await queued(next)).toBeNull();
    // an unrelated update does not queue the current photo
    await asUser(user.id, (q) => q("update public.profiles set full_name = 'אחר' where id = $1", [user.id]));
    expect(await queued(next)).toBeNull();

    // the photo in use, if it ever sits in the queue, waits
    await asAdmin((q) => q("insert into app.orphan_files (storage_path, bucket) values ($1, 'avatars')", [next]));
    const claimed = await claimObjects();
    expect(claimed).toContainEqual({ bucket: "avatars", path: photo });
    expect(claimed.map((o) => o.path)).not.toContain(next);
    // removed: now it may go
    await asUser(user.id, (q) => q("update public.profiles set avatar_url = null where id = $1", [user.id]));
    expect(await claimObjects()).toContainEqual({ bucket: "avatars", path: next });
    await asService((q) => q("select public.finish_orphan_files($1)", [[photo, next]]));
    expect(await queued(photo)).toBeNull();
    expect(await queued(next)).toBeNull();
  });

  it("a path outside the user's folder is never queued", async () => {
    const user = await createUser("avatar-legacy");
    // a value written before the photo checks existed
    await asAdmin((q) => q("alter table public.profiles disable trigger profiles_check"));
    try {
      await asAdmin((q) => q("update public.profiles set avatar_url = 'https://example.test/me.png' where id = $1", [user.id]));
    } finally {
      await asAdmin((q) => q("alter table public.profiles enable trigger profiles_check"));
    }
    await asAdmin((q) => q("delete from auth.users where id = $1", [user.id]));
    expect(await queued("https://example.test/me.png")).toBeNull();
  });

  it("claim and finish round trip across both buckets; the old claim returns record files only", async () => {
    const file = `org-${randomUUID()}/file`;
    const { user, photo } = await userWithPhoto("avatar-trip");
    await asAdmin((q) => q("insert into app.orphan_files (storage_path) values ($1)", [file]));
    await asAdmin((q) => q("delete from auth.users where id = $1", [user.id]));
    expect(await queued(file)).toBe("record-files");

    // old app code, until the deploy finishes: never an avatar path
    const old = await asService(async (q) => (await q<{ r: string[] }>("select public.claim_orphan_files(1000) as r")).rows[0].r);
    expect(old).toContain(file);
    expect(old).not.toContain(photo);
    await asAdmin((q) => q("update app.orphan_files set claimed_at = null where storage_path = $1", [file]));

    const first = await claimObjects();
    expect(first).toContainEqual({ bucket: "record-files", path: file });
    expect(first).toContainEqual({ bucket: "avatars", path: photo });
    // claimed paths are not offered again right away
    const second = await claimObjects();
    expect(second.map((o) => o.path)).not.toContain(photo);
    // an unfinished claim comes back after an hour
    await asAdmin((q) => q("update app.orphan_files set claimed_at = now() - interval '2 hours' where storage_path = $1", [photo]));
    expect(await claimObjects()).toContainEqual({ bucket: "avatars", path: photo });

    expect(await asService(async (q) => (await q<{ n: number }>("select public.finish_orphan_files($1) as n", [[file, photo]])).rows[0].n)).toBe(2);
    expect(await queued(file)).toBeNull();
    expect(await queued(photo)).toBeNull();
  });

  it("only the known buckets can be queued", async () => {
    const error = await pgError(asAdmin((q) => q("insert into app.orphan_files (storage_path, bucket) values ('x/y', 'other')")));
    expect(error.code).toBe("23514");
  });

  it("no client can claim, and no client reaches the queue or the helpers", async () => {
    const user = await createUser("avatar-client");
    for (const sql of [
      "select public.claim_orphan_objects(10)",
      "select public.claim_orphan_files(10)",
      "select public.finish_orphan_files(array['x'])",
      "select app.orphan_claimable('avatars', 'x')",
      "select count(*) from app.orphan_files",
    ]) {
      expect((await pgError(asUser(user.id, (q) => q(sql)))).code).toBe("42501");
    }
    const privileges = await asAdmin(async (q) =>
      (
        await q<{ fn: string; role: string; ok: boolean }>(
          `select f.fn, r.role, has_function_privilege(r.role, f.fn, 'execute') as ok
             from unnest(array['public.claim_orphan_objects(integer)', 'public.claim_orphan_files(integer)',
                               'app.profiles_avatar_orphans()', 'app.orphan_claimable(text,text)', 'app.cleanup_files()']) f(fn)
            cross join unnest(array['anon', 'authenticated', 'service_role']) r(role)`,
        )
      ).rows,
    );
    const allowed = privileges.filter((p) => p.ok).map((p) => `${p.fn} ${p.role}`);
    expect(allowed.sort()).toEqual(["public.claim_orphan_files(integer) service_role", "public.claim_orphan_objects(integer) service_role"]);
  });
});
