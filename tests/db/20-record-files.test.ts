import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

describe("files on records", () => {
  let owner: U, member: U, member2: U, viewer: U, outsider: U;
  let org: string, lead: string, otherLead: string;

  const addFile = (userId: string, leadId: string, size = 1000) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string; storage_path: string; uploaded_by: string }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'הצעה.pdf', 'application/pdf', $3) returning id, storage_path, uploaded_by",
          [org, leadId, size],
        )
      ).rows[0],
    );
  const putObject = (userId: string, path: string) =>
    asUser(userId, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [path]));
  const seeObject = (userId: string, path: string) =>
    asUser(userId, (q) => count(q, "select 1 from storage.objects where bucket_id = 'record-files' and name = $1", [path]));

  beforeAll(async () => {
    owner = await createUser("files-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    member2 = await addMember(org, owner.id, "member");
    viewer = await addMember(org, owner.id, "viewer");
    outsider = await createUser("files-outsider");
    await createOrg(outsider.id);
    lead = await insertLead(member.id, org, { owner_id: member.id });
    otherLead = await insertLead(member2.id, org, { owner_id: member2.id });
  });

  it("the server sets the path and the uploader; the bucket follows the row", async () => {
    const file = await addFile(member.id, lead);
    expect(file.storage_path).toBe(`${org}/${file.id}`);
    expect(file.uploaded_by).toBe(member.id);
    // a path cannot be chosen by the client
    expect((await pgError(asUser(member.id, (q) => q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, storage_path) values ($1, $2, 'x', 'text/plain', 1, 'x')", [org, lead])))).code).toBe("42501");

    // only the uploader puts the object, and only at a path that has a row
    expect((await pgError(putObject(member2.id, file.storage_path))).code).toBe("42501");
    expect((await pgError(putObject(member.id, `${org}/not-a-file`))).code).toBe("42501");
    await putObject(member.id, file.storage_path);

    // whoever sees the record sees the file; nobody else does
    expect(await seeObject(member2.id, file.storage_path)).toBe(1);
    expect(await seeObject(outsider.id, file.storage_path)).toBe(0);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    expect(await seeObject(member2.id, file.storage_path)).toBe(0);
    expect(await seeObject(member.id, file.storage_path)).toBe(1);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
  });

  it("a viewer cannot upload; a member cannot attach to a record they may not see or delete a colleague's file", async () => {
    expect((await pgError(addFile(viewer.id, lead))).code).toBe("42501");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    expect((await pgError(addFile(member.id, otherLead))).code).toBe("42501");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));

    const file = await addFile(member2.id, otherLead);
    await putObject(member2.id, file.storage_path);
    await asUser(member.id, async (q) => {
      expect((await q("delete from storage.objects where name = $1", [file.storage_path])).rowCount).toBe(0);
      expect((await q("delete from public.files where id = $1", [file.id])).rowCount).toBe(0);
    });
    // the owner (admin) can, object first and then the row; the path is queued for cleanup
    await asUser(owner.id, async (q) => {
      expect((await q("delete from storage.objects where name = $1", [file.storage_path])).rowCount).toBe(1);
      expect((await q("delete from public.files where id = $1", [file.id])).rowCount).toBe(1);
    });
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [file.storage_path]))).toBe(1);
  });

  it("25 MB a file, and the plan's storage cap for the organization", async () => {
    expect((await pgError(addFile(member.id, lead, 26214401))).code).toBe("23514");
    // a cap of about 10 KB; 1 KB is already used
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"storage_gb\": 0.00001}' where organization_id = $1", [org]));
    try {
      await addFile(member.id, lead, 5000);
      const err = await pgError(addFile(member.id, lead, 20000));
      expect(err.hint).toBe("limit:storage_gb");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
    }
  });

  it("a purged record takes its files, and leaves their paths for the cleanup", async () => {
    const doomed = await insertLead(member.id, org, { owner_id: member.id });
    const file = await addFile(member.id, doomed);
    await asAdmin(async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [doomed]);
      await q("delete from public.leads where id = $1", [doomed]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [file.storage_path]))).toBe(1);
  });
});
