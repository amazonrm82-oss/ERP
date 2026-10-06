import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * Inside one organization: what each role sees and may do, under each of the
 * three visibility settings (org / team / own).
 */
describe("roles and record visibility", () => {
  let owner: U, admin: U, manager: U, m1: U, m2: U, viewer: U;
  let org: string;
  let team: string;
  let leadM1: string;
  let leadM2: string;

  const setVisibility = (v: "org" | "team" | "own") =>
    asUser(owner.id, (q) => q("update public.organizations set record_visibility = $1 where id = $2", [v, org]));

  const sees = (userId: string, leadId: string) =>
    asUser(userId, async (q) => (await count(q, "select 1 from public.leads where id = $1", [leadId])) === 1);

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    m1 = await addMember(org, owner.id, "member", "m1");
    m2 = await addMember(org, owner.id, "member", "m2");
    viewer = await addMember(org, owner.id, "viewer");

    team = await asUser(admin.id, async (q) => {
      const t = (
        await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות צפון') returning id", [org])
      ).rows[0].id;
      await q(
        "insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)",
        [org, t, manager.id, m1.id],
      );
      return t;
    });

    leadM1 = await insertLead(m1.id, org, { full_name: "ליד של m1", team_id: team });
    leadM2 = await insertLead(m2.id, org, { full_name: "ליד של m2" });
  });

  it("a new record belongs to whoever created it", async () => {
    const owners = await asAdmin(async (q) =>
      (await q<{ id: string; owner_id: string }>("select id, owner_id from public.leads where id = any($1)", [[leadM1, leadM2]])).rows,
    );
    expect(owners.find((r) => r.id === leadM1)?.owner_id).toBe(m1.id);
    expect(owners.find((r) => r.id === leadM2)?.owner_id).toBe(m2.id);
  });

  it("visibility 'org': everyone reads everything, members edit only their own", async () => {
    await setVisibility("org");
    for (const u of [owner, admin, manager, m1, m2, viewer]) {
      expect(await sees(u.id, leadM1), `${u.email} reads leadM1`).toBe(true);
    }
    await asUser(m2.id, async (q) => {
      expect((await q("update public.leads set campaign = 'x' where id = $1", [leadM1])).rowCount).toBe(0);
      expect((await q("update public.leads set campaign = 'x' where id = $1", [leadM2])).rowCount).toBe(1);
    });
  });

  it("visibility 'own': members see only their own, managers their team, admins all", async () => {
    await setVisibility("own");
    expect(await sees(m1.id, leadM1)).toBe(true);
    expect(await sees(m1.id, leadM2)).toBe(false);
    expect(await sees(m2.id, leadM1)).toBe(false);
    expect(await sees(manager.id, leadM1)).toBe(true); // manages the lead's team
    expect(await sees(manager.id, leadM2)).toBe(false); // lead has no team
    expect(await sees(admin.id, leadM1)).toBe(true);
    expect(await sees(admin.id, leadM2)).toBe(true);
    expect(await sees(owner.id, leadM2)).toBe(true);
    expect(await sees(viewer.id, leadM1)).toBe(false);
  });

  it("visibility 'team': team mates see each other's records", async () => {
    await setVisibility("team");
    expect(await sees(m2.id, leadM1)).toBe(false);
    await asUser(admin.id, (q) =>
      q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, m2.id]),
    );
    expect(await sees(m2.id, leadM1)).toBe(true);
    // reading is not editing
    await asUser(m2.id, async (q) => {
      expect((await q("update public.leads set campaign = 'y' where id = $1", [leadM1])).rowCount).toBe(0);
    });
    await asUser(admin.id, (q) => q("delete from public.team_members where team_id = $1 and user_id = $2", [team, m2.id]));
  });

  it("timeline notes follow the record's visibility", async () => {
    await setVisibility("own");
    await asUser(m1.id, (q) =>
      q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'סודי', $2)", [org, leadM1]),
    );
    await asUser(m2.id, async (q) => {
      expect(await count(q, "select 1 from public.activities where lead_id = $1", [leadM1])).toBe(0);
    });
    const blocked = await pgError(
      asUser(m2.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [org, leadM1]),
      ),
    );
    expect(blocked.code).toBe("42501");
    await asUser(manager.id, async (q) => {
      expect(await count(q, "select 1 from public.activities where lead_id = $1", [leadM1])).toBe(1);
    });
  });

  it("a viewer cannot create or change anything", async () => {
    await setVisibility("org");
    const insert = await pgError(insertLead(viewer.id, org));
    expect(insert.code).toBe("42501");
    await asUser(viewer.id, async (q) => {
      expect((await q("update public.leads set campaign = 'v' where id = $1", [leadM1])).rowCount).toBe(0);
    });
    const note = await pgError(
      asUser(viewer.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [org, leadM1]),
      ),
    );
    expect(note.code).toBe("42501");
    const task = await pgError(
      asUser(viewer.id, (q) => q("insert into public.tasks (organization_id, title) values ($1, 'x')", [org])),
    );
    expect(task.code).toBe("42501");
  });

  it("a member cannot hand a record to someone else; a manager can, inside the team", async () => {
    const member = await pgError(
      asUser(m1.id, (q) => q("update public.leads set owner_id = $1 where id = $2", [m2.id, leadM1])),
    );
    expect(member.code).toBe("42501");

    await asUser(manager.id, async (q) => {
      expect((await q("update public.leads set owner_id = $1 where id = $2", [m2.id, leadM1])).rowCount).toBe(1);
      expect((await q("update public.leads set owner_id = $1 where id = $2", [m1.id, leadM1])).rowCount).toBe(1);
    });
  });

  it("recycle bin: members cannot delete, managers can for their team, admins purge", async () => {
    const member = await pgError(
      asUser(m1.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [leadM1])),
    );
    expect(member.code).toBe("42501");

    await asUser(manager.id, async (q) => {
      expect((await q("update public.leads set deleted_at = now() where id = $1", [leadM1])).rowCount).toBe(1);
      expect((await q("update public.leads set deleted_at = null where id = $1", [leadM1])).rowCount).toBe(1);
    });

    // a hard delete works only for an admin and only from the recycle bin
    const victim = await insertLead(m1.id, org, { full_name: "למחיקה" });
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.leads where id = $1", [victim])).rowCount).toBe(0);
      await q("update public.leads set deleted_at = now() where id = $1", [victim]);
    });
    await asUser(manager.id, async (q) => {
      expect((await q("delete from public.leads where id = $1", [victim])).rowCount).toBe(0);
    });
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.leads where id = $1", [victim])).rowCount).toBe(1);
    });
  });

  it("only admins change settings", async () => {
    await asUser(m1.id, async (q) => {
      expect((await q("update public.organizations set name = 'x' where id = $1", [org])).rowCount).toBe(0);
    });
    for (const sql of [
      "insert into public.pipelines (organization_id, name) values ($1, 'x')",
      "insert into public.teams (organization_id, name) values ($1, 'x')",
      "insert into public.lead_statuses (organization_id, name) values ($1, 'x')",
      "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'x', 'x', 'text')",
    ]) {
      expect((await pgError(asUser(m1.id, (q) => q(sql, [org])))).code, sql).toBe("42501");
      expect((await pgError(asUser(manager.id, (q) => q(sql, [org])))).code, sql).toBe("42501");
    }
    await asUser(admin.id, async (q) => {
      expect((await q("update public.organizations set name = 'שם חדש' where id = $1", [org])).rowCount).toBe(1);
      await q("insert into public.pipelines (organization_id, name) values ($1, 'חידושים')", [org]);
    });
  });

  it("a member cannot change configuration, in any table", async () => {
    await setVisibility("org");
    await asUser(admin.id, async (q) => {
      await q("insert into public.tags (organization_id, name) values ($1, 'תגית של מנהל')", [org]);
      await q(
        "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'contact', 'hobby', 'תחביב', 'text')",
        [org],
      );
      await q(
        "insert into public.saved_views (organization_id, object_type, name, scope, owner_id) values ($1, 'lead', 'כל הלידים', 'org', $2)",
        [org, admin.id],
      );
    });
    await asUser(owner.id, (q) => q("select public.create_invitation($1, 'pending@example.test')", [org]));

    const noop: Record<string, string> = {
      pipelines: "name = name",
      stages: "name = name",
      lead_statuses: "name = name",
      lead_sources: "name = name",
      field_definitions: "label = label",
      teams: "name = name",
      team_members: "is_manager = is_manager",
      tags: "name = name",
      saved_views: "name = name",
    };
    for (const u of [m1, manager, viewer]) {
      await asUser(u.id, async (q) => {
        for (const [table, set] of Object.entries(noop)) {
          // the member can read these rows, so only the write policy stands in the way
          expect(await count(q, `select 1 from public.${table} where organization_id = $1`, [org]), `${table} readable`).toBeGreaterThan(0);
          expect((await q(`update public.${table} set ${set} where organization_id = $1`, [org])).rowCount, `update ${table}`).toBe(0);
          expect((await q(`delete from public.${table} where organization_id = $1`, [org])).rowCount, `delete ${table}`).toBe(0);
        }
        // invitations are not even readable for non-admins
        expect(await count(q, "select 1 from public.invitations where organization_id = $1", [org])).toBe(0);
        expect((await q("update public.invitations set revoked_at = now() where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.invitations where organization_id = $1", [org])).rowCount).toBe(0);
        // nor can they remove a colleague
        expect((await q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, m2.id])).rowCount).toBe(0);
      });
      const addToTeam = await pgError(
        asUser(u.id, (q) =>
          q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, m2.id]),
        ),
      );
      expect(addToTeam.code).toBe("42501");
    }
    const pending = await asAdmin((q) =>
      count(q, "select 1 from public.invitations where email = 'pending@example.test' and revoked_at is null"),
    );
    expect(pending).toBe(1);
  });

  it("a member cannot change a colleague's records, in any table", async () => {
    await setVisibility("org");
    const pipe = await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const s = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 order by position limit 1", [p])).rows[0].id;
      return { p, s };
    });
    const rec = await asUser(m2.id, async (q) => {
      const company = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה של m2') returning id", [org])).rows[0].id;
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'איש קשר של m2') returning id", [org])).rows[0].id;
      const contact2 = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'שני') returning id", [org])).rows[0].id;
      const deal = (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה של m2', $2, $3) returning id", [org, pipe.p, pipe.s])
      ).rows[0].id;
      const task = (await q<{ id: string }>("insert into public.tasks (organization_id, title) values ($1, 'משימה של m2') returning id", [org])).rows[0].id;
      await q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'מחליט')", [org, deal, contact]);
      return { company, contact, contact2, deal, task };
    });

    const tables: [string, string, string][] = [
      ["companies", rec.company, "industry = 'x'"],
      ["contacts", rec.contact, "job_title = 'x'"],
      ["deals", rec.deal, "amount_agorot = 1"],
      ["tasks", rec.task, "title = 'x'"],
    ];
    await asUser(m1.id, async (q) => {
      for (const [table, id, set] of tables) {
        expect(await count(q, `select 1 from public.${table} where id = $1`, [id]), `${table} readable`).toBe(1);
        expect((await q(`update public.${table} set ${set} where id = $1`, [id])).rowCount, `update ${table}`).toBe(0);
        expect((await q(`update public.${table} set deleted_at = now() where id = $1`, [id])).rowCount, `trash ${table}`).toBe(0);
        expect((await q(`delete from public.${table} where id = $1`, [id])).rowCount, `delete ${table}`).toBe(0);
      }
      expect((await q("update public.deal_contacts set role = 'x' where deal_id = $1", [rec.deal])).rowCount).toBe(0);
      expect((await q("delete from public.deal_contacts where deal_id = $1", [rec.deal])).rowCount).toBe(0);
    });
    const link = await pgError(
      asUser(m1.id, (q) =>
        q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3)", [org, rec.deal, rec.contact2]),
      ),
    );
    expect(link.code).toBe("42501");

    // the owner of the records can do all of it (except deleting, which is not a member's right)
    await asUser(m2.id, async (q) => {
      for (const [table, id, set] of tables) {
        expect((await q(`update public.${table} set ${set} where id = $1`, [id])).rowCount, `own update ${table}`).toBe(1);
      }
      expect((await q("update public.deal_contacts set role = 'משפיע' where deal_id = $1", [rec.deal])).rowCount).toBe(1);
    });
    for (const [table, id] of tables) {
      const err = await pgError(asUser(m2.id, (q) => q(`update public.${table} set deleted_at = now() where id = $1`, [id])));
      expect(err.code, `member trash own ${table}`).toBe("42501");
    }

    // only an admin purges, and only from the recycle bin; a manager does not
    await asUser(admin.id, async (q) => {
      for (const [table, id] of tables) {
        expect((await q(`delete from public.${table} where id = $1`, [id])).rowCount, `purge live ${table}`).toBe(0);
        expect((await q(`update public.${table} set deleted_at = now() where id = $1`, [id])).rowCount).toBe(1);
      }
    });
    for (const u of [m1, m2, manager]) {
      await asUser(u.id, async (q) => {
        for (const [table, id] of tables) {
          expect((await q(`delete from public.${table} where id = $1`, [id])).rowCount, `${u.email} purge ${table}`).toBe(0);
        }
      });
    }
    await asUser(admin.id, async (q) => {
      for (const [table, id] of [...tables].reverse()) {
        expect((await q(`delete from public.${table} where id = $1`, [id])).rowCount, `admin purge ${table}`).toBe(1);
      }
    });
  });

  it("nobody can change the organization's billing status from a client", async () => {
    for (const u of [owner, admin]) {
      const err = await pgError(
        asUser(u.id, (q) => q("update public.organizations set status = 'active' where id = $1", [org])),
      );
      expect(err.code).toBe("42501");
    }
    const sub = await pgError(
      asUser(owner.id, (q) => q("update public.subscriptions set plan_key = 'business' where organization_id = $1", [org])),
    );
    expect(sub.code).toBe("42501");
  });

  it("membership rules: no self-promotion, the owner is protected, admins do not touch admins", async () => {
    const self = await pgError(
      asUser(m1.id, (q) => q("update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2", [org, m1.id])),
    );
    expect(self.code).toBe("42501");

    await asUser(m1.id, async (q) => {
      // someone else's membership is simply not updatable for a member
      expect(
        (await q("update public.memberships set role = 'viewer', seat_type = 'view' where organization_id = $1 and user_id = $2", [org, m2.id])).rowCount,
      ).toBe(0);
      // but a member may mark themselves unavailable for lead distribution
      expect(
        (await q("update public.memberships set is_available = false where organization_id = $1 and user_id = $2", [org, m1.id])).rowCount,
      ).toBe(1);
    });

    const demoteOwner = await pgError(
      asUser(admin.id, (q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, owner.id])),
    );
    expect(demoteOwner.code).toBe("42501");

    const makeOwner = await pgError(
      asUser(admin.id, (q) => q("update public.memberships set role = 'owner' where organization_id = $1 and user_id = $2", [org, m1.id])),
    );
    expect(["42501", "23505"]).toContain(makeOwner.code);

    const removeOwner = await pgError(
      asUser(admin.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, owner.id])),
    );
    expect(removeOwner.code).toBe("42501");

    const ownerLeaves = await pgError(
      asUser(owner.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, owner.id])),
    );
    expect(ownerLeaves.code).toBe("42501");

    const admin2 = await addMember(org, owner.id, "admin", "admin2");
    const adminOnAdmin = await pgError(
      asUser(admin.id, (q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, admin2.id])),
    );
    expect(adminOnAdmin.code).toBe("42501");
    const adminRemovesAdmin = await pgError(
      asUser(admin.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, admin2.id])),
    );
    expect(adminRemovesAdmin.code).toBe("42501");

    // only the owner adds admins, by invitation or by promotion
    const adminPromotes = await pgError(
      asUser(admin.id, (q) => q("update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2", [org, m1.id])),
    );
    expect(adminPromotes.code).toBe("42501");
    await asUser(owner.id, async (q) => {
      expect((await q("update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2", [org, m1.id])).rowCount).toBe(1);
      expect((await q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, m1.id])).rowCount).toBe(1);
    });

    // an admin does manage ordinary members
    await asUser(admin.id, async (q) => {
      expect(
        (await q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, m2.id])).rowCount,
      ).toBe(1);
    });
    // a suspended member is locked out at once
    await asUser(m2.id, async (q) => {
      expect(await count(q, "select 1 from public.leads")).toBe(0);
      expect(await count(q, "select 1 from public.organizations where id = $1", [org])).toBe(0);
    });
    await asUser(admin.id, (q) =>
      q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, m2.id]),
    );
  });

  it("a member can leave, unless they still own records", async () => {
    const stillOwns = await pgError(
      asUser(m2.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, m2.id])),
    );
    expect(stillOwns.code).toBe("23503");

    const m3 = await addMember(org, owner.id, "member", "m3");
    await asUser(m3.id, async (q) => {
      expect((await q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, m3.id])).rowCount).toBe(1);
    });
  });

  it("only admins read the audit log", async () => {
    await asUser(admin.id, async (q) => {
      expect(await count(q, "select 1 from public.audit_log where organization_id = $1", [org])).toBeGreaterThan(0);
    });
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.audit_log")).toBe(0);
      });
    }
  });

  it("ownership moves only through transfer_ownership, and only by the owner", async () => {
    const byAdmin = await pgError(asUser(admin.id, (q) => q("select public.transfer_ownership($1, $2)", [org, admin.id])));
    expect(byAdmin.code).toBe("42501");

    const toViewer = await pgError(asUser(owner.id, (q) => q("select public.transfer_ownership($1, $2)", [org, viewer.id])));
    expect(toViewer.code).toBe("22023");

    await asUser(owner.id, (q) => q("select public.transfer_ownership($1, $2)", [org, admin.id]));
    const roles = await asAdmin(async (q) =>
      (await q<{ user_id: string; role: string }>("select user_id, role from public.memberships where organization_id = $1", [org])).rows,
    );
    expect(roles.find((r) => r.user_id === admin.id)?.role).toBe("owner");
    expect(roles.find((r) => r.user_id === owner.id)?.role).toBe("admin");
    expect(roles.filter((r) => r.role === "owner")).toHaveLength(1);
  });
});
