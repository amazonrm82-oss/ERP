import { afterAll, describe, expect, it } from "vitest";
import { asAdmin, asService, asUser, closePool, count, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("cleanup of stored files of deleted rows", () => {
  it("the service role claims a batch once, finishes it, and nobody else can", async () => {
    const paths = ["org-x/file-1", "org-x/file-2", "org-x/file-3"];
    await asAdmin(async (q) => {
      for (const p of paths) await q("insert into app.orphan_files (storage_path) values ($1) on conflict do nothing", [p]);
    });
    const user = await createUser("cleanup-user");
    for (const sql of ["select public.claim_orphan_files(10)", "select public.finish_orphan_files(array['x'])"]) {
      expect((await pgError(asUser(user.id, (q) => q(sql)))).code).toBe("42501");
    }

    const first = await asService(async (q) => (await q<{ r: string[] }>("select public.claim_orphan_files(1000) as r")).rows[0].r);
    expect(first).toEqual(expect.arrayContaining(paths));
    // claimed paths are not offered again right away
    const second = await asService(async (q) => (await q<{ r: string[] }>("select public.claim_orphan_files(1000) as r")).rows[0].r);
    expect(second.filter((p) => paths.includes(p))).toEqual([]);

    await asService((q) => q("select public.finish_orphan_files($1)", [paths.slice(0, 2)]));
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = any($1)", [paths]))).toBe(1);
    // an unfinished claim comes back after an hour
    await asAdmin((q) => q("update app.orphan_files set claimed_at = now() - interval '2 hours' where storage_path = $1", [paths[2]]));
    const again = await asService(async (q) => (await q<{ r: string[] }>("select public.claim_orphan_files(1000) as r")).rows[0].r);
    expect(again).toContain(paths[2]);
  });
});
