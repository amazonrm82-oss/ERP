import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * LIB-01: the content library. Categories are a seeded managed list (owners/admins write, 50 a business); items are links
 * (https, the QR link rule) or files; members read; owners, admins and managers of a writable business write. A file item's
 * file is a public.files row with library_item_id: the one upload path (waiting mark, storage quota, confirmation), one file
 * per item, reading follows the item, and a removed item or file leaves its object to the orphan cleanup.
 */
describe("content library (LIB-01)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const addLink = (u: U, title = "קטלוג", url = "https://example.com/catalog.pdf", orgId = org) =>
    asUser(u.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title, url) values ($1, 'link', $2, $3) returning id", [orgId, title, url])).id,
    );
  const addFileItem = (u: U, title = "מצגת", orgId = org) =>
    asUser(u.id, async (q) => (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title) values ($1, 'file', $2) returning id", [orgId, title])).id);
  const attach = (u: U, item: string, size = 1000, orgId = org) =>
    asUser(u.id, async (q) =>
      one<{ id: string; storage_path: string; unconfirmed_since: string | null }>(
        q,
        "insert into public.files (organization_id, library_item_id, name, mime_type, size_bytes) values ($1, $2, 'מצגת.pdf', 'application/pdf', $3) returning id, storage_path, unconfirmed_since",
        [orgId, item, size],
      ),
    );
  const putObject = async (u: U, path: string, size: number, mimetype: string) => {
    await asUser(u.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [path]));
    await asAdmin((q) =>
      q("update storage.objects set metadata = jsonb_build_object('size', $2::bigint, 'mimetype', $3::text) where bucket_id = 'record-files' and name = $1", [path, size, mimetype]),
    );
  };

  beforeAll(async () => {
    owner = await createUser("lib-owner");
    org = await createOrg(owner.id, "עסק הספרייה");
    admin = await addMember(org, owner.id, "admin", "lib-admin");
    manager = await addMember(org, owner.id, "manager", "lib-manager");
    member = await addMember(org, owner.id, "member", "lib-member");
    viewer = await addMember(org, owner.id, "viewer", "lib-viewer");
    outsider = await createUser("lib-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("a new business starts with the five default categories; owners and admins manage them, 50 at most", async () => {
    const names = await asUser(member.id, async (q) =>
      (await q<{ name: string }>("select name from public.library_categories where organization_id = $1 order by position", [org])).rows.map((r) => r.name),
    );
    expect(names).toEqual(["קטלוגים", "מחירונים", "מצגות", "סרטונים", "מסמכים כלליים"]);
    for (const u of [owner, admin]) {
      await asUser(u.id, (q) => q("insert into public.library_categories (organization_id, name) values ($1, $2)", [org, `של ${u.email}`]));
    }
    for (const u of [manager, member, viewer, outsider]) {
      expect((await pgError(asUser(u.id, (q) => q("insert into public.library_categories (organization_id, name) values ($1, 'x')", [org])))).code, u.email).toBe("42501");
    }
    const cap = await createUser("lib-cap");
    const capOrg = await createOrg(cap.id);
    await asUser(cap.id, (q) => q("insert into public.library_categories (organization_id, name) select $1, 'קטגוריה ' || g from generate_series(1, 45) g", [capOrg]));
    expect((await pgError(asUser(cap.id, (q) => q("insert into public.library_categories (organization_id, name) values ($1, 'עוד')", [capOrg])))).hint).toBe(
      "library_categories:max",
    );
  });

  it("owners, admins and managers write items; members and viewers read them; outsiders see nothing", async () => {
    const ids: string[] = [];
    for (const u of [owner, admin, manager]) ids.push(await addLink(u, `קישור של ${u.email}`));
    for (const u of [member, viewer, outsider]) expect((await pgError(addLink(u))).code, u.email).toBe("42501");
    for (const u of [member, viewer]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.library_items where id = any($1)", [ids])), u.email).toBe(3);
      expect(await asUser(u.id, async (q) => (await q("update public.library_items set title = 'x' where id = any($1)", [ids])).rowCount), u.email).toBe(0);
      expect(await asUser(u.id, async (q) => (await q("delete from public.library_items where id = any($1)", [ids])).rowCount), u.email).toBe(0);
    }
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.library_items where id = any($1)", [ids]))).toBe(0);
    expect(await asUser(manager.id, async (q) => (await q("update public.library_items set is_active = false where id = $1", [ids[0]])).rowCount)).toBe(1);
    expect(await asUser(manager.id, async (q) => (await q("delete from public.library_items where id = $1", [ids[1]])).rowCount)).toBe(1);
    // a read-only business: nobody writes
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(addLink(owner))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a link is https by the QR link rule; a file item has no url; the kind never changes; the validity window is ordered", async () => {
    for (const url of ["http://example.com", "javascript:alert(1)", "https://user@example.com/", "https://localhost/"]) {
      expect((await pgError(addLink(owner, "x", url))).code, url).toBe("23514");
    }
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.library_items (organization_id, kind, title, url) values ($1, 'file', 'x', 'https://example.com/')", [org])))).code,
    ).toBe("23514");
    const item = await addLink(owner);
    expect((await pgError(asUser(owner.id, (q) => q("update public.library_items set kind = 'file' where id = $1", [item])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("update public.library_items set valid_from = '2026-12-01', valid_until = '2026-11-01' where id = $1", [item])))).code,
    ).toBe("23514");
    await asUser(owner.id, (q) => q("update public.library_items set valid_from = '2026-11-01', valid_until = '2026-11-30' where id = $1", [item]));
  });

  it("a category from another business cannot be named; deleting a category keeps its items", async () => {
    const foreign = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.library_categories where organization_id = $1 limit 1", [otherOrg])).id);
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.library_items (organization_id, kind, title, url, category_id) values ($1, 'link', 'x', 'https://example.com/', $2)", [org, foreign]))))
        .code,
    ).toBe("23503");
    const cat = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.library_categories (organization_id, name) values ($1, 'זמנית') returning id", [org])).id);
    const item = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.library_items (organization_id, kind, title, url, category_id) values ($1, 'link', 'x', 'https://example.com/', $2) returning id", [org, cat])).id,
    );
    await asUser(owner.id, (q) => q("delete from public.library_categories where id = $1", [cat]));
    expect(await asAdmin(async (q) => (await one<{ c: string | null }>(q, "select category_id as c from public.library_items where id = $1", [item])).c)).toBeNull();
  });

  it("a file item takes one file through the upload path; readers follow the item; links and other businesses refused", async () => {
    const item = await addFileItem(manager);
    for (const u of [member, viewer, outsider]) expect((await pgError(attach(u, item))).code, u.email).toBe("42501");
    const link = await addLink(owner);
    expect((await pgError(attach(owner, link))).hint).toBe("library:file_kind");
    // another business's item
    const foreignItem = await addFileItem(outsider, "של אחר", otherOrg);
    expect(["42501", "23503", "P0001"]).toContain((await pgError(attach(owner, foreignItem))).code);
    const file = await attach(manager, item);
    expect(file.unconfirmed_since).not.toBeNull();
    expect(file.storage_path).toBe(`${org}/${file.id}`);
    // another writer's upload may wait beside it (the current file stays until a replacement is confirmed)
    const beside = await attach(admin, item);
    expect(await asUser(admin.id, async (q) => (await q("delete from public.files where id = $1", [beside.id])).rowCount)).toBe(1);
    // never on a note, a version or a field
    expect(
      (
        await pgError(
          asAdmin((q) =>
            q("insert into public.files (organization_id, library_item_id, previous_id, name, mime_type, size_bytes) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)", [
              org,
              item,
              file.id,
            ]),
          ),
        )
      ).code,
    ).toBe("23514");
    // the uploader puts the object and confirms it
    await putObject(manager, file.storage_path, 1200, "application/pdf");
    expect(await asUser(manager.id, async (q) => (await one<{ r: { ok: boolean } }>(q, "select public.confirm_file_upload($1, $2) as r", [org, file.id])).r)).toEqual({ ok: true });
    for (const u of [owner, member, viewer]) expect(await asUser(u.id, (q) => count(q, "select 1 from public.files where id = $1", [file.id])), u.email).toBe(1);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    // the object follows the row (record_files_select)
    expect(await asUser(viewer.id, (q) => count(q, "select 1 from storage.objects where name = $1", [file.storage_path]))).toBe(1);
    // a member or viewer never removes it; another library writer does (replacing), and the object waits for the cleanup
    for (const u of [member, viewer]) expect(await asUser(u.id, async (q) => (await q("delete from public.files where id = $1", [file.id])).rowCount), u.email).toBe(0);
    expect(await asUser(admin.id, async (q) => (await q("delete from public.files where id = $1", [file.id])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [file.storage_path]))).toBe(1);
    // a new file can be added again
    await attach(admin, item);
  });

  // review of LIB-01: the steps of finishLibraryFileAction, as the user: the new row waits beside the current file; only after
  // confirm_file_upload answered ok are the item's confirmed rows made before it removed
  const confirmUpload = (u: U, orgId: string, fileId: string) =>
    asUser(u.id, async (q) => (await one<{ r: { ok: boolean; reason?: string } }>(q, "select public.confirm_file_upload($1, $2) as r", [orgId, fileId])).r);
  const removeEarlier = (u: U, orgId: string, item: string, fileId: string) =>
    asUser(u.id, async (q) =>
      (
        await q(
          `delete from public.files where organization_id = $1 and library_item_id = $2 and unconfirmed_since is null
             and created_at < (select created_at from public.files where id = $3) and id <> $3`,
          [orgId, item, fileId],
        )
      ).rowCount,
    );
  const itemFiles = (orgId: string, item: string) =>
    asAdmin(async (q) =>
      (await q<{ id: string; waiting: boolean }>("select id, unconfirmed_since is not null as waiting from public.files where organization_id = $1 and library_item_id = $2 order by created_at", [orgId, item]))
        .rows,
    );

  it("replacing a file: a refusal keeps the old file; a confirmed replacement leaves exactly one", async () => {
    const qOwner = await createUser("lib-replace");
    const qOrg = await createOrg(qOwner.id);
    const item = await addFileItem(qOwner, "מחירון", qOrg);
    const old = await attach(qOwner, item, 4_000, qOrg);
    await putObject(qOwner, old.storage_path, 4_000, "application/pdf");
    expect(await confirmUpload(qOwner, qOrg, old.id)).toEqual({ ok: true });
    // the plan's storage is nearly full: the new row passes (its stated size fits), the real object does not
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"storage_gb\": 0.00001}' where organization_id = $1", [qOrg]));
    const refused = await attach(qOwner, item, 1_000, qOrg);
    await putObject(qOwner, refused.storage_path, 9_000, "application/pdf");
    expect(await confirmUpload(qOwner, qOrg, refused.id)).toEqual({ ok: false, reason: "quota" });
    // the action then drops the refused row; the old file is untouched
    expect(await asUser(qOwner.id, async (q) => (await q("delete from public.files where id = $1", [refused.id])).rowCount)).toBe(1);
    expect(await itemFiles(qOrg, item)).toEqual([{ id: old.id, waiting: false }]);
    // an insert the quota refuses outright leaves it too
    expect((await pgError(attach(qOwner, item, 9_000, qOrg))).hint).toBe("limit:storage_gb");
    expect(await itemFiles(qOrg, item)).toEqual([{ id: old.id, waiting: false }]);
    // a confirmed replacement: the earlier file goes, the new one stays
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [qOrg]));
    const next = await attach(qOwner, item, 2_000, qOrg);
    await putObject(qOwner, next.storage_path, 2_000, "application/pdf");
    expect(await itemFiles(qOrg, item)).toEqual([
      { id: old.id, waiting: false },
      { id: next.id, waiting: true },
    ]);
    expect(await confirmUpload(qOwner, qOrg, next.id)).toEqual({ ok: true });
    expect(await removeEarlier(qOwner, qOrg, item, next.id)).toBe(1);
    expect(await itemFiles(qOrg, item)).toEqual([{ id: next.id, waiting: false }]);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [old.storage_path]))).toBe(1);
  });

  it("a demoted uploader cannot remove a library file's object", async () => {
    const qOwner = await createUser("lib-demote");
    const qOrg = await createOrg(qOwner.id);
    const writer = await addMember(qOrg, qOwner.id, "manager", "lib-demote-manager");
    const item = await addFileItem(writer, "קטלוג", qOrg);
    const file = await attach(writer, item, 1_000, qOrg);
    await putObject(writer, file.storage_path, 1_000, "application/pdf");
    expect(await confirmUpload(writer, qOrg, file.id)).toEqual({ ok: true });
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [qOrg, writer.id]));
    expect(await asUser(writer.id, async (q) => (await q("delete from storage.objects where name = $1", [file.storage_path])).rowCount)).toBe(0);
    expect(await asUser(writer.id, async (q) => (await q("delete from public.files where id = $1", [file.id])).rowCount)).toBe(0);
    // a library writer still removes it (replacing)
    expect(await asUser(qOwner.id, async (q) => (await q("delete from storage.objects where name = $1", [file.storage_path])).rowCount)).toBe(1);
  });

  it("deleting a file item deletes its file row and queues its object", async () => {
    const item = await addFileItem(owner, "למחיקה");
    const file = await attach(owner, item);
    await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [file.id]));
    expect(await asUser(manager.id, async (q) => (await q("delete from public.library_items where id = $1", [item])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [file.storage_path]))).toBe(1);
  });

  it("library files count against the plan's storage, and only a library writer learns the quota", async () => {
    const qOwner = await createUser("lib-quota");
    const qOrg = await createOrg(qOwner.id);
    const qMember = await addMember(qOrg, qOwner.id, "member", "lib-quota-member");
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"storage_gb\": 0.00001}' where organization_id = $1", [qOrg]));
    const first = await addFileItem(qOwner, "ראשון", qOrg);
    await attach(qOwner, first, 9_000, qOrg);
    const second = await addFileItem(qOwner, "שני", qOrg);
    expect((await pgError(attach(qOwner, second, 3_000, qOrg))).hint).toBe("limit:storage_gb");
    // RVW-23: a member who may not write the library gets RLS's plain refusal, never the quota
    const refused = await pgError(attach(qMember, second, 3_000, qOrg));
    expect(refused.code).toBe("42501");
    expect(refused.hint ?? null).toBeNull();
  });

  it("items are capped at 1,000 a business", async () => {
    const cap = await createUser("lib-icap");
    const capOrg = await createOrg(cap.id);
    await asAdmin((q) =>
      q("insert into public.library_items (organization_id, kind, title, url) select $1, 'link', 'פריט ' || g, 'https://example.com/' from generate_series(1, 1000) g", [capOrg]),
    );
    expect((await pgError(addLink(cap, "עוד", "https://example.com/", capOrg))).hint).toBe("library_items:max");
  });
});
