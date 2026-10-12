import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// GAP-05: a note can be private, "me and the organization's admins" (default of the additions spec).
// Its author and the owners/admins see it; nobody else does, wherever they look.
describe("private notes (GAP-05)", () => {
  let owner: U, admin: U, manager: U, author: U, colleague: U, viewer: U, stranger: U;
  let org: string, team: string;
  let lead: string, contact: string;

  beforeAll(async () => {
    owner = await createUser("pn-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "pn-admin");
    manager = await addMember(org, owner.id, "manager", "pn-manager");
    author = await addMember(org, owner.id, "member", "pn-author");
    colleague = await addMember(org, owner.id, "member", "pn-colleague");
    viewer = await addMember(org, owner.id, "viewer", "pn-viewer");
    stranger = await createUser("pn-stranger");
    await createOrg(stranger.id, "עסק אחר");

    team = await asUser(owner.id, async (q) => {
      const t = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות') returning id", [org])).rows[0].id;
      await q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false)",
        [org, t, manager.id, author.id, colleague.id],
      );
      return t;
    });
    // visibility 'org' (the default): everyone sees the lead and the contact, so hiding is the note's own rule
    lead = await insertLead(author.id, org, { full_name: "ליד פרטי", team_id: team });
    contact = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, team_id) values ($1, 'איש קשר', $2) returning id", [org, team])).rows[0].id,
    );
  });

  const write = (user: U, body: string, opts: { private?: boolean; type?: string; on?: "lead" | "contact" } = {}) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.activities (organization_id, type, body, ${opts.on === "contact" ? "contact_id" : "lead_id"}, is_private)
           values ($1, $2, $3, $4, $5) returning id`,
          [org, opts.type ?? "note", body, opts.on === "contact" ? contact : lead, opts.private ?? true],
        )
      ).rows[0].id,
    );
  const sees = (user: U, id: string) => asUser(user.id, (q) => count(q, "select 1 from public.activities where id = $1", [id]));
  const row = (id: string) =>
    asAdmin(async (q) => (await q<{ body: string; is_private: boolean; is_pinned: boolean }>("select body, is_private, is_pinned from public.activities where id = $1", [id])).rows[0]);
  const exists = (id: string) => asAdmin((q) => count(q, "select 1 from public.activities where id = $1", [id]));
  // written 25 hours ago (created_at is the server's clock for a user, so the row is made directly)
  const writeOld = (user: U, body: string, isPrivate: boolean) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.activities (organization_id, type, body, lead_id, created_by, created_at, is_private)
           values ($1, 'note', $2, $3, $4, now() - interval '25 hours', $5) returning id`,
          [org, body, lead, user.id, isPrivate],
        )
      ).rows[0].id,
    );

  it("the author, the owner and the admins see a private note; the manager, a colleague, a viewer and another organization do not", async () => {
    const id = await write(author, "רק אני והמנהלים");
    for (const who of [author, owner, admin]) {
      expect(await sees(who, id)).toBe(1);
    }
    for (const who of [manager, colleague, viewer, stranger]) {
      expect(await sees(who, id)).toBe(0);
    }
    // the same note, not private: everyone in the organization sees it
    const open = await write(author, "לכולם", { private: false });
    for (const who of [author, owner, admin, manager, colleague, viewer]) {
      expect(await sees(who, open)).toBe(1);
    }
    expect(await sees(stranger, open)).toBe(0);
  });

  it("an admin's private note is hidden from the members and seen by the other admins", async () => {
    const id = await write(admin, "של מנהל");
    expect(await sees(owner, id)).toBe(1);
    expect(await sees(admin, id)).toBe(1);
    expect(await sees(author, id)).toBe(0);
    expect(await sees(manager, id)).toBe(0);
  });

  it("only a note can be private", async () => {
    for (const type of ["call", "meeting", "email", "whatsapp", "sms", "status_change"]) {
      const error = await pgError(write(author, "x", { type }));
      expect(error.code, type).toBe("23514");
    }
    const call = await write(author, "שיחה", { type: "call", private: false });
    const error = await pgError(asUser(author.id, (q) => q("update public.activities set is_private = true where id = $1", [call])));
    expect(error.code).toBe("23514");
  });

  it("a note is not private unless asked, and a server insert is not private", async () => {
    const id = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'רגילה', $2) returning id", [org, lead])).rows[0].id,
    );
    expect((await row(id)).is_private).toBe(false);
  });

  it("the author makes a note private or public within 24 hours; after that only an owner or admin can", async () => {
    const id = await write(author, "החלפה", { private: false });
    expect(await asUser(author.id, async (q) => (await q("update public.activities set is_private = true where id = $1", [id])).rowCount)).toBe(1);
    expect(await sees(colleague, id)).toBe(0);
    expect(await asUser(author.id, async (q) => (await q("update public.activities set is_private = false where id = $1", [id])).rowCount)).toBe(1);
    expect(await sees(colleague, id)).toBe(1);

    // the change is in the audit log, like a change of the text
    const logged = await asAdmin(
      (q) => count(q, "select 1 from public.audit_log where entity_type = 'activities' and entity_id = $1 and changes ? 'is_private'", [id]),
    );
    expect(logged).toBe(2);

    // after 24 hours the author can no longer hide it (nor delete it); an admin can, either way
    const old = await writeOld(author, "ישנה", false);
    const late = await pgError(asUser(author.id, (q) => q("update public.activities set is_private = true where id = $1", [old])));
    expect(late.code).toBe("42501");
    expect(late.hint).toBe("note:edit_window");
    expect((await row(old)).is_private).toBe(false);
    expect(await asUser(admin.id, async (q) => (await q("update public.activities set is_private = true where id = $1", [old])).rowCount)).toBe(1);
    expect((await row(old)).is_private).toBe(true);
    // ...and the author still pins their own old private note
    expect(await asUser(author.id, async (q) => (await q("update public.activities set is_pinned = true where id = $1", [old])).rowCount)).toBe(1);
  });

  it("a colleague or the team manager cannot make someone else's note private", async () => {
    const id = await write(author, "פתוחה", { private: false });
    expect(await asUser(colleague.id, async (q) => (await q("update public.activities set is_private = true where id = $1", [id])).rowCount)).toBe(0);
    const error = await pgError(asUser(manager.id, (q) => q("update public.activities set is_private = true where id = $1", [id])));
    expect(error.code).toBe("42501");
    expect(error.hint).toBe("note:pin_only");
    expect((await row(id)).is_private).toBe(false);
  });

  it("the team manager cannot pin, edit or delete a private note they cannot see; the author and an admin can", async () => {
    const id = await write(author, "לא לנעיצה");
    expect(await asUser(manager.id, async (q) => (await q("update public.activities set is_pinned = true where id = $1", [id])).rowCount)).toBe(0);
    expect((await row(id)).is_pinned).toBe(false);
    expect(await asUser(colleague.id, async (q) => (await q("update public.activities set body = 'x' where id = $1", [id])).rowCount)).toBe(0);
    expect(await asUser(viewer.id, async (q) => (await q("update public.activities set is_pinned = true where id = $1", [id])).rowCount)).toBe(0);

    expect(await asUser(author.id, async (q) => (await q("update public.activities set is_pinned = true, body = 'תוקן' where id = $1", [id])).rowCount)).toBe(1);
    expect(await asUser(admin.id, async (q) => (await q("update public.activities set is_pinned = false where id = $1", [id])).rowCount)).toBe(1);
    expect(await row(id)).toMatchObject({ body: "תוקן", is_pinned: false });
  });

  it("an update or delete with no WHERE clause does not reach someone else's private note", async () => {
    const id = await write(author, "מוגנת");
    // the manager pins the team's notes; a private one is out of reach
    await asUser(manager.id, (q) => q("update public.activities set is_pinned = true"));
    expect((await row(id)).is_pinned).toBe(false);
    // a member who is an admin in no organization deletes nothing of it
    await asUser(colleague.id, (q) => q("delete from public.activities"));
    await asUser(manager.id, (q) => q("delete from public.activities"));
    expect(await exists(id)).toBe(1);
  });

  it("delete: the author within 24 hours, an admin always, nobody else", async () => {
    const mine = await write(author, "למחיקה");
    expect(await asUser(colleague.id, async (q) => (await q("delete from public.activities where id = $1", [mine])).rowCount)).toBe(0);
    expect(await asUser(author.id, async (q) => (await q("delete from public.activities where id = $1", [mine])).rowCount)).toBe(1);

    const old = await writeOld(author, "ישנה", true);
    expect(await asUser(author.id, async (q) => (await q("delete from public.activities where id = $1", [old])).rowCount)).toBe(0);
    expect(await asUser(admin.id, async (q) => (await q("delete from public.activities where id = $1", [old])).rowCount)).toBe(1);
  });

  it("global search finds a private note for its author and the admins only", async () => {
    await write(author, "סודחסוי מילהנדירה");
    const found = (user: U) =>
      asUser(user.id, async (q) =>
        (await q<{ r: { notes: unknown[] } }>("select public.search_records($1, $2) as r", [org, "מילהנדירה"])).rows[0].r.notes.length,
      );
    expect(await found(author)).toBe(1);
    expect(await found(admin)).toBe(1);
    expect(await found(owner)).toBe(1);
    expect(await found(colleague)).toBe(0);
    expect(await found(manager)).toBe(0);
    expect(await found(viewer)).toBe(0);
  });

  it("the record summary's last touch does not show a private note to others, and it does not move last contact", async () => {
    const summary = (user: U) =>
      asUser(user.id, async (q) =>
        (await q<{ s: { last_touch: { type: string; occurred_at: string } | null } }>("select public.record_summary($1, 'contact', $2) as s", [org, contact])).rows[0].s,
      );
    const lastContacted = () =>
      asAdmin(async (q) => (await q<{ at: string | null }>("select last_contacted_at as at from public.contacts where id = $1", [contact])).rows[0].at);

    expect(await lastContacted()).toBeNull();
    const id = await write(author, "פרטית על איש הקשר", { on: "contact" });
    expect(await lastContacted()).toBeNull();
    expect((await summary(colleague)).last_touch).toBeNull();
    expect((await summary(manager)).last_touch).toBeNull();
    expect((await summary(author)).last_touch?.type).toBe("note");
    expect((await summary(admin)).last_touch?.type).toBe("note");

    // made public: it counts from then
    await asUser(author.id, (q) => q("update public.activities set is_private = false where id = $1", [id]));
    expect(await lastContacted()).not.toBeNull();
    expect((await summary(colleague)).last_touch?.type).toBe("note");
  });

  it("the reports count a private note only for those who see it", async () => {
    // the admin's own notes, in the activity report (security invoker: RLS decides what is counted)
    const notes = (user: U) =>
      asUser(user.id, async (q) =>
        (
          await q<{ r: { by_user: Array<{ user_id: string; note: number }> } }>(
            "select public.report_activity($1, now() - interval '1 day', now() + interval '1 day', $2) as r",
            [org, admin.id],
          )
        ).rows[0].r.by_user.find((u) => u.user_id === admin.id)?.note ?? 0,
      );
    await write(admin, "עוד אחת של מנהל");
    await write(admin, "גלויה של מנהל", { private: false });
    expect(await notes(owner)).toBeGreaterThanOrEqual(3);
    expect(await notes(colleague)).toBe(1);
    expect(await notes(manager)).toBe(1);
  });
});
