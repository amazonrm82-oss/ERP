import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// REC-05: a note can be edited or deleted by its author for 24 hours, after that only by an
// owner or admin; every such change by a user is written to the audit log.
describe("editing and deleting a note (REC-05)", () => {
  let owner: U, admin: U, manager: U, author: U, colleague: U, stranger: U;
  let org: string, otherOrg: string, lead: string, strangerLead: string;

  beforeAll(async () => {
    owner = await createUser("note-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "note-admin");
    manager = await addMember(org, owner.id, "manager", "note-manager");
    author = await addMember(org, owner.id, "member", "note-author");
    colleague = await addMember(org, owner.id, "member", "note-colleague");
    stranger = await createUser("note-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    // visibility 'org' (the default): everyone in the organization sees the lead and its timeline
    lead = await insertLead(author.id, org);
    strangerLead = await insertLead(stranger.id, otherOrg);
  });

  /** A note the author writes now, through the API. */
  const freshNote = (user: U = author, body = "הערה חדשה", type = "note") =>
    asUser(user.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, $2, $3, $4) returning id", [org, type, body, lead])).rows[0].id,
    );

  /** A note the author wrote `hours` ago (written by the test as the server, which may set created_at). */
  const oldNote = (hours: number, user: U = author, body = "הערה ישנה") =>
    asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, created_by, created_at) values ($1, 'note', $2, $3, $4, now() - make_interval(hours => $5)) returning id",
          [org, body, lead, user.id, hours],
        )
      ).rows[0].id,
    );

  const edit = (user: U, id: string, body = "נערך") => asUser(user.id, async (q) => (await q("update public.activities set body = $1 where id = $2", [body, id])).rowCount);
  const remove = (user: U, id: string) => asUser(user.id, async (q) => (await q("delete from public.activities where id = $1", [id])).rowCount);
  const exists = (id: string) => asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [id]));
  const bodyOf = (id: string) => asAdmin(async (q) => (await q<{ body: string }>("select body from public.activities where id = $1", [id])).rows[0]?.body);

  it("the author edits, pins and deletes their note within 24 hours", async () => {
    const id = await freshNote();
    expect(await edit(author, id, "תוקן")).toBe(1);
    expect(await bodyOf(id)).toBe("תוקן");
    expect(await asUser(author.id, async (q) => (await q("update public.activities set is_pinned = true where id = $1", [id])).rowCount)).toBe(1);
    expect(await remove(author, id)).toBe(1);
    expect(await exists(id)).toBe(0);

    const almost = await oldNote(23);
    expect(await edit(author, almost)).toBe(1);
    expect(await remove(author, almost)).toBe(1);
  });

  it("after 24 hours the author may still pin and unpin it, but not edit or delete it", async () => {
    const id = await oldNote(25);
    const pin = (value: boolean) => asUser(author.id, async (q) => (await q("update public.activities set is_pinned = $1 where id = $2", [value, id])).rowCount);
    expect(await pin(true)).toBe(1);
    expect(await pin(false)).toBe(1);
    for (const change of ["body = 'נערך'", "occurred_at = now()", "metadata = '{\"x\": 1}'::jsonb", "body = 'נערך', is_pinned = true"]) {
      const error = await pgError(asUser(author.id, (q) => q(`update public.activities set ${change} where id = $1`, [id])));
      expect(error.code, change).toBe("42501");
      expect(error.hint, change).toBe("note:edit_window");
    }
    // nothing changed: same text, still unpinned
    expect(await asAdmin(async (q) => (await q("select body, is_pinned from public.activities where id = $1", [id])).rows[0])).toEqual({ body: "הערה ישנה", is_pinned: false });
    // a write that changes nothing is not an edit
    expect(await asUser(author.id, async (q) => (await q("update public.activities set body = body where id = $1", [id])).rowCount)).toBe(1);
    expect(await remove(author, id)).toBe(0);
    expect(await exists(id)).toBe(1);
  });

  it("the 24 hours bind only browser writes: a server-side change to an old note goes through", async () => {
    const id = await oldNote(48);
    await asAdmin((q) => q("update public.activities set body = 'שרת' where id = $1", [id]));
    expect(await bodyOf(id)).toBe("שרת");
  });

  it("owners and admins edit and delete any note at any time", async () => {
    for (const who of [owner, admin]) {
      const id = await oldNote(24 * 30);
      expect(await edit(who, id, "תוקן על ידי מנהל")).toBe(1);
      expect(await bodyOf(id)).toBe("תוקן על ידי מנהל");
      expect(await remove(who, id)).toBe(1);
      expect(await exists(id)).toBe(0);
    }
  });

  it("someone else in the organization who is not an admin cannot touch it, even a fresh one", async () => {
    const id = await freshNote();
    for (const who of [colleague, manager]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.activities where id = $1", [id]))).toBe(1);
      expect(await edit(who, id)).toBe(0);
      expect(await remove(who, id)).toBe(0);
    }
    expect(await bodyOf(id)).toBe("הערה חדשה");
  });

  it("another organization cannot see, edit or delete it, not even its owner", async () => {
    const id = await freshNote();
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.activities where id = $1", [id]))).toBe(0);
    expect(await edit(stranger, id)).toBe(0);
    expect(await remove(stranger, id)).toBe(0);
    expect(await exists(id)).toBe(1);
  });

  it("an update or delete with no WHERE clause reaches only the user's own notes, and edits only fresh ones", async () => {
    const mineFresh = await freshNote(author, "שלי טרי");
    const mineOld = await oldNote(48, author, "שלי ישן");
    const theirs = await freshNote(colleague, "של עמית");
    const strangers = await asUser(stranger.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'של זר', $2) returning id", [otherOrg, strangerLead])).rows[0].id,
    );
    const pinned = (id: string) => asAdmin(async (q) => (await q<{ p: boolean }>("select is_pinned as p from public.activities where id = $1", [id])).rows[0].p);

    // editing every note at once reaches the author's old note too, so the whole statement is refused
    const refused = await pgError(asUser(author.id, (q) => q("update public.activities set body = 'HACKED'")));
    expect(refused.code).toBe("42501");
    for (const [id, body] of [[mineFresh, "שלי טרי"], [mineOld, "שלי ישן"], [theirs, "של עמית"], [strangers, "של זר"]]) {
      expect(await bodyOf(id)).toBe(body);
    }

    // pinning every note at once: only the author's own, fresh and old
    await asUser(author.id, (q) => q("update public.activities set is_pinned = true"));
    expect(await pinned(mineFresh)).toBe(true);
    expect(await pinned(mineOld)).toBe(true);
    expect(await pinned(theirs)).toBe(false);
    expect(await pinned(strangers)).toBe(false);
    await asUser(author.id, (q) => q("update public.activities set is_pinned = false"));

    await asUser(author.id, async (q) => {
      await q("delete from public.activities");
    });
    expect(await exists(mineFresh)).toBe(0);
    expect(await exists(mineOld)).toBe(1);
    expect(await exists(theirs)).toBe(1);
    expect(await exists(strangers)).toBe(1);
  });

  it("someone else's old note: no edit, no pin, no delete, even unscoped", async () => {
    const id = await oldNote(48, author, "ישנה של המחבר");
    expect(await edit(colleague, id)).toBe(0);
    expect(await asUser(colleague.id, async (q) => (await q("update public.activities set is_pinned = true where id = $1", [id])).rowCount)).toBe(0);
    expect(await remove(colleague, id)).toBe(0);
    expect(await bodyOf(id)).toBe("ישנה של המחבר");
  });

  it("a browser cannot choose when its note was written", async () => {
    const id = await asUser(author.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, created_at) values ($1, 'note', 'מהעתיד', $2, now() + interval '1 year') returning id",
          [org, lead],
        )
      ).rows[0].id,
    );
    const created = await asAdmin(async (q) => (await q<{ ok: boolean }>("select created_at between now() - interval '1 minute' and now() + interval '1 minute' as ok from public.activities where id = $1", [id])).rows[0].ok);
    expect(created).toBe(true);
    // and cannot move it later either (touch_row keeps it; the column is not granted)
    await asUser(author.id, async (q) => {
      await q("update public.activities set body = body where id = $1", [id]).catch(() => undefined);
    });
    expect(await asAdmin(async (q) => (await q<{ ok: boolean }>("select created_at < now() + interval '1 minute' as ok from public.activities where id = $1", [id])).rows[0].ok)).toBe(true);
  });

  it("system events stay: a member cannot delete one they caused, an admin can", async () => {
    // written by the server in the author's name (a client may log only the six contact types, RVW-11)
    const id = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'status_change', '', $2, $3) returning id",
          [org, lead, author.id],
        )
      ).rows[0].id,
    );
    expect(await remove(author, id)).toBe(0);
    expect(await edit(author, id)).toBe(0);
    expect(await remove(admin, id)).toBe(1);
  });

  it("edits and deletes by users go to the audit log, with the record they belonged to", async () => {
    const id = await freshNote(author, "לפני");
    await edit(author, id, "אחרי");
    // pinning is not an edit of the text
    await asUser(author.id, (q) => q("update public.activities set is_pinned = true where id = $1", [id]));
    // a server-side change (conversion, merge, erasure) is not logged here
    await asAdmin((q) => q("update public.activities set body = 'שרת' where id = $1", [id]));
    await remove(author, id);

    const entries = await asAdmin(
      async (q) =>
        (await q<{ action: string; actor_id: string; changes: Record<string, unknown> }>(
          "select action, actor_id, changes from public.audit_log where entity_type = 'activities' and entity_id = $1 order by id",
          [id],
        )).rows,
    );
    expect(entries.map((e) => [e.action, e.actor_id])).toEqual([
      ["update", author.id],
      ["delete", author.id],
    ]);
    expect(entries[0].changes).toEqual({ body: { old: "לפני", new: "אחרי" }, type: "note", lead_id: lead });
    expect(entries[1].changes).toMatchObject({ body: "שרת", lead_id: lead, type: "note" });
    // admins read it; members do not
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.audit_log where entity_type = 'activities' and entity_id = $1", [id]))).toBe(2);
    expect(await asUser(author.id, (q) => count(q, "select 1 from public.audit_log where entity_type = 'activities' and entity_id = $1", [id]))).toBe(0);
  });

  it("erasing a purged record also erases the logged edits of its notes", async () => {
    const target = await insertLead(author.id, org, { full_name: "שרה פרטית" });
    const note = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'טלפון פרטי 050', $2) returning id", [org, target])).rows[0].id,
    );
    const gone = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'כתובת פרטית', $2) returning id", [org, target])).rows[0].id,
    );
    await edit(author, note, "טלפון פרטי 052");
    await remove(author, gone);
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [target]);
      await q("delete from public.leads where id = $1", [target]);
    });
    // the purge itself (server side) adds no activity entries
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'activities' and entity_id = any ($1)", [[note, gone]]))).toBe(2);
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'leads', $2)", [org, target]));
    const left = await asAdmin(async (q) => (await q<{ t: string }>("select string_agg(changes::text, ' ') as t from public.audit_log where entity_type = 'activities' and entity_id = any ($1)", [[note, gone]])).rows[0].t);
    expect(left).not.toContain("פרטי");
    expect(left).toContain('"erased": true');
  });
});
