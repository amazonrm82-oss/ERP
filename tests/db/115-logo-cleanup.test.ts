import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

type Orphan = { bucket: string; path: string };
type U = { id: string };

const queued = (path: string) =>
  asAdmin(async (q) => (await q<{ bucket: string }>("select bucket from app.orphan_files where storage_path = $1", [path])).rows[0]?.bucket ?? null);
const claimObjects = () => asService(async (q) => (await q<{ r: Orphan[] }>("select public.claim_orphan_objects(1000) as r")).rows[0].r);

// FLD-04 follow-up (owner, 14 October 2026; migration logo_cleanup): business logos no longer in use go through the
// nightly file cleanup, like profile photos: queued when replaced, cleared or when the organization is deleted, never
// claimed while some organization still shows them.
describe("business logos in the nightly file cleanup (FLD-04)", () => {
  let owner: U, other: U;
  let org: string, otherOrg: string;
  // every business this file makes: its queue rows and storage objects are removed at the end
  const orgs: string[] = [];
  const track = (o: string) => (orgs.push(o), o);

  afterAll(async () => {
    const prefixes = orgs.map((o) => `${o}/%`);
    await asAdmin(async (q) => {
      await q("delete from app.orphan_files where storage_path like any($1)", [prefixes]);
      await q("delete from storage.objects where name like any($1)", [prefixes]);
    });
    const left = await asAdmin(async (q) =>
      Number((await q<{ n: string }>("select count(*) as n from app.orphan_files where storage_path like any($1)", [prefixes])).rows[0].n),
    );
    expect(left).toBe(0);
    await closePool();
  });

  const upload = (user: U, o: string, name = `${o}/${randomUUID()}`) =>
    asUser(user.id, async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('org-logos', $1)", [name]);
      return name;
    });
  const setLogo = (user: U, o: string, path: string | null) =>
    asUser(user.id, (q) => q("update public.organizations set logo_path = $2 where id = $1 returning id", [o, path]));

  beforeAll(async () => {
    owner = await createUser("logo-owner");
    org = track(await createOrg(owner.id, "עסק עם לוגו"));
    other = await createUser("logo-other");
    otherOrg = track(await createOrg(other.id, "עסק אחר"));
  });

  it("a replaced logo is queued; the new one is not; an unrelated update queues nothing", async () => {
    const first = await upload(owner, org);
    await setLogo(owner, org, first);
    expect(await queued(first)).toBeNull();
    const second = await upload(owner, org);
    await setLogo(owner, org, second);
    expect(await queued(first)).toBe("org-logos");
    expect(await queued(second)).toBeNull();
    // the same logo again, or another column, changes nothing
    await setLogo(owner, org, second);
    await asUser(owner.id, (q) => q("update public.organizations set brand_color = '#123456' where id = $1", [org]));
    expect(await queued(second)).toBeNull();
  });

  it("a cleared logo is queued", async () => {
    const logo = await upload(owner, org);
    await setLogo(owner, org, logo);
    await setLogo(owner, org, null);
    expect(await queued(logo)).toBe("org-logos");
  });

  it("a logo in use is never claimed; once it is no longer used it goes", async () => {
    const logo = await upload(owner, org);
    await setLogo(owner, org, logo);
    // in the queue while still in use (set again after a clear, or put there by hand): it waits
    await asAdmin((q) => q("insert into app.orphan_files (storage_path, bucket) values ($1, 'org-logos') on conflict do nothing", [logo]));
    expect((await claimObjects()).map((o) => o.path)).not.toContain(logo);
    await setLogo(owner, org, null);
    const claimed = await claimObjects();
    expect(claimed).toContainEqual({ bucket: "org-logos", path: logo });
    await asService((q) => q("select public.finish_orphan_files($1)", [claimed.map((o) => o.path)]));
    expect(await queued(logo)).toBeNull();
  });

  /** A record file of `o` with its object in 'record-files'; returns the file id and path. */
  const recordFile = async (user: U, o: string) => {
    const lead = await insertLead(user.id, o, { full_name: "ליד עם קובץ" });
    return asUser(user.id, async (q) => {
      const file = (await q<{ id: string; storage_path: string }>(
        "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'חוזה.pdf', 'application/pdf', 10) returning id, storage_path",
        [o, lead],
      )).rows[0];
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path]);
      return { id: file.id, path: file.storage_path };
    });
  };
  const deleteFile = (id: string) => asAdmin((q) => q("delete from public.files where id = $1", [id]));

  it("a logo named after a record file is never queued, so the file's own cleanup still runs", async () => {
    // clear the logo while the file exists: nothing queued as a logo
    const file = await recordFile(owner, org);
    const logo = await upload(owner, org, file.path);
    await setLogo(owner, org, logo);
    await setLogo(owner, org, null);
    expect(await queued(file.path)).toBeNull();
    // the file is deleted later: its object is queued from 'record-files' and claimed from there
    await deleteFile(file.id);
    expect(await queued(file.path)).toBe("record-files");
    expect(await claimObjects()).toContainEqual({ bucket: "record-files", path: file.path });
    await asService((q) => q("select public.finish_orphan_files($1)", [[file.path]]));

    // the other order: the file is deleted (queued) first, then the logo is replaced; the queue row keeps its bucket
    const second = await recordFile(owner, org);
    await upload(owner, org, second.path);
    await setLogo(owner, org, second.path);
    await deleteFile(second.id);
    expect(await queued(second.path)).toBe("record-files");
    await setLogo(owner, org, null);
    expect(await queued(second.path)).toBe("record-files");

    // a record file's object that is still in storage with no row and no queue row (e.g. finished by hand) also blocks it
    const third = await recordFile(owner, org);
    await upload(owner, org, third.path);
    await setLogo(owner, org, third.path);
    await deleteFile(third.id);
    await asService((q) => q("select public.finish_orphan_files($1)", [[third.path]]));
    await setLogo(owner, org, null);
    expect(await queued(third.path)).toBeNull();
  });

  it("a path of the wrong shape is never claimed from the logo bucket", async () => {
    await asAdmin((q) => q("insert into app.orphan_files (storage_path, bucket) values ('not-a-logo/x', 'org-logos')"));
    expect((await claimObjects()).map((o) => o.path)).not.toContain("not-a-logo/x");
    await asService((q) => q("select public.finish_orphan_files($1)", [["not-a-logo/x"]]));
  });

  it("another organization's logo is not affected", async () => {
    const theirs = await upload(other, otherOrg);
    await setLogo(other, otherOrg, theirs);
    const mine = await upload(owner, org);
    await setLogo(owner, org, mine);
    await setLogo(owner, org, null);
    expect(await queued(theirs)).toBeNull();
    // the other business's logo in use is not claimed even when queued by hand
    await asAdmin((q) => q("insert into app.orphan_files (storage_path, bucket) values ($1, 'org-logos')", [theirs]));
    expect((await claimObjects()).map((o) => o.path)).not.toContain(theirs);
    await asService((q) => q("select public.finish_orphan_files($1)", [[theirs]]));
    // an outsider cannot change the other business's logo at all
    expect((await setLogo(owner, otherOrg, null)).rowCount).toBe(0);
    expect(await queued(theirs)).toBeNull();
  });

  it("a deleted organization queues its logo and the other uploads in its folder (as a deleted profile does)", async () => {
    const boss = await createUser("logo-gone");
    const gone = track(await createOrg(boss.id, "עסק שנסגר"));
    const logo = await upload(boss, gone);
    const spare = await upload(boss, gone);
    // an upload named after one of its record files stays with the file's own cleanup
    const file = await recordFile(boss, gone);
    await upload(boss, gone, file.path);
    await setLogo(boss, gone, logo);
    // another business's logo and spare upload, which the sweep must leave alone
    const theirLogo = await upload(other, otherOrg);
    const theirSpare = await upload(other, otherOrg);
    await setLogo(other, otherOrg, theirLogo);
    const before = await asAdmin(async (q) =>
      (await q<{ p: string }>("select storage_path as p from app.orphan_files where storage_path not like $1", [`${gone}/%`])).rows.map((r) => r.p).sort(),
    );
    await asAdmin((q) => q("delete from public.organizations where id = $1", [gone]));
    expect(await queued(logo)).toBe("org-logos");
    expect(await queued(spare)).toBe("org-logos");
    expect(await queued(file.path)).toBe("record-files");
    expect(await queued(theirLogo)).toBeNull();
    expect(await queued(theirSpare)).toBeNull();
    // nothing outside the deleted business's folder was queued by the sweep
    const after = await asAdmin(async (q) =>
      (await q<{ p: string }>("select storage_path as p from app.orphan_files where storage_path not like $1", [`${gone}/%`])).rows.map((r) => r.p).sort(),
    );
    expect(after).toEqual(before);
  });

  it("no client reaches the queue, the claim or the trigger function", async () => {
    for (const sql of [
      "select count(*) from app.orphan_files",
      "insert into app.orphan_files (storage_path, bucket) values ('x/y', 'org-logos')",
      "select public.claim_orphan_objects(10)",
      "select app.orphan_claimable('org-logos', 'x/y')",
      "select app.organizations_logo_orphans()",
      "select app.org_logo_path_shared('x/y')",
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql)))).code, sql).toBe("42501");
    }
    const privileges = await asAdmin(async (q) =>
      (await q<{ role: string; ok: boolean }>(
        "select r.role, f.fn, has_function_privilege(r.role, f.fn, 'execute') as ok from unnest(array['anon', 'authenticated', 'service_role']) r(role), unnest(array['app.organizations_logo_orphans()', 'app.org_logo_path_shared(text)']) f(fn)",
      )).rows,
    );
    expect(privileges.filter((p) => p.ok)).toEqual([]);
  });
});
