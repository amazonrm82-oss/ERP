import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// REC-07: a file attached to a timeline entry follows the entry; versions of a file stay one line.
describe("files on notes, and versions of a file (REC-07)", () => {
  let owner: U, member: U, member2: U;
  let org: string, lead: string, otherLead: string;

  const note = (user: U, leadId: string, body = "הערה", isPrivate = false, type = "note") =>
    asUser(user.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, $2, $3, $4, $5) returning id", [org, type, body, leadId, isPrivate])).rows[0].id,
    );
  const addFile = (user: U, leadId: string, link: { activity?: string | null; previous?: string | null } = {}, name = "הצעה.pdf") =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string; storage_path: string }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, activity_id, previous_id) values ($1, $2, $3, 'application/pdf', 1000, $4, $5) returning id, storage_path",
          [org, leadId, name, link.activity ?? null, link.previous ?? null],
        )
      ).rows[0],
    );
  const seesFile = (user: U, id: string) => asUser(user.id, (q) => count(q, "select 1 from public.files where id = $1", [id]));
  const seesObject = (user: U, path: string) =>
    asUser(user.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'record-files' and name = $1", [path]));
  const previousOf = (id: string) => asAdmin(async (q) => (await q<{ p: string | null }>("select previous_id as p from public.files where id = $1", [id])).rows[0]?.p);

  beforeAll(async () => {
    owner = await createUser("rec07-owner");
    org = await createOrg(owner.id, "עסק קבצים בהערות");
    member = await addMember(org, owner.id, "member", "rec07-member");
    member2 = await addMember(org, owner.id, "member", "rec07-member2");
    lead = await insertLead(member.id, org, { owner_id: member.id });
    otherLead = await insertLead(member.id, org, { owner_id: member.id });
  });

  it("the author attaches files to a note; whoever sees the note sees them, and a private note keeps its files", async () => {
    const open = await note(member, lead);
    const shared = await addFile(member, lead, { activity: open });
    await asUser(member.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [shared.storage_path]));
    expect(await seesFile(member2, shared.id)).toBe(1);
    expect(await seesObject(member2, shared.storage_path)).toBe(1);

    const secret = await note(member, lead, "לעצמי", true);
    const hidden = await addFile(member, lead, { activity: secret });
    await asUser(member.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [hidden.storage_path]));
    // the colleague reads the record, not the private note: neither the row nor the object
    expect(await seesFile(member2, hidden.id)).toBe(0);
    expect(await seesObject(member2, hidden.storage_path)).toBe(0);
    // the author and the owner do
    expect(await seesFile(member, hidden.id)).toBe(1);
    expect(await seesFile(owner, hidden.id)).toBe(1);
    expect(await seesObject(owner, hidden.storage_path)).toBe(1);
  });

  it("only the entry's author attaches, to an entry a person logged, on the same record", async () => {
    const mine = await note(member, lead);
    expect((await pgError(addFile(member2, lead, { activity: mine }))).hint).toBe("file:note");
    expect((await pgError(addFile(member, otherLead, { activity: mine }))).hint).toBe("file:note");
    const system = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'system', 'מערכת', $2, $3) returning id", [org, lead, member.id])).rows[0].id,
    );
    expect((await pgError(addFile(member, lead, { activity: system }))).hint).toBe("file:note");
    // another person's private note is not even visible: RLS refuses before the check speaks
    const secret = await note(member, lead, "פרטי", true);
    expect((await pgError(addFile(member2, lead, { activity: secret }))).code).toMatch(/^(42501|P0001)$/);
  });

  it("a new version replaces the current one once; it stays on the same record and note", async () => {
    const v1 = await addFile(member, lead, {}, "חוזה.pdf");
    const v2 = await addFile(member2, lead, { previous: v1.id }, "חוזה 2.pdf");
    expect(await previousOf(v2.id)).toBe(v1.id);
    // the earlier version already has a newer one
    expect((await pgError(addFile(member, lead, { previous: v1.id }))).hint).toBe("file:version_taken");
    // another record, or a note the earlier version is not on
    expect((await pgError(addFile(member, otherLead, { previous: v2.id }))).hint).toBe("file:version");
    const onNote = await note(member, lead);
    expect((await pgError(addFile(member, lead, { previous: v2.id, activity: onNote }))).hint).toBe("file:version");
    // a version of a file on a note stays on the note
    const attached = await addFile(member, lead, { activity: onNote });
    const attached2 = await addFile(member, lead, { activity: onNote, previous: attached.id });
    expect(await previousOf(attached2.id)).toBe(attached.id);
  });

  it("deleting a version keeps the history one line; deleting the note removes its files and queues their objects", async () => {
    const v1 = await addFile(member, lead, {}, "מפרט.pdf");
    const v2 = await addFile(member, lead, { previous: v1.id }, "מפרט 2.pdf");
    const v3 = await addFile(member, lead, { previous: v2.id }, "מפרט 3.pdf");
    expect(await asUser(member.id, async (q) => (await q("delete from public.files where id = $1", [v2.id])).rowCount)).toBe(1);
    expect(await previousOf(v3.id)).toBe(v1.id);

    const entry = await note(member, lead);
    const onEntry = await addFile(member, lead, { activity: entry });
    await asUser(member.id, (q) => q("delete from public.activities where id = $1", [entry]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [onEntry.id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [onEntry.storage_path]))).toBe(1);
  });

  it("one statement may delete several versions: a note with versions, a list of ids, the whole line, a purged record, a business", async () => {
    // a note holding a file and its newer version
    const entry = await note(member, lead);
    const n1 = await addFile(member, lead, { activity: entry });
    await addFile(member, lead, { activity: entry, previous: n1.id });
    await asUser(member.id, (q) => q("delete from public.activities where id = $1", [entry]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where activity_id = $1", [entry]))).toBe(0);

    // two versions in one statement: the one after them follows the nearest kept one
    const v0 = await addFile(member, lead, {}, "תכנית.pdf");
    const v1 = await addFile(member, lead, { previous: v0.id });
    const v2 = await addFile(member, lead, { previous: v1.id });
    const v3 = await addFile(member, lead, { previous: v2.id });
    await asUser(member.id, (q) => q("delete from public.files where id = any($1::uuid[])", [[v1.id, v2.id]]));
    expect(await previousOf(v3.id)).toBe(v0.id);
    // the earliest one and the one after it together: the newest has no earlier version left
    await asUser(member.id, (q) => q("delete from public.files where id = any($1::uuid[])", [[v3.id, v0.id]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = any($1::uuid[])", [[v0.id, v3.id]]))).toBe(0);

    // the whole line at once
    const w1 = await addFile(member, lead, {}, "שורה.pdf");
    const w2 = await addFile(member, lead, { previous: w1.id });
    const w3 = await addFile(member, lead, { previous: w2.id });
    await asUser(member.id, (q) => q("delete from public.files where id = any($1::uuid[])", [[w3.id, w1.id, w2.id]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = any($1::uuid[])", [[w1.id, w2.id, w3.id]]))).toBe(0);

    // a purged record with versions on it
    const doomed = await insertLead(member.id, org, { owner_id: member.id });
    const d1 = await addFile(member, doomed);
    await addFile(member, doomed, { previous: d1.id });
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [doomed]);
      await q("delete from public.leads where id = $1", [doomed]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.files where lead_id = $1", [doomed]))).toBe(0);

    // a business with a version line, on a note and off it
    const boss = await createUser("rec07-gone-owner");
    const gone = await createOrg(boss.id, "עסק שנמחק");
    const goneLead = await insertLead(boss.id, gone, { owner_id: boss.id });
    await asUser(boss.id, async (q) => {
      const a = (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2) returning id", [gone, goneLead])).rows[0].id;
      const ins = async (activity: string | null, previous: string | null) =>
        (await q<{ id: string }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, activity_id, previous_id) values ($1, $2, 'f.pdf', 'application/pdf', 10, $3, $4) returning id",
          [gone, goneLead, activity, previous],
        )).rows[0].id;
      const g1 = await ins(null, null);
      await ins(null, g1);
      const h1 = await ins(a, null);
      await ins(a, h1);
    });
    await asAdmin((q) => q("delete from public.organizations where id = $1", [gone]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where organization_id = $1", [gone]))).toBe(0);
  });

  it("a DELETE with no WHERE reaches no file on a note the deleter cannot see", async () => {
    const secret = await note(member, lead, "רק שלי", true);
    const hidden = await addFile(member, lead, { activity: secret });
    // member2 removes only what they uploaded and see; the owner's bare delete is for the owner (who sees it) only
    await asUser(member2.id, (q) => q("delete from public.files"));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [hidden.id]))).toBe(1);
  });
});
