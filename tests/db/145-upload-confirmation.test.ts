import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

// FXS-07: a file's size and type are what Storage really holds, not what the browser declared.
describe("upload confirmation", () => {
  type U = { id: string };
  type F = { id: string; storage_path: string };
  let owner: U, member: U, member2: U, outsider: U;
  let org: string, outsiderOrg: string, lead: string;

  const addFile = (userId: string, size = 1, type = "application/pdf", orgId = () => org, leadId = () => lead) =>
    asUser(userId, async (q) =>
      (
        await q<F>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'קובץ', $3, $4) returning id, storage_path",
          [orgId(), leadId(), type, size],
        )
      ).rows[0],
    );
  // what the Storage API does: the object row as the user, then the metadata it measured
  const putObject = async (userId: string, path: string, size: number | null, mimetype: string | null) => {
    await asUser(userId, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [path]));
    if (size !== null || mimetype !== null) {
      await asAdmin((q) =>
        q("update storage.objects set metadata = jsonb_strip_nulls(jsonb_build_object('size', $2::bigint, 'mimetype', $3::text)) where bucket_id = 'record-files' and name = $1", [
          path,
          size,
          mimetype,
        ]),
      );
    }
  };
  const confirm = (userId: string, fileId: string, orgId = org) =>
    asUser(userId, async (q) => (await q<{ r: { ok: boolean; reason?: string } }>("select public.confirm_file_upload($1, $2) as r", [orgId, fileId])).rows[0].r);
  const row = (fileId: string) =>
    asAdmin(async (q) =>
      (
        await q<{ size_bytes: string; mime_type: string; unconfirmed_since: Date | null; upload_checked_at: Date | null }>(
          "select size_bytes, mime_type, unconfirmed_since, upload_checked_at from public.files where id = $1",
          [fileId],
        )
      ).rows[0],
    );
  const backdate = (fileId: string, minutes: number) =>
    asAdmin((q) => q("update public.files set unconfirmed_since = now() - make_interval(mins => $2), upload_checked_at = null where id = $1", [fileId, minutes]));
  // the reconciler runs over every business; the other files of this run are left as they were
  const reconcile = () => asAdmin(async (q) => (await q<{ n: number }>("select app.reconcile_pending_files(5000) as n")).rows[0].n);

  beforeAll(async () => {
    owner = await createUser("fxs07-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "fxs07-member");
    member2 = await addMember(org, owner.id, "member", "fxs07-member2");
    outsider = await createUser("fxs07-outsider");
    outsiderOrg = await createOrg(outsider.id);
    lead = await insertLead(member.id, org, { owner_id: member.id });
  });

  it("the bucket itself takes only the allowed types, and no SVG or HTML", async () => {
    const types = await asAdmin(async (q) => (await q<{ t: string[] }>("select allowed_mime_types as t from storage.buckets where id = 'record-files'")).rows[0].t);
    expect(types).toEqual(await asAdmin(async (q) => (await q<{ t: string[] }>("select app.file_allowed_types() as t")).rows[0].t));
    expect(types).toContain("application/pdf");
    expect(types).not.toContain("image/svg+xml");
    expect(types).not.toContain("text/html");
  });

  it("a person's row waits; a server row and the client cannot set the mark", async () => {
    const file = await addFile(member.id);
    expect((await row(file.id)).unconfirmed_since).not.toBeNull();
    const server = await asAdmin(async (q) =>
      (
        await q<{ id: string; unconfirmed_since: Date | null }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'x', 'text/plain', 1) returning id, unconfirmed_since",
          [org, lead],
        )
      ).rows[0],
    );
    expect(server.unconfirmed_since).toBeNull();
    // no client grant on either column
    for (const col of ["unconfirmed_since", "upload_checked_at"]) {
      expect(
        (await pgError(asUser(member.id, (q) => q(`insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, ${col}) values ($1, $2, 'x', 'text/plain', 1, null)`, [org, lead])))).code,
      ).toBe("42501");
      expect((await pgError(asUser(member.id, (q) => q(`update public.files set ${col} = null where id = $1`, [file.id])))).code).toBe("42501");
    }
  });

  it("confirming corrects a declared size and type to what was stored", async () => {
    const file = await addFile(member.id, 1, "application/pdf");
    await putObject(member.id, file.storage_path, 300_000, "image/png");
    // only the uploader confirms
    expect((await pgError(confirm(member2.id, file.id))).code).toBe("42501");
    expect((await pgError(confirm(owner.id, file.id))).code).toBe("42501");
    expect((await pgError(confirm(outsider.id, file.id))).code).toBe("42501");
    expect((await pgError(confirm(outsider.id, file.id, outsiderOrg))).code).toBe("42501");
    expect(await confirm(member.id, file.id)).toEqual({ ok: true });
    const after = await row(file.id);
    expect(after.size_bytes).toBe("300000");
    expect(after.mime_type).toBe("image/png");
    expect(after.unconfirmed_since).toBeNull();
    // again: nothing to do
    expect(await confirm(member.id, file.id)).toEqual({ ok: true });
  });

  it("a type parameter is ignored; an object with no metadata, an empty one or one of another type is refused", async () => {
    const text = await addFile(member.id, 10, "text/plain");
    await putObject(member.id, text.storage_path, 10, "Text/Plain; charset=UTF-8");
    expect(await confirm(member.id, text.id)).toEqual({ ok: true });
    expect((await row(text.id)).mime_type).toBe("text/plain");

    const absent = await addFile(member.id);
    expect(await confirm(member.id, absent.id)).toEqual({ ok: false, reason: "missing" });
    const bare = await addFile(member.id);
    await putObject(member.id, bare.storage_path, null, null);
    expect(await confirm(member.id, bare.id)).toEqual({ ok: false, reason: "missing" });
    const empty = await addFile(member.id);
    await putObject(member.id, empty.storage_path, 0, "application/pdf");
    expect(await confirm(member.id, empty.id)).toEqual({ ok: false, reason: "empty" });
    const svg = await addFile(member.id, 100, "image/png");
    await putObject(member.id, svg.storage_path, 100, "image/svg+xml");
    expect(await confirm(member.id, svg.id)).toEqual({ ok: false, reason: "type" });
    expect((await row(svg.id)).unconfirmed_since).not.toBeNull();
    expect((await row(svg.id)).mime_type).toBe("image/png");
    const huge = await addFile(member.id);
    await putObject(member.id, huge.storage_path, 26214401, "application/pdf");
    expect(await confirm(member.id, huge.id)).toEqual({ ok: false, reason: "size" });
    // the uploader removes what was refused, object first
    await asUser(member.id, async (q) => {
      for (const f of [absent, bare, empty, svg, huge]) {
        await q("delete from storage.objects where bucket_id = 'record-files' and name = $1", [f.storage_path]);
        expect((await q("delete from public.files where id = $1", [f.id])).rowCount).toBe(1);
      }
    });
  });

  it("the storage cap is checked again with the real size, and a waiting object's real size counts", async () => {
    // a business of its own, with a cap of about 10.7 KB and nothing stored yet
    const qOrg = await createOrg(owner.id);
    const qMember = await addMember(qOrg, owner.id, "member", "fxs07-quota");
    const qLead = await insertLead(qMember.id, qOrg, { owner_id: qMember.id });
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"storage_gb\": 0.00001}' where organization_id = $1", [qOrg]));
    const add = (size: number) => addFile(qMember.id, size, "application/pdf", () => qOrg, () => qLead);

    // declared 1 byte, stored 8,000
    const a = await add(1);
    await putObject(qMember.id, a.storage_path, 8_000, "application/pdf");
    // before the confirmation the next row already counts the real 8,000
    expect((await pgError(add(3_000))).hint).toBe("limit:storage_gb");
    expect(await confirm(qMember.id, a.id, qOrg)).toEqual({ ok: true });

    // declared 1 byte, stored 5,000: over the cap; the row keeps waiting with the real size
    const b = await add(1);
    await putObject(qMember.id, b.storage_path, 5_000, "application/pdf");
    expect(await confirm(qMember.id, b.id, qOrg)).toEqual({ ok: false, reason: "quota" });
    const kept = await row(b.id);
    expect(kept.size_bytes).toBe("5000");
    expect(kept.unconfirmed_since).not.toBeNull();
    expect(await asAdmin(async (q) => Number((await q<{ n: string }>("select app.files_storage_used($1) as n", [qOrg])).rows[0].n))).toBe(8_000 + 5_000);
    await asUser(qMember.id, async (q) => {
      await q("delete from storage.objects where bucket_id = 'record-files' and name = $1", [b.storage_path]);
      expect((await q("delete from public.files where id = $1", [b.id])).rowCount).toBe(1);
    });
    // a smaller real size never lowers a declared one while the row waits
    const c = await add(2_000);
    await putObject(qMember.id, c.storage_path, 10, "application/pdf");
    expect(await asAdmin(async (q) => Number((await q<{ n: string }>("select app.files_storage_used($1) as n", [qOrg])).rows[0].n))).toBe(8_000 + 2_000);
  });

  it("an object is put only while its row waits, so a confirmed file cannot be swapped for a bigger one", async () => {
    const file = await addFile(member.id, 1);
    await putObject(member.id, file.storage_path, 1, "application/pdf");
    expect(await confirm(member.id, file.id)).toEqual({ ok: true });
    await asUser(member.id, (q) => q("delete from storage.objects where bucket_id = 'record-files' and name = $1", [file.storage_path]));
    expect((await pgError(asUser(member.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path])))).code).toBe("42501");
    // a row from before FXS-07 (no mark) takes no new object either
    const old = await asAdmin(async (q) =>
      (
        await q<F>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'x', 'text/plain', 1) returning id, storage_path",
          [org, lead],
        )
      ).rows[0],
    );
    await asAdmin((q) => q("update public.files set uploaded_by = $2 where id = $1", [old.id, member.id]));
    expect((await pgError(asUser(member.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [old.storage_path])))).code).toBe("42501");
    // another person's waiting row: still only the uploader
    const waiting = await addFile(member.id);
    expect((await pgError(asUser(member2.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [waiting.storage_path])))).code).toBe("42501");
  });

  it("at most 20 rows waiting per person from the last hour", async () => {
    const p = await addMember(org, owner.id, "member", "fxs07-pending");
    const pl = await insertLead(p.id, org, { owner_id: p.id });
    const made: F[] = [];
    for (let i = 0; i < 20; i++) made.push(await addFile(p.id, 1, "application/pdf", () => org, () => pl));
    expect((await pgError(addFile(p.id, 1, "application/pdf", () => org, () => pl))).hint).toBe("file:pending_max");
    // another person is not held back
    await addFile(member2.id, 1, "application/pdf", () => org, () => lead);
    // a confirmed one frees a place, and so does an hour
    await putObject(p.id, made[0].storage_path, 1, "application/pdf");
    expect(await confirm(p.id, made[0].id)).toEqual({ ok: true });
    await addFile(p.id, 1, "application/pdf", () => org, () => pl);
    expect((await pgError(addFile(p.id, 1, "application/pdf", () => org, () => pl))).hint).toBe("file:pending_max");
    await backdate(made[1].id, 61);
    await addFile(p.id, 1, "application/pdf", () => org, () => pl);
  });

  it("the reconciler confirms an upload whose browser never did, and only records the real size of one that fails", async () => {
    const good = await addFile(member.id, 1, "application/pdf");
    await putObject(member.id, good.storage_path, 4_000, "application/zip");
    const bad = await addFile(member.id, 1, "image/png");
    await putObject(member.id, bad.storage_path, 7_000, "text/html");
    const fresh = await addFile(member.id, 1, "application/pdf");
    await putObject(member.id, fresh.storage_path, 2_000, "application/pdf");
    const ancient = await addFile(member.id, 1, "application/pdf");
    await putObject(member.id, ancient.storage_path, 2_000, "application/pdf");
    await backdate(good.id, 11);
    await backdate(bad.id, 11);
    await backdate(ancient.id, 15 * 24 * 60);

    await reconcile();
    const g = await row(good.id);
    expect([g.size_bytes, g.mime_type, g.unconfirmed_since]).toEqual(["4000", "application/zip", null]);
    const b = await row(bad.id);
    expect([b.size_bytes, b.mime_type]).toEqual(["7000", "image/png"]);
    expect(b.unconfirmed_since).not.toBeNull();
    expect(b.upload_checked_at).not.toBeNull();
    // under 10 minutes: the browser may still confirm; over 14 days: given up
    expect((await row(fresh.id)).upload_checked_at).toBeNull();
    expect((await row(ancient.id)).upload_checked_at).toBeNull();

    // a row looked at within the hour is not looked at again; after it, it is
    const before = (await row(bad.id)).upload_checked_at;
    await reconcile();
    expect((await row(bad.id)).upload_checked_at).toEqual(before);
    await asAdmin((q) => q("update public.files set upload_checked_at = now() - interval '61 minutes' where id = $1", [bad.id]));
    await asAdmin((q) => q("update storage.objects set metadata = '{\"size\": 7000, \"mimetype\": \"image/png\"}' where name = $1", [bad.storage_path]));
    await reconcile();
    expect((await row(bad.id)).unconfirmed_since).toBeNull();
    // it deletes nothing
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = any($1)", [[good.id, bad.id, fresh.id, ancient.id]]))).toBe(4);
  });

  it("a row that fails inside the reconciler is skipped, and the other rows of the same run are still confirmed", async () => {
    // a business whose storage cap cannot be read: its check raises inside the reconciler
    const bOrg = await createOrg(owner.id);
    const bMember = await addMember(bOrg, owner.id, "member", "fxs07-broken");
    const bLead = await insertLead(bMember.id, bOrg, { owner_id: bMember.id });
    const broken = await addFile(bMember.id, 1, "application/pdf", () => bOrg, () => bLead);
    await putObject(bMember.id, broken.storage_path, 3_000, "application/pdf");
    const fine = await addFile(member.id, 1, "application/pdf");
    await putObject(member.id, fine.storage_path, 3_000, "application/pdf");
    // the broken row comes first in the run (never looked at, older)
    await backdate(broken.id, 30);
    await backdate(fine.id, 20);
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"storage_gb\": \"broken\"}' where organization_id = $1", [bOrg]));
    try {
      await reconcile();
      const b = await row(broken.id);
      // its changes were rolled back with its own block: still waiting, never marked as looked at
      expect([b.size_bytes, b.upload_checked_at]).toEqual(["1", null]);
      expect(b.unconfirmed_since).not.toBeNull();
      const f = await row(fine.id);
      expect([f.size_bytes, f.unconfirmed_since]).toEqual(["3000", null]);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [bOrg]));
    }
  });

  it("only the server runs the reconciler and the helpers", async () => {
    for (const sql of [
      "select app.reconcile_pending_files()",
      "select app.files_storage_used($1)",
      "select app.record_file_object('x')",
      "select app.files_quota_ok($1, 1)",
    ]) {
      const params = sql.includes("$1") ? [org] : [];
      expect((await pgError(asUser(owner.id, (q) => q(sql, params)))).code).toBe("42501");
    }
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.files where organization_id = $1", [org]))).toBeGreaterThan(0);
  });
});
