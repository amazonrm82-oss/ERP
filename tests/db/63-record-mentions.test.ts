import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mentionIds } from "@/features/mentions/token";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const token = (user: U, name = "שם") => `@[${name}](user:${user.id})`;

// REC-02: @mentions in what a person logs on a record. The mentioned user is told (kind 'mention')
// with a link to the record; only someone who may see the record can be mentioned, once per entry.
describe("mentions in notes (REC-02)", () => {
  let owner: U, admin: U, manager: U, author: U, colleague: U, outsider: U, viewer: U, suspended: U, stranger: U;
  let org: string, team: string, lead: string;
  // a second organization whose records are seen by their owners only
  let ownOrg: string, ownOwner: U, ownAuthor: U, ownOther: U, ownManager: U, ownAdmin: U, ownLead: string;

  beforeAll(async () => {
    owner = await createUser("mn-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "mn-admin");
    manager = await addMember(org, owner.id, "manager", "mn-manager");
    author = await addMember(org, owner.id, "member", "mn-author");
    colleague = await addMember(org, owner.id, "member", "mn-colleague");
    outsider = await addMember(org, owner.id, "member", "mn-outsider");
    viewer = await addMember(org, owner.id, "viewer", "mn-viewer");
    suspended = await addMember(org, owner.id, "member", "mn-suspended");
    stranger = await createUser("mn-stranger");
    await createOrg(stranger.id, "עסק אחר");
    await asUser(owner.id, (q) =>
      q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, suspended.id]),
    );
    team = await asUser(owner.id, async (q) => {
      const t = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)", [
        org,
        t,
        manager.id,
        author.id,
      ]);
      return t;
    });
    lead = await insertLead(author.id, org, { full_name: "דנה כהן", team_id: team });

    ownOwner = await createUser("mn-own-owner");
    ownOrg = await createOrg(ownOwner.id, "עסק פרטי");
    ownAdmin = await addMember(ownOrg, ownOwner.id, "admin", "mn-own-admin");
    ownManager = await addMember(ownOrg, ownOwner.id, "manager", "mn-own-manager");
    ownAuthor = await addMember(ownOrg, ownOwner.id, "member", "mn-own-author");
    ownOther = await addMember(ownOrg, ownOwner.id, "member", "mn-own-other");
    await asUser(ownOwner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [ownOrg]));
    const ownTeam = await asUser(ownOwner.id, async (q) => {
      const t = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות') returning id", [ownOrg])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)", [
        ownOrg,
        t,
        ownManager.id,
        ownAuthor.id,
      ]);
      return t;
    });
    ownLead = await insertLead(ownAuthor.id, ownOrg, { full_name: "ליד פרטי", team_id: ownTeam });
  });

  const note = (user: U, body: string, opts: { org?: string; lead?: string; private?: boolean; type?: string } = {}) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, $2, $3, $4, $5) returning id",
          [opts.org ?? org, opts.type ?? "note", body, opts.lead ?? lead, opts.private ?? false],
        )
      ).rows[0].id,
    );
  const edit = (user: U, id: string, change: { body?: string; is_private?: boolean }) =>
    asUser(user.id, (q) =>
      q("update public.activities set body = coalesce($2, body), is_private = coalesce($3, is_private) where id = $1", [
        id,
        change.body ?? null,
        change.is_private ?? null,
      ]),
    );
  const mentions = (user: U) =>
    asAdmin(async (q) =>
      (
        await q<{ title: string; body: string; entity_type: string; entity_id: string; organization_id: string }>(
          "select title, body, entity_type, entity_id, organization_id from public.notifications where user_id = $1 and type = 'mention' order by created_at",
          [user.id],
        )
      ).rows,
    );

  it("tells the mentioned colleague once, with a link to the record and the author; never the note's text", async () => {
    const before = (await mentions(colleague)).length;
    await note(author, `${token(colleague, "חן")} תחזרי ללקוח **מחר**, ${token(author, "אני")}`);
    const got = (await mentions(colleague)).slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ entity_type: "lead", entity_id: lead, organization_id: org });
    expect(got[0].title).toBe("הזכירו אתכם בליד: דנה כהן");
    expect(got[0].body).toBe("mn-author הזכיר/ה אתכם");
    expect(`${got[0].title} ${got[0].body}`).not.toMatch(/תחזרי|חן|user:/);
    expect(await mentions(author)).toHaveLength(0);
  });

  it("works on a contact too, and an admin's edit names the entry's author, not the admin", async () => {
    const contact = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, last_name) values ($1, 'רות', 'לוי') returning id", [org])).rows[0].id,
    );
    const id = await asUser(author.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, contact_id) values ($1, 'note', 'שיחה', $2) returning id", [org, contact]))
        .rows[0].id,
    );
    const before = (await mentions(colleague)).length;
    await edit(admin, id, { body: `שיחה ${token(colleague)}` });
    const got = (await mentions(colleague)).slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ entity_type: "contact", entity_id: contact, title: "הזכירו אתכם באיש קשר: רות לוי", body: "mn-author הזכיר/ה אתכם" });
    // the author is not told about their own entry
    await edit(admin, id, { body: `שיחה ${token(colleague)} ${token(author)}` });
    expect(await mentions(author)).toHaveLength(0);
  });

  it("under 'team' visibility: a team member and a manager of a parent team can be mentioned, someone outside the team cannot", async () => {
    const tOwner = await createUser("mn-team-owner");
    const tOrg = await createOrg(tOwner.id, "עסק צוותים");
    const parentManager = await addMember(tOrg, tOwner.id, "manager", "mn-parent-manager");
    const writer = await addMember(tOrg, tOwner.id, "member", "mn-team-writer");
    const mate = await addMember(tOrg, tOwner.id, "member", "mn-team-mate");
    const other = await addMember(tOrg, tOwner.id, "member", "mn-team-other");
    const child = await asUser(tOwner.id, async (q) => {
      await q("update public.organizations set record_visibility = 'team' where id = $1", [tOrg]);
      const parent = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'הורה') returning id", [tOrg])).rows[0].id;
      const child = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'ילד', $2) returning id", [tOrg, parent]))
        .rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [tOrg, parent, parentManager.id]);
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, false), ($1, $2, $4, false)", [
        tOrg,
        child,
        writer.id,
        mate.id,
      ]);
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, false)", [tOrg, parent, other.id]);
      return child;
    });
    const tLead = await insertLead(writer.id, tOrg, { full_name: "ליד צוות", team_id: child });
    expect((await pgError(note(writer, `היי ${token(other)}`, { org: tOrg, lead: tLead }))).hint).toBe("mention:forbidden");
    await note(writer, `היי ${token(mate)} ${token(parentManager)}`, { org: tOrg, lead: tLead });
    expect(await mentions(mate)).toHaveLength(1);
    expect(await mentions(parentManager)).toHaveLength(1);
    expect(await mentions(other)).toHaveLength(0);
  });

  it("an entry a server function writes is neither checked nor announced (a held meeting whose title holds a token)", async () => {
    const meeting = await asUser(author.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.meetings (organization_id, title, starts_at, ends_at, status, lead_id)
           values ($1, $2, now() - interval '3 hours', now() - interval '2 hours', 'planned', $3) returning id`,
          [org, `פגישה ${token(stranger)} ${token(colleague)}`, lead],
        )
      ).rows[0].id,
    );
    const before = (await mentions(colleague)).length;
    expect(await asUser(author.id, async (q) => (await q("update public.meetings set status = 'held' where id = $1", [meeting])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where metadata ->> 'meeting_id' = $1", [meeting]))).toBe(1);
    expect((await mentions(colleague)).length).toBe(before);
    expect(await mentions(stranger)).toHaveLength(0);
  });

  it("the database reads the same mentions as the app (app.mention_ids vs mentionIds)", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const inputs = [
      `@[דנה](user:${id})`,
      `@[${"א".repeat(100)}](user:${id})`,
      `@[${"א".repeat(101)}](user:${id})`,
      `@[${"😀".repeat(100)}](user:${id})`,
      `@[${"😀".repeat(101)}](user:${id})`,
      `@[](user:${id})`,
      `@[a\nb](user:${id})`,
      `@[a[b](user:${id.toUpperCase()})`,
      `@[a]b](user:${id})`,
      `[דנה](user:${id})`,
      `@[x](user:${id}`,
      `\\@[x](user:${id})`,
    ];
    for (const input of inputs) {
      const db = await asAdmin(async (q) => (await q<{ ids: string[] }>("select app.mention_ids($1)::text[] as ids", [input])).rows[0].ids);
      expect(db, input).toEqual(mentionIds(input));
    }
    expect(mentionIds(inputs[3])).toEqual([id]);
    expect(mentionIds(inputs[4])).toEqual([]);
  });

  it("an edit tells only people who were not told about that entry before", async () => {
    const id = await note(author, `שלום ${token(colleague)}`);
    const colleagueBefore = (await mentions(colleague)).length;
    const viewerBefore = (await mentions(viewer)).length;
    await edit(author, id, { body: `שלום ${token(colleague)} (תיקון)` });
    expect((await mentions(colleague)).length).toBe(colleagueBefore);
    await edit(author, id, { body: `שלום ${token(colleague)} ${token(viewer, "צופה")}` });
    expect((await mentions(colleague)).length).toBe(colleagueBefore);
    expect((await mentions(viewer)).length).toBe(viewerBefore + 1);
    // removed and written again: still not told twice
    await edit(author, id, { body: "בלי אזכורים" });
    await edit(author, id, { body: `שוב ${token(colleague)} ${token(viewer)}` });
    expect((await mentions(colleague)).length).toBe(colleagueBefore);
    expect((await mentions(viewer)).length).toBe(viewerBefore + 1);
  });

  it("refuses to mention someone who may not see the record: another organization, a suspended member, an unknown id", async () => {
    for (const who of [stranger, suspended, { id: "00000000-0000-4000-8000-000000000000", email: "" }]) {
      const error = await pgError(note(author, `היי ${token(who)}`));
      expect(error.code).toBe("P0001");
      expect(error.hint).toBe("mention:forbidden");
    }
    expect(await mentions(stranger)).toHaveLength(0);
    expect(await mentions(suspended)).toHaveLength(0);
  });

  it("under 'own' visibility only the owners, admins, the record's owner and its team manager can be mentioned", async () => {
    const error = await pgError(note(ownAuthor, `היי ${token(ownOther)}`, { org: ownOrg, lead: ownLead }));
    expect(error.hint).toBe("mention:forbidden");
    await note(ownAuthor, `היי ${token(ownAdmin)} ${token(ownManager)} ${token(ownOwner)}`, { org: ownOrg, lead: ownLead });
    for (const who of [ownAdmin, ownManager, ownOwner]) {
      expect(await mentions(who)).toHaveLength(1);
    }
    expect(await mentions(ownOther)).toHaveLength(0);
  });

  it("a mention already in the text is not checked again when the note is edited after access was lost", async () => {
    const extra = await addMember(ownOrg, ownOwner.id, "admin", "mn-own-later");
    const id = await note(ownAuthor, `לטיפול ${token(extra)}`, { org: ownOrg, lead: ownLead });
    expect(await mentions(extra)).toHaveLength(1);
    await asUser(ownOwner.id, (q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [ownOrg, extra.id]));
    await edit(ownAuthor, id, { body: `לטיפול ${token(extra)} - עודכן` });
    expect(await mentions(extra)).toHaveLength(1);
  });

  it("a private note tells nobody; made public, it tells the mentioned people who may see it", async () => {
    const before = (await mentions(admin)).length;
    const id = await note(author, `סוד ${token(admin)}`, { private: true });
    expect((await mentions(admin)).length).toBe(before);
    // a forbidden mention is refused in a private note too
    expect((await pgError(note(author, `סוד ${token(stranger)}`, { private: true }))).hint).toBe("mention:forbidden");
    await edit(author, id, { is_private: false });
    expect((await mentions(admin)).length).toBe(before + 1);
    await edit(author, id, { is_private: true });
    await edit(author, id, { is_private: false });
    expect((await mentions(admin)).length).toBe(before + 1);
  });

  it("a muted 'mention' kind is respected", async () => {
    await asUser(outsider.id, (q) => q("select public.set_notification_settings($1, $2)", [["mention"], []]));
    await note(author, `היי ${token(outsider)}`);
    expect(await mentions(outsider)).toHaveLength(0);
    await asUser(outsider.id, (q) => q("select public.set_notification_settings($1, $2)", [[], []]));
  });

  it("at most 20 people per entry", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `@[x${i}](user:${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000)`).join(" ");
    const error = await pgError(note(author, many));
    expect(error.hint).toBe("mention:too_many");
  });

  it("a call log can mention too; a system entry written by the server tells nobody", async () => {
    const before = (await mentions(manager)).length;
    await note(author, `שיחה ${token(manager)}`, { type: "call" });
    expect((await mentions(manager)).length).toBe(before + 1);
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'system', $2, $3)", [org, `x ${token(manager)}`, lead]),
    );
    expect((await mentions(manager)).length).toBe(before + 1);
  });

  it("who was told goes with the entry when it is deleted, and clients cannot read it", async () => {
    const id = await note(author, `למחיקה ${token(colleague)}`);
    expect(await asAdmin((q) => count(q, "select 1 from app.activity_mentions where activity_id = $1", [id]))).toBe(1);
    expect(await asUser(author.id, async (q) => (await q("delete from public.activities where id = $1", [id])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.activity_mentions where activity_id = $1", [id]))).toBe(0);
    expect((await pgError(asUser(author.id, (q) => q("select * from app.activity_mentions")))).code).toBe("42501");
  });

  describe("mention_candidates", () => {
    const candidates = (user: U, o: string, kind: string, id: string) =>
      asUser(user.id, async (q) =>
        (await q<{ user_id: string; name: string }>("select * from public.mention_candidates($1, $2, $3)", [o, kind, id])).rows.map((r) => r.user_id),
      );

    it("lists the active members who may see the record, without the caller", async () => {
      const list = await candidates(author, org, "lead", lead);
      for (const who of [owner, admin, manager, colleague, outsider, viewer]) expect(list).toContain(who.id);
      expect(list).not.toContain(author.id);
      expect(list).not.toContain(suspended.id);
      expect(list).not.toContain(stranger.id);

      const own = await candidates(ownAuthor, ownOrg, "lead", ownLead);
      expect(own).toEqual(expect.arrayContaining([ownOwner.id, ownAdmin.id, ownManager.id]));
      expect(own).not.toContain(ownOther.id);
    });

    it("says nothing to someone who does not see the record, to another organization or to anon", async () => {
      expect(await candidates(ownOther, ownOrg, "lead", ownLead)).toEqual([]);
      expect(await candidates(stranger, org, "lead", lead)).toEqual([]);
      expect(await candidates(author, org, "lead", ownLead)).toEqual([]);
      expect(await candidates(author, org, "bogus", lead)).toEqual([]);
      expect((await pgError(asAnon((q) => q("select * from public.mention_candidates($1, 'lead', $2)", [org, lead]))))).toMatchObject({ code: "42501" });
    });
  });
});
