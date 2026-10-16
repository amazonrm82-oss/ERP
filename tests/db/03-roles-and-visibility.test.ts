import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

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

  it("a private note is seen by its author and the owners/admins only, at every visibility (GAP-05)", async () => {
    await setVisibility("org");
    const id = await asUser(m1.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'פרטית', $2, true) returning id",
          [org, leadM1],
        )
      ).rows[0].id,
    );
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.activities where id = $1", [id]));
    for (const u of [m1, owner, admin]) expect(await seen(u), u.email).toBe(1);
    // the manager of the lead's team, a colleague who sees the lead, and a viewer do not
    for (const u of [manager, m2, viewer]) expect(await seen(u), u.email).toBe(0);
    await asAdmin((q) => q("delete from public.activities where id = $1", [id]));
  });

  it("followers: whoever reads a record may follow it, for themselves only, and removes only their own row (REC-03)", async () => {
    await setVisibility("own");
    const follow = (u: U, lead: string) =>
      asUser(u.id, async (q) =>
        (await q<{ id: string; user_id: string }>("insert into public.record_followers (organization_id, lead_id) values ($1, $2) returning id, user_id", [org, lead])).rows[0],
      );
    const followersSeen = (u: U, lead: string) => asUser(u.id, (q) => count(q, "select 1 from public.record_followers where lead_id = $1", [lead]));

    // a record the caller does not see cannot be followed
    expect((await pgError(follow(m2, leadM1))).code).toBe("42501");
    expect((await pgError(follow(viewer, leadM1))).code).toBe("42501");
    // the row is the caller's own: user_id comes from the session and cannot be sent
    const mine = await follow(m1, leadM1);
    expect(mine.user_id).toBe(m1.id);
    const forged = await pgError(
      asUser(m1.id, (q) => q("insert into public.record_followers (organization_id, lead_id, user_id) values ($1, $2, $3)", [org, leadM2, m2.id])),
    );
    expect(forged.code).toBe("42501");
    // following twice is refused
    expect((await pgError(follow(m1, leadM1))).code).toBe("23505");
    // the manager of the lead's team and a viewer (under 'org') may follow
    await follow(manager, leadM1);
    await setVisibility("org");
    const viewerRow = await follow(viewer, leadM1);

    // who follows is seen by whoever sees the record, and by nobody else
    expect(await followersSeen(m2, leadM1)).toBe(3);
    await setVisibility("own");
    expect(await followersSeen(m2, leadM1)).toBe(0);
    expect(await followersSeen(manager, leadM1)).toBe(3);
    expect(await followersSeen(owner, leadM1)).toBe(3);

    // nobody changes a follow row; nobody removes someone else's, not even an admin
    const update = await pgError(asUser(m1.id, (q) => q("update public.record_followers set created_at = now() where id = $1", [mine.id])));
    expect(update.code).toBe("42501");
    await setVisibility("org");
    for (const u of [m2, manager, admin, owner]) {
      await asUser(u.id, async (q) => expect((await q("delete from public.record_followers where id = $1", [mine.id])).rowCount, u.email).toBe(0));
    }
    // their own row goes, even when they no longer see the record
    await setVisibility("own");
    await asUser(viewer.id, async (q) => expect((await q("delete from public.record_followers where id = $1", [viewerRow.id])).rowCount).toBe(1));
    await asUser(m1.id, async (q) => expect((await q("delete from public.record_followers where id = $1", [mine.id])).rowCount).toBe(1));
    await asAdmin((q) => q("delete from public.record_followers where organization_id = $1", [org]));
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

  it("product costs: owners, admins and managers read them, members and viewers do not; only owners and admins write them (PRD-06)", async () => {
    const product = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'מוצר עם עלות', 1000) returning id", [org])).rows[0].id,
    );
    await asUser(admin.id, (q) => q("insert into public.product_costs (organization_id, product_id, cost_agorot) values ($1, $2, 400)", [org, product]));
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.product_costs where product_id = $1", [product]));
    for (const u of [owner, admin, manager]) expect(await seen(u), u.email).toBe(1);
    for (const u of [m1, m2, viewer]) expect(await seen(u), u.email).toBe(0);
    for (const u of [manager, m1, viewer]) {
      expect(await asUser(u.id, async (q) => (await q("update public.product_costs set cost_agorot = 1 where product_id = $1", [product])).rowCount), u.email).toBe(0);
    }
    expect(await asUser(owner.id, async (q) => (await q("update public.product_costs set cost_agorot = 450 where product_id = $1", [product])).rowCount)).toBe(1);
  });

  it("quotes follow their deal: its editors write, readers only read, a viewer never writes (QUO-01)", async () => {
    await setVisibility("own");
    const pipe = (await asAdmin((q) => q<{ id: string }>("select id from public.pipelines where organization_id = $1 limit 1", [org]))).rows[0].id;
    const stage = (await asAdmin((q) => q<{ id: string }>("select id from public.stages where pipeline_id = $1 order by position limit 1", [pipe]))).rows[0].id;
    const deal = await asUser(m1.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה להצעה', $2, $3) returning id", [org, pipe, stage])).rows[0].id,
    );
    const quote = await asUser(m1.id, async (q) =>
      (await q<{ id: string }>("insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).rows[0].id,
    );
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.quotes where id = $1", [quote]));
    const edits = (u: U) => asUser(u.id, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [quote])).rowCount);
    for (const u of [owner, admin, m1]) {
      expect(await seen(u), u.email).toBe(1);
      expect(await edits(u), u.email).toBe(1);
    }
    for (const u of [m2, viewer]) expect(await seen(u), u.email).toBe(0);
    await setVisibility("org");
    for (const u of [m2, viewer]) {
      expect(await seen(u), u.email).toBe(1);
      expect(await edits(u), u.email).toBe(0);
    }
  });

  it("only admins change settings", async () => {
    await asUser(m1.id, async (q) => {
      expect((await q("update public.organizations set name = 'x' where id = $1", [org])).rowCount).toBe(0);
    });
    for (const sql of [
      "insert into public.pipelines (organization_id, name) values ($1, 'x')",
      "insert into public.teams (organization_id, name) values ($1, 'x')",
      "insert into public.lead_statuses (organization_id, name) values ($1, 'x')",
      "insert into public.disqualify_reasons (organization_id, name) values ($1, 'x')",
      "insert into public.record_type_options (organization_id, object_type, name) values ($1, 'contact', 'x')",
      "insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'x', 'x')",
      "insert into public.deal_loss_reasons (organization_id, name) values ($1, 'x')",
      "insert into public.deal_contact_roles (organization_id, name) values ($1, 'x')",
      // LEAD-05
      "insert into public.lead_score_rules (organization_id, field, op, points) values ($1, 'email', 'filled', 5)",
      "insert into public.meeting_types (organization_id, name) values ($1, 'x')",
      "insert into public.product_categories (organization_id, name) values ($1, 'x')",
      "insert into public.product_units (organization_id, name) values ($1, 'x')",
      // PRD-01: the catalog is written by owners and admins only (PRD-06 may refine)
      "insert into public.products (organization_id, name) values ($1, 'x')",
      // PL-01: price lists too
      "insert into public.price_lists (organization_id, name) values ($1, 'x')",
      "insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'month', '2026-01-01', 'won_deals', 1)",
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
      await q("insert into public.products (organization_id, name) values ($1, 'מוצר של מנהל')", [org]);
      await q("insert into public.price_lists (organization_id, name) values ($1, 'מחירון של מנהל')", [org]);
      // PL-02: a price in that list for that product
      await q(
        `insert into public.price_list_lines (organization_id, price_list_id, product_id, price_agorot)
         select $1, l.id, p.id, 5000 from public.price_lists l, public.products p
          where l.organization_id = $1 and l.name = 'מחירון של מנהל' and p.organization_id = $1 and p.name = 'מוצר של מנהל'`,
        [org],
      );
      await q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'סיבה של מנהל')", [org]);
      await q("insert into public.lead_score_rules (organization_id, field, op, points) values ($1, 'email', 'filled', 5)", [org]);
      await q("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'company', 'סוג של מנהל')", [org]);
      await q("insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'year', '2026-01-01', 'won_amount', 5000000)", [org]);
      await q(
        "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'contact', 'hobby', 'תחביב', 'text')",
        [org],
      );
      // LEAD-06: a lead field and where it goes on conversion
      const leadField = (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'lead_hobby', 'תחביב', 'text') returning id",
          [org],
        )
      ).rows[0].id;
      await q(
        "insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, target_field_id) select $1, $2, 'contact', id from public.field_definitions where organization_id = $1 and object_type = 'contact' and key = 'hobby'",
        [org, leadField],
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
      disqualify_reasons: "name = name",
      record_type_options: "name = name",
      whatsapp_templates: "name = name",
      deal_loss_reasons: "name = name",
      deal_contact_roles: "name = name",
      lead_score_rules: "points = points",
      meeting_types: "name = name",
      // PRD-04, seeded for every organization
      product_categories: "name = name",
      product_units: "name = name",
      products: "name = name",
      price_lists: "name = name",
      price_list_lines: "min_quantity = min_quantity",
      goals: "target = target",
      field_definitions: "label = label",
      conversion_field_maps: "target_field_id = target_field_id",
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
      // nor add a conversion mapping (LEAD-06)
      const mapped = await pgError(
        asUser(u.id, (q) =>
          q(
            "insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, mode) select $1, id, 'deal', 'none' from public.field_definitions where organization_id = $1 and key = 'lead_hobby'",
            [org],
          ),
        ),
      );
      expect(mapped.code, "insert conversion_field_maps").toBe("42501");
      // nor add a price to a price list (PL-02)
      const line = await asAdmin(
        async (q) =>
          (await q<{ price_list_id: string; product_id: string }>("select price_list_id, product_id from public.price_list_lines where organization_id = $1 limit 1", [org])).rows[0],
      );
      const addPrice = await pgError(
        asUser(u.id, (q) =>
          q("insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, discount_bp) values ($1, $2, $3, 50, 100)", [
            org,
            line.price_list_id,
            line.product_id,
          ]),
        ),
      );
      expect(addPrice.code).toBe("42501");
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
      await q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3)", [org, deal, contact]);
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
      expect((await q("update public.deal_contacts set role = 'user' where deal_id = $1", [rec.deal])).rowCount).toBe(0);
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
      expect((await q("update public.deal_contacts set role = null where deal_id = $1", [rec.deal])).rowCount).toBe(1);
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

  it("contacts on a deal follow the deal; a new link needs a live contact the caller reads, and only the role changes (CON-03)", async () => {
    await setVisibility("own");
    const pipe = await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const s = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 order by position limit 1", [p])).rows[0].id;
      return { p, s };
    });
    const mine = await asUser(m1.id, async (q) => {
      const deal = (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקת תפקידים', $2, $3) returning id", [org, pipe.p, pipe.s])
      ).rows[0].id;
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'מקבלת החלטה') returning id", [org])).rows[0].id;
      const binned = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'בסל') returning id", [org])).rows[0].id;
      return { deal, contact, binned };
    });
    const theirs = await asUser(m2.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'של m2') returning id", [org])).rows[0].id,
    );
    await asUser(admin.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [mine.binned]));

    // the role comes from the business's list (role_id); the old code is the server's only
    const roleIds = await asAdmin(async (q) =>
      Object.fromEntries((await q<{ key: string; id: string }>("select key, id from public.deal_contact_roles where organization_id = $1 and key is not null", [org])).rows.map((r) => [r.key, r.id])),
    );
    const link = (contactId: string, role: string | null) => (q: Query) =>
      q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role_id) values ($1, $2, $3, $4)", [org, mine.deal, contactId, role ? roleIds[role] : null]);

    // the deal's owner links a contact they read, with one of the four roles
    await asUser(m1.id, link(mine.contact, "decision_maker"));
    // not a contact they cannot read, nor one in the recycle bin, nor an unknown role
    expect((await pgError(asUser(m1.id, link(theirs, "user")))).code).toBe("42501");
    expect((await pgError(asUser(m1.id, link(mine.binned, "user")))).code).toBe("42501");
    await asAdmin(async (q) => {
      expect((await pgError(q("update public.deal_contacts set role = 'boss' where deal_id = $1", [mine.deal]))).code).toBe("23514");
    });

    // only the role of a link changes; moving it is "remove and add"
    expect(
      (await pgError(asUser(m1.id, (q) => q("update public.deal_contacts set contact_id = $1 where deal_id = $2", [theirs, mine.deal])))).code,
    ).toBe("42501");
    expect(
      (await pgError(asUser(m1.id, (q) => q("update public.deal_contacts set deal_id = deal_id where deal_id = $1", [mine.deal])))).code,
    ).toBe("42501");
    await asUser(m1.id, async (q) => {
      expect((await q("update public.deal_contacts set role_id = $2 where deal_id = $1", [mine.deal, roleIds.finance])).rowCount).toBe(1);
      expect((await q("update public.deal_contacts set role_id = null where deal_id = $1", [mine.deal])).rowCount).toBe(1);
    });

    // an admin reads every contact and may link m2's contact; m1 then sees the link but not the contact
    await asUser(admin.id, link(theirs, "influencer"));
    await asUser(m1.id, async (q) => {
      expect(await count(q, "select 1 from public.deal_contacts where deal_id = $1", [mine.deal])).toBe(2);
      expect(await count(q, "select 1 from public.contacts where id = $1", [theirs])).toBe(0);
    });
    // m2 does not read m1's deal, so none of its contacts either, and cannot touch them
    await asUser(m2.id, async (q) => {
      expect(await count(q, "select 1 from public.deal_contacts where deal_id = $1", [mine.deal])).toBe(0);
      expect((await q("update public.deal_contacts set role = 'user' where deal_id = $1", [mine.deal])).rowCount).toBe(0);
      expect((await q("delete from public.deal_contacts where deal_id = $1", [mine.deal])).rowCount).toBe(0);
    });
    // a viewer reading the deal (visibility org) still changes nothing
    await setVisibility("org");
    await asUser(viewer.id, async (q) => {
      expect(await count(q, "select 1 from public.deal_contacts where deal_id = $1", [mine.deal])).toBe(2);
      expect((await q("update public.deal_contacts set role = 'user' where deal_id = $1", [mine.deal])).rowCount).toBe(0);
      expect((await q("delete from public.deal_contacts where deal_id = $1", [mine.deal])).rowCount).toBe(0);
    });
    // the deal's owner removes the links, also of a contact they do not own
    await asUser(m1.id, async (q) => {
      expect((await q("delete from public.deal_contacts where deal_id = $1", [mine.deal])).rowCount).toBe(2);
    });
  });

  it("product lines follow the deal: readers read, editors write, nobody writes in the recycle bin (DLI-01)", async () => {
    await setVisibility("own");
    const pipe = await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const s = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 order by position limit 1", [p])).rows[0].id;
      return { p, s };
    });
    const deal = await asUser(m1.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, team_id) values ($1, 'עסקת שורות', $2, $3, $4) returning id", [
          org,
          pipe.p,
          pipe.s,
          team,
        ])
      ).rows[0].id,
    );
    const addLine = (description: string) => (q: Query) =>
      q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot) values ($1, $2, $3, 1, 1000)", [org, deal, description]);

    // the deal's owner, the manager of its team and an admin write lines
    await asUser(m1.id, addLine("של m1"));
    await asUser(manager.id, addLine("של המנהל"));
    await asUser(admin.id, addLine("של מנהל המערכת"));
    // m2 and the viewer do not read the deal (visibility own), so neither its lines
    for (const u of [m2, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.deal_lines where deal_id = $1", [deal]), u.email).toBe(0);
        expect((await q("update public.deal_lines set quantity = 5 where deal_id = $1", [deal])).rowCount).toBe(0);
        expect((await q("delete from public.deal_lines where deal_id = $1", [deal])).rowCount).toBe(0);
      });
      expect((await pgError(asUser(u.id, addLine("פולש")))).code).toBe("42501");
    }
    // visibility org: they read the lines, and still change nothing
    await setVisibility("org");
    for (const u of [m2, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.deal_lines where deal_id = $1", [deal]), u.email).toBe(3);
        expect((await q("update public.deal_lines set quantity = 5 where deal_id = $1", [deal])).rowCount).toBe(0);
        expect((await q("delete from public.deal_lines where deal_id = $1", [deal])).rowCount).toBe(0);
      });
      expect((await pgError(asUser(u.id, addLine("פולש")))).code).toBe("42501");
    }
    // the server's columns are not the client's
    for (const set of ["total_agorot = 1", "price_includes_vat = true", "price_list_name = 'x'", "deal_id = deal_id", "product_id = null"]) {
      expect((await pgError(asUser(m1.id, (q) => q(`update public.deal_lines set ${set} where deal_id = $1`, [deal])))).code, set).toBe("42501");
    }
    await asUser(m1.id, async (q) => {
      expect((await q("update public.deal_lines set quantity = 2 where deal_id = $1", [deal])).rowCount).toBe(3);
    });
    // in the recycle bin the lines stay readable and frozen
    await asUser(admin.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    for (const u of [m1, admin]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.deal_lines where deal_id = $1", [deal])).toBe(3);
        expect((await q("update public.deal_lines set quantity = 3 where deal_id = $1", [deal])).rowCount).toBe(0);
        expect((await q("delete from public.deal_lines where deal_id = $1", [deal])).rowCount).toBe(0);
      });
      expect((await pgError(asUser(u.id, addLine("בסל")))).code).toBe("42501");
    }
    // restored, its owner removes them
    await asUser(admin.id, (q) => q("update public.deals set deleted_at = null where id = $1", [deal]));
    await asUser(m1.id, async (q) => {
      expect((await q("delete from public.deal_lines where deal_id = $1", [deal])).rowCount).toBe(3);
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

  it("everyone reads the rest days; only owners and admins set them (CAL-03)", async () => {
    const insert = "insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{6}')";
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q(insert, [org])))).code, u.email).toBe("42501");
    }
    await asUser(admin.id, (q) => q(insert, [org]));
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.org_calendar_settings where organization_id = $1", [org]), u.email).toBe(1);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.org_calendar_settings set holidays_rest = false where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.org_calendar_settings where organization_id = $1", [org])).rowCount).toBe(0);
      });
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.org_calendar_settings set rest_weekdays = '{5,6}' where organization_id = $1", [org])).rowCount).toBe(1);
    });
    const row = await asAdmin(async (q) =>
      (await q<{ rest_weekdays: number[]; holidays_rest: boolean }>("select rest_weekdays, holidays_rest from public.org_calendar_settings where organization_id = $1", [org])).rows[0],
    );
    expect(row).toEqual({ rest_weekdays: [5, 6], holidays_rest: true });
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.org_calendar_settings where organization_id = $1", [org])).rowCount).toBe(1);
    });
  });

  it("leave: everyone reads it; each role writes its own; the owner anyone's, an admin all but the owner's (CAP-09)", async () => {
    const add = (actor: U, user: U) =>
      asUser(actor.id, async (q) =>
        (await q<{ id: string }>("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-12-01', '2026-12-02') returning id", [org, user.id])).rows[0].id,
      );
    const ids: Record<string, string> = {};
    for (const u of [owner, admin, manager, m1, viewer]) ids[u.id] = await add(u, u);
    // a manager or a member never for someone else, not even their own team
    for (const [actor, target] of [[manager, m1], [m1, m2], [viewer, m1], [m1, owner]] as const) {
      expect((await pgError(add(actor, target))).code, actor.email).toBe("42501");
    }
    ids.byAdmin = await add(admin, m2);
    ids.byOwner = await add(owner, admin);
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.member_leaves where organization_id = $1", [org]), u.email).toBe(7);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        // only their own row changes
        expect((await q("update public.member_leaves set ends_on = '2026-12-03' where organization_id = $1", [org])).rowCount, u.email).toBe(1);
        expect((await q("delete from public.member_leaves where organization_id = $1 and id <> $2", [org, ids[u.id]])).rowCount, u.email).toBe(0);
      });
    }
    // an admin: everyone's but the owner's (and other admins', none here besides themselves)
    await asUser(admin.id, async (q) => {
      expect((await q("update public.member_leaves set ends_on = '2026-12-04' where organization_id = $1", [org])).rowCount).toBe(6);
      expect((await q("delete from public.member_leaves where organization_id = $1", [org])).rowCount).toBe(6);
    });
    expect((await pgError(add(admin, owner))).code).toBe("42501");
    await asUser(owner.id, async (q) => {
      expect((await q("delete from public.member_leaves where organization_id = $1", [org])).rowCount).toBe(1);
    });
  });

  it("a deputy reads the absent colleague's unanswered lead and task, only during the absence, even under 'own' (HEB-08)", async () => {
    await setVisibility("own");
    const lead = await insertLead(owner.id, org, { full_name: "ליד שמחכה", owner_id: m2.id });
    const task = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'לחזור', $2) returning id", [org, m2.id])).rows[0].id,
    );
    const leave = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date - 1, current_date + 1, 'reserve', $3) returning id", [org, m2.id, m1.id])).rows[0].id,
    );
    const seesTask = (u: U) => asUser(u.id, async (q) => (await count(q, "select 1 from public.tasks where id = $1", [task])) === 1);
    expect(await sees(m1.id, lead)).toBe(true);
    expect(await seesTask(m1)).toBe(true);
    for (const u of [manager, viewer]) {
      expect(await sees(u.id, lead), u.email).toBe(false);
      expect(await seesTask(u), u.email).toBe(false);
    }
    // the deputy works the task but does not hand it over
    await asUser(m1.id, async (q) => {
      expect((await q("update public.tasks set title = 'לחזור מחר' where id = $1 returning id", [task])).rowCount).toBe(1);
    });
    expect((await pgError(asUser(m1.id, (q) => q("update public.tasks set owner_id = $2 where id = $1", [task, m1.id])))).hint).toBe("task:deputy_owner");
    // the absence ended: nothing any more
    await asAdmin((q) => q("update public.member_leaves set starts_on = current_date - 5, ends_on = current_date - 3 where id = $1", [leave]));
    expect(await sees(m1.id, lead)).toBe(false);
    expect(await seesTask(m1)).toBe(false);
    await asUser(owner.id, (q) => q("delete from public.member_leaves where id = $1", [leave]));
  });

  it("everyone reads the VAT status; only owners and admins set it (TAX-01)", async () => {
    const insert = "insert into public.org_document_settings (organization_id, vat_status) values ($1, 'exempt')";
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q(insert, [org])))).code, u.email).toBe("42501");
    }
    await asUser(admin.id, (q) => q(insert, [org]));
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.org_document_settings where organization_id = $1", [org]), u.email).toBe(1);
        expect((await q<{ v: boolean }>("select app.org_charges_vat($1) as v", [org])).rows[0].v, u.email).toBe(false);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.org_document_settings where organization_id = $1", [org])).rowCount).toBe(0);
      });
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org])).rowCount).toBe(1);
    });
    expect(
      await asAdmin(async (q) => (await q<{ vat_status: string }>("select vat_status from public.org_document_settings where organization_id = $1", [org])).rows[0].vat_status),
    ).toBe("licensed");
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.org_document_settings where organization_id = $1", [org])).rowCount).toBe(1);
    });
  });

  it("everyone reads the response target; only owners and admins set it, and the reports follow it (CAP-10)", async () => {
    const insert = "insert into public.lead_response_settings (organization_id, target_minutes) values ($1, 30)";
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q(insert, [org])))).code, u.email).toBe("42501");
    }
    await asUser(admin.id, (q) => q(insert, [org]));
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.lead_response_settings where organization_id = $1", [org]), u.email).toBe(1);
        expect((await q<{ t: number }>("select app.response_target_minutes($1) as t", [org])).rows[0].t, u.email).toBe(30);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.lead_response_settings set target_minutes = 90 where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.lead_response_settings where organization_id = $1", [org])).rowCount).toBe(0);
      });
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.lead_response_settings set target_minutes = 90 where organization_id = $1", [org])).rowCount).toBe(1);
    });
    expect(
      await asAdmin(async (q) => (await q<{ t: number }>("select target_minutes as t from public.lead_response_settings where organization_id = $1", [org])).rows[0].t),
    ).toBe(90);
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.lead_response_settings where organization_id = $1", [org])).rowCount).toBe(1);
      // no row: the initial 60
      expect((await q<{ t: number }>("select app.response_target_minutes($1) as t", [org])).rows[0].t).toBe(60);
    });
  });

  it("everyone reads the number series; only owners and admins set prefix and start; nobody deletes it (QUO-03)", async () => {
    const insert = "insert into public.number_sequences (organization_id, kind, prefix, start_number) values ($1, 'quote', 'Q-', 100)";
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q(insert, [org])))).code, u.email).toBe("42501");
    }
    await asUser(admin.id, (q) => q(insert, [org]));
    for (const u of [owner, admin, manager, m1, viewer]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.number_sequences where organization_id = $1", [org])), u.email).toBe(1);
    }
    for (const u of [manager, m1, viewer]) {
      expect(await asUser(u.id, async (q) => (await q("update public.number_sequences set prefix = 'X' where organization_id = $1", [org])).rowCount), u.email).toBe(0);
    }
    for (const u of [owner, admin, manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q("delete from public.number_sequences where organization_id = $1", [org])))).code, u.email).toBe("42501");
    }
    expect(await asUser(owner.id, async (q) => (await q("update public.number_sequences set start_number = 200 where organization_id = $1", [org])).rowCount)).toBe(1);
    expect(await asAdmin(async (q) => (await q<{ p: string; s: string }>("select prefix as p, start_number as s from public.number_sequences where organization_id = $1", [org])).rows[0])).toEqual({
      p: "Q-",
      s: "200",
    });
  });

  it("everyone reads the lead distribution settings and rules; only owners and admins change them (CAP-08)", async () => {
    // the plan key is opened here, whatever the business's plan
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"lead_distribution\": true}' where organization_id = $1", [org]),
    );
    const team = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'חלוקה') returning id", [org])).rows[0].id);
    const source = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'מקור חלוקה') returning id", [org])).rows[0].id);
    const settings = "insert into public.lead_distribution_settings (organization_id, method) values ($1, 'load')";
    const rule = "insert into public.lead_routing_rules (organization_id, source_id, team_id) values ($1, $2, $3)";
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q(settings, [org])))).code, u.email).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q(rule, [org, source, team])))).code, u.email).toBe("42501");
    }
    await asUser(admin.id, (q) => q(settings, [org]));
    await asUser(owner.id, (q) => q(rule, [org, source, team]));
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.lead_distribution_settings where organization_id = $1", [org]), u.email).toBe(1);
        expect(await count(q, "select 1 from public.lead_routing_rules where organization_id = $1", [org]), u.email).toBe(1);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.lead_distribution_settings set method = 'weighted' where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.lead_distribution_settings where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("update public.lead_routing_rules set is_active = false where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.lead_routing_rules where organization_id = $1", [org])).rowCount).toBe(0);
      });
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.lead_distribution_settings set method = 'weighted' where organization_id = $1", [org])).rowCount).toBe(1);
      expect((await q("update public.lead_routing_rules set position = 3 where organization_id = $1", [org])).rowCount).toBe(1);
    });
    expect(
      await asAdmin(async (q) => (await q<{ m: string }>("select method as m from public.lead_distribution_settings where organization_id = $1", [org])).rows[0].m),
    ).toBe("weighted");
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.lead_routing_rules where organization_id = $1", [org])).rowCount).toBe(1);
      expect((await q("delete from public.lead_distribution_settings where organization_id = $1", [org])).rowCount).toBe(1);
    });
    await asAdmin(async (q) => {
      await q("delete from public.teams where id = $1", [team]);
      await q("update public.subscriptions set feature_overrides = feature_overrides - 'lead_distribution' where organization_id = $1", [org]);
    });
  });

  it("everyone reads the important fields; only owners and admins change them (DQL-01)", async () => {
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.completeness_settings where organization_id = $1", [org]), u.email).toBe(4);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.completeness_settings set fields = '{phone}' where organization_id = $1 and object_type = 'lead'", [org])).rowCount, u.email).toBe(0);
      });
      expect((await pgError(asUser(u.id, (q) => q("delete from public.completeness_settings where organization_id = $1", [org])))).code, u.email).toBe("42501");
    }
    for (const u of [owner, admin]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.completeness_settings set fields = '{phone,owner_id}' where organization_id = $1 and object_type = 'lead'", [org])).rowCount, u.email).toBe(1);
      });
    }
    expect(
      await asAdmin(async (q) => (await q<{ fields: string[] }>("select fields from public.completeness_settings where organization_id = $1 and object_type = 'lead'", [org])).rows[0].fields),
    ).toEqual(["phone", "owner_id"]);
    await asUser(owner.id, (q) => q("update public.completeness_settings set fields = app.completeness_default_keys('lead') where organization_id = $1 and object_type = 'lead'", [org]));
  });

  it("extra permissions: owners and admins grant and read all; a member reads only their own; nobody writes the table (PRM-01)", async () => {
    const set = (by: string, user: string, keys: string) => asUser(by, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, user, keys]));
    await set(owner.id, m1.id, "{export}");
    await set(admin.id, manager.id, "{import}");
    for (const u of [manager, m1, m2, viewer]) {
      expect((await pgError(set(u.id, m2.id, "{export}"))).code, u.email).toBe("42501");
    }
    expect((await pgError(set(owner.id, viewer.id, "{export}"))).hint).toBe("permissions:role");
    for (const u of [owner, admin]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.member_permissions where organization_id = $1", [org])), u.email).toBe(2);
    }
    for (const [u, n] of [[manager, 1], [m1, 1], [m2, 0], [viewer, 0]] as const) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.member_permissions where organization_id = $1", [org])), u.email).toBe(n);
    }
    for (const u of [owner, admin, manager, m1]) {
      expect((await pgError(asUser(u.id, (q) => q("update public.member_permissions set permissions = '{}' where organization_id = $1", [org])))).code, u.email).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("delete from public.member_permissions where organization_id = $1", [org])))).code, u.email).toBe("42501");
    }
    await set(owner.id, m1.id, "{}");
    await set(owner.id, manager.id, "{}");
  });

  it("everyone reads the card layout; only owners and admins write it, and nobody deletes it (FLD-08)", async () => {
    const layout = JSON.stringify([{ title: "קשר", columns: 2, fields: ["phone", "email"] }]);
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q("insert into public.card_layouts (organization_id, object_type, groups) values ($1, 'contact', $2)", [org, layout])))).code, u.email).toBe(
        "42501",
      );
    }
    await asUser(admin.id, (q) => q("insert into public.card_layouts (organization_id, object_type, groups) values ($1, 'contact', $2)", [org, layout]));
    for (const u of [owner, admin, manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.card_layouts where organization_id = $1 and object_type = 'contact'", [org]), u.email).toBe(1);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.card_layouts set groups = '[]' where organization_id = $1", [org])).rowCount, u.email).toBe(0);
      });
    }
    for (const u of [owner, admin, manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q("delete from public.card_layouts where organization_id = $1", [org])))).code, u.email).toBe("42501");
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.card_layouts set groups = '[]' where organization_id = $1 and object_type = 'contact'", [org])).rowCount).toBe(1);
    });
    expect(
      await asAdmin(async (q) => (await q<{ g: unknown }>("select groups as g from public.card_layouts where organization_id = $1 and object_type = 'contact'", [org])).rows[0].g),
    ).toEqual([]);
  });

  it("only owners and admins read and write the bank details (TAX-02 follow-up)", async () => {
    const insert = "insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account) values ($1, 'בנק לאומי', '800', '7654321')";
    for (const u of [manager, m1, viewer]) {
      expect((await pgError(asUser(u.id, (q) => q(insert, [org])))).code, u.email).toBe("42501");
    }
    await asUser(admin.id, (q) => q(insert, [org]));
    for (const u of [owner, admin]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.org_bank_details where organization_id = $1", [org]), u.email).toBe(1);
      });
    }
    for (const u of [manager, m1, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.org_bank_details where organization_id = $1", [org]), u.email).toBe(0);
        expect((await q("update public.org_bank_details set bank_branch = '1' where organization_id = $1", [org])).rowCount, u.email).toBe(0);
        expect((await q("delete from public.org_bank_details where organization_id = $1", [org])).rowCount, u.email).toBe(0);
      });
    }
    await asUser(owner.id, async (q) => {
      expect((await q("update public.org_bank_details set bank_branch = '801' where organization_id = $1", [org])).rowCount).toBe(1);
    });
    expect(
      await asAdmin(async (q) => (await q<{ bank_branch: string }>("select bank_branch from public.org_bank_details where organization_id = $1", [org])).rows[0].bank_branch),
    ).toBe("801");
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.org_bank_details where organization_id = $1", [org])).rowCount).toBe(1);
    });
  });

  it("meetings follow the record they are about; organizer, creator and participants always see them (CAL-01)", async () => {
    await setVisibility("own");
    const lead = await insertLead(m1.id, org, { full_name: "ליד לפגישה", team_id: team });
    const meetingSql =
      "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, $2, now() + interval '1 day', now() + interval '1 day 1 hour', $3) returning id, owner_id";
    const onLead = await asUser(m1.id, async (q) => (await q<{ id: string; owner_id: string }>(meetingSql, [org, "פגישה על ליד", lead])).rows[0]);
    expect(onLead.owner_id).toBe(m1.id);
    const internal = await asUser(m1.id, async (q) => (await q<{ id: string }>(meetingSql, [org, "פגישה פנימית", null])).rows[0].id);

    const seesMeeting = (userId: string, id: string) =>
      asUser(userId, async (q) => (await count(q, "select 1 from public.meetings where id = $1", [id])) === 1);
    expect(await seesMeeting(m2.id, onLead.id)).toBe(false);
    expect(await seesMeeting(viewer.id, onLead.id)).toBe(false);
    expect(await seesMeeting(manager.id, onLead.id)).toBe(true); // manages the lead's team
    expect(await seesMeeting(admin.id, onLead.id)).toBe(true);
    // no record, but the organizer is in the team he manages (owner's answer, 12 October 2026; 0093)
    expect(await seesMeeting(manager.id, internal)).toBe(true);
    expect(await seesMeeting(m2.id, internal)).toBe(false);
    expect(await seesMeeting(admin.id, internal)).toBe(true);

    // a meeting on a record one cannot see is refused
    const blocked = await pgError(asUser(m2.id, (q) => q(meetingSql, [org, "x", lead])));
    expect(blocked.code).toBe("42501");
    // a viewer sets up nothing
    const byViewer = await pgError(asUser(viewer.id, (q) => q(meetingSql, [org, "x", null])));
    expect(byViewer.code).toBe("42501");

    // the record's editors edit its meetings; others do not. The manager of the
    // organizer's team edits the internal one too (owner's answer, 12 October 2026; 0097)
    await asUser(manager.id, async (q) => {
      expect((await q("update public.meetings set outcome = 'סוכם המשך' where id = $1", [onLead.id])).rowCount).toBe(1);
      expect((await q("update public.meetings set outcome = 'x' where id = $1", [internal])).rowCount).toBe(1);
    });
    await asUser(m2.id, async (q) => {
      expect((await q("update public.meetings set status = 'held' where id = $1", [onLead.id])).rowCount).toBe(0);
    });

    // adding a participant is editing the meeting: m2 may not, m1 may
    const notEditor = await pgError(
      asUser(m2.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, onLead.id, m2.id])),
    );
    expect(notEditor.code).toBe("42501");
    await asUser(m1.id, (q) =>
      q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3), ($1, $4, $3)", [org, onLead.id, m2.id, internal]),
    );
    // a participant sees the meeting and who comes, and records how it went
    expect(await seesMeeting(m2.id, onLead.id)).toBe(true);
    expect(await seesMeeting(m2.id, internal)).toBe(true);
    await asUser(m2.id, async (q) => {
      expect(await count(q, "select 1 from public.meeting_participants where meeting_id = $1", [onLead.id])).toBe(1);
      expect((await q("update public.meetings set status = 'held', outcome = 'נסגר' where id = $1", [onLead.id])).rowCount).toBe(1);
      // ...but cannot delete what someone else set up
      expect((await q("delete from public.meetings where id = $1", [onLead.id])).rowCount).toBe(0);
    });
    // a viewer participant sees it and still writes nothing
    await asUser(m1.id, (q) =>
      q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, internal, viewer.id]),
    );
    expect(await seesMeeting(viewer.id, internal)).toBe(true);
    await asUser(viewer.id, async (q) => {
      expect((await q("update public.meetings set status = 'cancelled' where id = $1", [internal])).rowCount).toBe(0);
    });

    // a member cannot move a meeting onto a record they cannot see
    const hidden = await insertLead(admin.id, org, { full_name: "ליד של מנהלת" });
    const moved = await pgError(asUser(m1.id, (q) => q("update public.meetings set lead_id = $1 where id = $2", [hidden, internal])));
    expect(moved.code).toBe("42501");

    // a read-only organization keeps its meetings readable and frozen
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    await asUser(m1.id, async (q) => {
      expect(await count(q, "select 1 from public.meetings where id = $1", [onLead.id])).toBe(1);
      expect((await q("update public.meetings set title = 'y' where id = $1", [onLead.id])).rowCount).toBe(0);
      expect((await q("delete from public.meetings where id = $1", [internal])).rowCount).toBe(0);
    });
    await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));

    // the creator removes a meeting set up by mistake; its participants go with it
    await asUser(m1.id, async (q) => {
      expect((await q("delete from public.meetings where id = $1", [internal])).rowCount).toBe(1);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.meeting_participants where meeting_id = $1", [internal]))).toBe(0);
    await setVisibility("org");
  });

  it("a meeting's organizer changes only by the organizer, its creator or an owner/admin (CAL-01)", async () => {
    const lead = await insertLead(m1.id, org, { full_name: "ליד להעברת פגישה", team_id: team });
    const id = await asUser(m1.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישה להעברה', now() + interval '1 day', now() + interval '1 day 1 hour', $2) returning id",
          [org, lead],
        )
      ).rows[0].id,
    );
    await asUser(m1.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, id, m2.id]));
    const organizer = () => asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.meetings where id = $1", [id])).rows[0].owner_id);

    // a participant edits the meeting but cannot make themselves its organizer
    const grab = await pgError(asUser(m2.id, (q) => q("update public.meetings set owner_id = $1 where id = $2", [m2.id, id])));
    expect(grab.code).toBe("42501");
    // the manager of the lead's team is neither organizer nor creator: he edits the meeting, but cannot take it
    await asUser(manager.id, async (q) => {
      expect((await q("update public.meetings set outcome = 'מנהל' where id = $1", [id])).rowCount).toBe(1);
    });
    const byManager = await pgError(asUser(manager.id, (q) => q("update public.meetings set owner_id = $1 where id = $2", [manager.id, id])));
    expect(byManager.code).toBe("42501");
    // not in two steps either: first linking it to a lead of their own, then taking it
    const ownLead = await insertLead(m2.id, org, { full_name: "ליד של m2 לעקיפה" });
    await asUser(m2.id, async (q) => {
      expect((await q("update public.meetings set lead_id = $1 where id = $2", [ownLead, id])).rowCount).toBe(1);
    });
    const twoStep = await pgError(asUser(m2.id, (q) => q("update public.meetings set owner_id = $1, lead_id = null where id = $2", [m2.id, id])));
    expect(twoStep.code).toBe("42501");
    expect(await organizer()).toBe(m1.id);

    // the organizer hands it over; nobody may leave it without one
    await asUser(m1.id, async (q) => {
      expect((await q("update public.meetings set owner_id = $1 where id = $2", [m2.id, id])).rowCount).toBe(1);
    });
    expect(await organizer()).toBe(m2.id);
    const toNobody = await pgError(asUser(m2.id, (q) => q("update public.meetings set owner_id = null where id = $1", [id])));
    expect(toNobody.code).toBe("23503");
    // a viewer cannot be the organizer
    const toViewer = await pgError(asUser(m2.id, (q) => q("update public.meetings set owner_id = $1 where id = $2", [viewer.id, id])));
    expect(toViewer.code).toBe("23503");

    // the creator takes it back, and an admin can move it too
    await asUser(m1.id, async (q) => {
      expect((await q("update public.meetings set owner_id = $1 where id = $2", [m1.id, id])).rowCount).toBe(1);
    });
    await asUser(admin.id, async (q) => {
      expect((await q("update public.meetings set owner_id = $1 where id = $2", [manager.id, id])).rowCount).toBe(1);
    });
    expect(await organizer()).toBe(manager.id);

    // on a new meeting a member is the organizer themself; an admin may name someone else
    const insertFor = (actor: string, ownerId: string) =>
      asUser(actor, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, owner_id) values ($1, 'x', now(), now() + interval '1 hour', $2)", [org, ownerId]),
      );
    expect((await pgError(insertFor(m1.id, m2.id))).code).toBe("42501");
    expect((await insertFor(m1.id, m1.id)).rowCount).toBe(1);
    expect((await insertFor(admin.id, m2.id)).rowCount).toBe(1);
    expect((await pgError(insertFor(admin.id, viewer.id))).code).toBe("23503");
  });

  it("a contact's further phones and emails follow the contact: who reads it reads them, who edits it changes them (CON-01)", async () => {
    await setVisibility("own");
    const contact = await asUser(m1.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, team_id) values ($1, 'איש של m1', $2) returning id", [org, team])).rows[0].id,
    );
    const add = (u: U, value: string) =>
      asUser(u.id, (q) =>
        q<{ id: string }>("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', $3) returning id", [org, contact, value]),
      );
    const mine = (await add(m1, "052-1110001")).rows[0].id;
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.contact_channels where contact_id = $1", [contact]));
    const relabel = (u: U) => asUser(u.id, async (q) => (await q("update public.contact_channels set label = 'work' where id = $1", [mine])).rowCount);

    // a colleague who cannot see the contact sees, adds and changes nothing
    expect(await seen(m2)).toBe(0);
    expect((await pgError(add(m2, "052-1110002"))).code).toBe("42501");
    expect(await relabel(m2)).toBe(0);
    await asUser(m2.id, async (q) => expect((await q("delete from public.contact_channels where id = $1", [mine])).rowCount).toBe(0));
    // the team's manager and an admin do
    expect(await seen(manager)).toBe(1);
    expect(await relabel(manager)).toBe(1);
    expect((await add(manager, "052-1110003")).rowCount).toBe(1);
    expect(await seen(admin)).toBe(2);

    // reading is not editing: with visibility "org" a colleague and a viewer read, and change nothing
    await setVisibility("org");
    for (const u of [m2, viewer]) {
      expect(await seen(u), u.email).toBe(2);
      expect((await pgError(add(u, "052-1110004"))).code, u.email).toBe("42501");
      expect(await relabel(u), u.email).toBe(0);
      await asUser(u.id, async (q) => expect((await q("delete from public.contact_channels where id = $1", [mine])).rowCount, u.email).toBe(0));
    }

    // a read-only organization keeps them readable and unchanged
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await seen(m1)).toBe(2);
      expect((await pgError(add(m1, "052-1110005"))).code).toBe("42501");
      expect(await relabel(m1)).toBe(0);
      await asUser(m1.id, async (q) => expect((await q("delete from public.contact_channels where id = $1", [mine])).rowCount).toBe(0));
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    await asUser(m1.id, async (q) => expect((await q("delete from public.contact_channels where id = $1", [mine])).rowCount).toBe(1));
  });

  it("a contact's companies follow the contact, and a new link needs a company the person reads (CON-05)", async () => {
    await setVisibility("own");
    const [contact, ownCompany, otherCompany] = await asUser(m1.id, async (q) => {
      const c = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, team_id) values ($1, 'עובדת של m1', $2) returning id", [org, team])).rows[0].id;
      const a = (await q<{ id: string }>("insert into public.companies (organization_id, name, team_id) values ($1, 'חברה של m1', $2) returning id", [org, team])).rows[0].id;
      return [c, a];
    }).then(async ([c, a]) => [c, a, await asUser(m2.id, async (q) => (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה של m2') returning id", [org])).rows[0].id)]);
    const add = (u: U, company: string, title = "שותפה") =>
      asUser(u.id, (q) =>
        q<{ id: string }>("insert into public.contact_companies (organization_id, contact_id, company_id, title) values ($1, $2, $3, $4) returning id", [org, contact, company, title]),
      );
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.contact_companies where contact_id = $1", [contact]));
    const retitle = (u: U, id: string) => asUser(u.id, async (q) => (await q("update public.contact_companies set title = 'מנכ\"לית' where id = $1", [id])).rowCount);
    const remove = (u: U, id: string) => asUser(u.id, async (q) => (await q("delete from public.contact_companies where id = $1", [id])).rowCount);

    // a company m1 cannot read cannot be linked; their own can
    expect((await pgError(add(m1, otherCompany))).code).toBe("42501");
    const mine = (await add(m1, ownCompany)).rows[0].id;
    // a colleague who cannot see the contact sees, adds and changes nothing
    expect(await seen(m2)).toBe(0);
    expect((await pgError(add(m2, otherCompany))).code).toBe("42501");
    expect(await retitle(m2, mine)).toBe(0);
    expect(await remove(m2, mine)).toBe(0);
    // the team's manager and an admin do; a link shows only to someone who reads the company too
    expect(await seen(manager)).toBe(1);
    expect(await retitle(manager, mine)).toBe(1);
    const theirs = (await add(admin, otherCompany)).rows[0].id;
    expect(await seen(admin)).toBe(2);
    expect(await seen(manager)).toBe(1);
    expect(await seen(m1)).toBe(1);

    // reading is not editing: with visibility "org" a colleague and a viewer read, and change nothing
    await setVisibility("org");
    for (const u of [m2, viewer]) {
      expect(await seen(u), u.email).toBe(2);
      expect((await pgError(add(u, otherCompany))).code, u.email).toBe("42501");
      expect(await retitle(u, mine), u.email).toBe(0);
      expect(await remove(u, mine), u.email).toBe(0);
    }

    // a read-only organization keeps them readable and unchanged
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await seen(m1)).toBe(2);
      expect(await retitle(m1, mine)).toBe(0);
      expect(await remove(m1, theirs)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    expect(await remove(m1, theirs)).toBe(1);
    expect(await remove(m1, mine)).toBe(1);
  });

  it("a relation between two contacts is seen by whoever reads both and made or removed by whoever edits one of them (CON-06)", async () => {
    await setVisibility("own");
    const make = (u: U, name: string, teamId: string | null) =>
      asUser(u.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, team_id) values ($1, $2, $3) returning id", [org, name, teamId])).rows[0].id);
    const [mine, theirs] = [await make(m1, "של m1", team), await make(m2, "של m2", null)];
    const spouse = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'spouse'", [org])).rows[0].id);
    const add = (u: U) =>
      asUser(u.id, (q) =>
        q<{ id: string }>("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4) returning id", [org, mine, theirs, spouse]),
      );
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.contact_relations where contact_id = $1", [mine]));
    const remove = (u: U) => asUser(u.id, async (q) => (await q("delete from public.contact_relations where contact_id = $1", [mine])).rowCount);

    // m1 edits their contact but cannot read m2's: no relation
    expect((await pgError(add(m1))).code).toBe("42501");
    // an admin makes it; only someone who reads both sees it
    expect((await add(admin)).rowCount).toBe(1);
    expect(await seen(admin)).toBe(1);
    for (const u of [m1, m2, manager]) expect(await seen(u), u.email).toBe(0);
    expect(await remove(m1)).toBe(0);

    // visibility "org": everyone reads both; a viewer changes nothing; m2 (who edits one of them) removes it
    await setVisibility("org");
    for (const u of [m1, m2, viewer]) expect(await seen(u), u.email).toBe(1);
    expect((await pgError(asUser(viewer.id, (q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $3, $2, $4)", [org, mine, theirs, spouse])))).code).toBe("42501");
    expect(await remove(viewer)).toBe(0);
    // no update at all: a relation is removed and added again
    expect((await pgError(asUser(admin.id, (q) => q("update public.contact_relations set type_id = type_id where contact_id = $1", [mine])))).code).toBe("42501");

    // a read-only organization keeps it readable and unchanged
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await seen(m2)).toBe(1);
      expect(await remove(m2)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    expect(await remove(m2)).toBe(1);
    // and m1 may now make it themselves (they edit one side and read the other)
    expect((await add(m1)).rowCount).toBe(1);
    expect(await remove(m1)).toBe(1);
  });

  it("a lead's referral follows the lead's own rights on its side and the contact's on the other (CON-06)", async () => {
    await setVisibility("own");
    const lead = await insertLead(m1.id, org, { phone: "052-1130001", team_id: team });
    const contact = await asUser(m2.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'הופנתה על ידי ליד') returning id", [org])).rows[0].id,
    );
    const mine = await asUser(m1.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, team_id) values ($1, 'של m1', $2) returning id", [org, team])).rows[0].id,
    );
    const referral = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'referral'", [org])).rows[0].id);
    const add = (u: U, leadId = lead, contactId = contact) =>
      asUser(u.id, (q) =>
        q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, leadId, contactId, referral]),
      );
    const seen = (u: U, leadId = lead) => asUser(u.id, (q) => count(q, "select 1 from public.contact_relations where lead_id = $1", [leadId]));
    const remove = (u: U, leadId = lead) => asUser(u.id, async (q) => (await q("delete from public.contact_relations where lead_id = $1", [leadId])).rowCount);

    // m1 edits the lead but cannot read m2's contact; m2 edits the contact but cannot read m1's lead
    expect((await pgError(add(m1))).code).toBe("42501");
    expect((await pgError(add(m2))).code).toBe("42501");
    // an admin makes it; only someone who reads both sides sees it, and neither side alone removes it
    expect((await add(admin)).rowCount).toBe(1);
    expect(await seen(admin)).toBe(1);
    for (const u of [m1, m2, manager]) expect(await seen(u), u.email).toBe(0);
    expect(await remove(m1)).toBe(0);
    expect(await remove(m2)).toBe(0);
    // a DELETE with no WHERE is filtered by the delete policy alone: m2 edits the contact but cannot read the lead
    await asUser(m2.id, (q) => q("delete from public.contact_relations"));
    expect(await seen(admin)).toBe(1);

    // visibility "org": everyone reads both sides; a viewer changes nothing
    await setVisibility("org");
    for (const u of [m1, m2, viewer]) expect(await seen(u), u.email).toBe(1);
    expect(await remove(viewer)).toBe(0);
    // m2 reads m1's lead and m1's contact but edits neither: no new referral, no removal of one
    expect((await pgError(add(m2, lead, mine))).code).toBe("42501");
    await asUser(m1.id, (q) => q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, lead, mine, referral]));
    expect(await asUser(m2.id, async (q) => (await q("delete from public.contact_relations where lead_id = $1 and related_contact_id = $2", [lead, mine])).rowCount)).toBe(0);
    // m1 edits the lead: removes both; m2 edits the contact: adds it back and removes it
    expect(await remove(m1)).toBe(2);
    expect((await add(m2)).rowCount).toBe(1);
    expect(await remove(m2)).toBe(1);

    // a lead in the recycle bin: no new referral; the side in the bin no longer gives the right to remove one
    const binned = await insertLead(m1.id, org, { phone: "052-1130002", team_id: team });
    await add(admin, binned);
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(add(m1, binned, mine))).code).toBe("42501");
    expect(await remove(m1, binned)).toBe(0);
    // a converted lead takes no new referral (its referrals moved to its contact)
    const converted = await insertLead(m1.id, org, { phone: "052-1130003", team_id: team });
    await asAdmin((q) => q("update public.leads set converted_at = now() where id = $1", [converted]));
    expect((await pgError(add(m1, converted, mine))).code).toBe("42501");
    expect((await pgError(add(admin, converted, contact))).code).toBe("42501");
  });

  it("a lead's consents follow the lead: who reads it reads them, who edits it records a new one; nobody changes one (CNS-01)", async () => {
    await setVisibility("own");
    const lead = await insertLead(m1.id, org, { phone: "052-1120001", team_id: team });
    const add = (u: U) =>
      asUser(u.id, (q) =>
        q<{ id: string }>(
          "insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה') returning id",
          [org, lead],
        ),
      );
    const mine = (await add(m1)).rows[0].id;
    const seen = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.consents where lead_id = $1", [lead]));
    const change = (u: U) => pgError(asUser(u.id, (q) => q("update public.consents set state = 'denied' where id = $1", [mine])));
    const remove = (u: U) => pgError(asUser(u.id, (q) => q("delete from public.consents where id = $1", [mine])));

    // a colleague who cannot see the lead sees and records nothing
    expect(await seen(m2)).toBe(0);
    expect((await pgError(add(m2))).code).toBe("42501");
    // the team's manager and an admin read and record
    expect(await seen(manager)).toBe(1);
    expect((await add(manager)).rowCount).toBe(1);
    expect((await add(admin)).rowCount).toBe(1);
    expect(await seen(owner)).toBe(3);

    // reading is not editing: with visibility "org" a colleague and a viewer read, and record nothing
    await setVisibility("org");
    for (const u of [m2, viewer]) {
      expect(await seen(u), u.email).toBe(3);
      expect((await pgError(add(u))).code, u.email).toBe("42501");
    }
    // no role updates or deletes an entry
    for (const u of [owner, admin, manager, m1, m2, viewer]) {
      expect((await change(u)).code, u.email).toBe("42501");
      expect((await remove(u)).code, u.email).toBe("42501");
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

  it("booking pages: each person their own, a team manager their people's, owners and admins all; viewers none (CAL-10)", async () => {
    const type = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 order by position limit 1", [org])).rows[0].id,
    );
    const insert = (by: U, userId: string, title: string) =>
      asUser(by.id, async (q) =>
        (
          await q<{ id: string }>(
            // off: nobody here has working hours, and a page without hours cannot be on (125 tests that)
            "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, is_active) values ($1, $2, $3, $4, false) returning id",
            [org, userId, title, type],
          )
        ).rows[0].id,
      );
    const own = await insert(m1, m1.id, "הדף של m1");
    // a member makes pages for themselves only; an admin for anyone
    expect((await pgError(insert(m1, m2.id, "בשם אחר"))).code).toBe("42501");
    const byAdmin = await insert(admin, m2.id, "הדף של m2");
    // a viewer makes none, and a viewer is no rep
    expect((await pgError(insert(viewer, viewer.id, "צופה"))).code).toBe("42501");
    expect((await pgError(insert(admin, viewer.id, "דף לצופה"))).hint).toBe("booking_page:user");
    const sees = (u: U) => asUser(u.id, async (q) => (await q<{ id: string }>("select id from public.booking_pages where organization_id = $1", [org])).rows.map((r) => r.id));
    expect(await sees(m1)).toEqual([own]);
    expect(await sees(m2)).toEqual([byAdmin]);
    // the manager manages m1's team (owner, 15 October 2026), not m2's
    expect(await sees(manager)).toEqual([own]);
    expect(await sees(viewer)).toEqual([]);
    expect((await sees(admin)).sort()).toEqual([own, byAdmin].sort());
    expect((await sees(owner)).sort()).toEqual([own, byAdmin].sort());
    // writes follow the same line
    expect(await asUser(m2.id, async (q) => (await q("update public.booking_pages set title = 'x' where id = $1", [own])).rowCount)).toBe(0);
    expect(await asUser(m2.id, async (q) => (await q("delete from public.booking_pages where id = $1", [own])).rowCount)).toBe(0);
    expect(await asUser(manager.id, async (q) => (await q("update public.booking_pages set title = 'x' where id = $1", [byAdmin])).rowCount)).toBe(0);
    expect(await asUser(manager.id, async (q) => (await q("update public.booking_pages set title = 'של המנהל' where id = $1", [own])).rowCount)).toBe(1);
    expect(await asUser(m1.id, async (q) => (await q("update public.booking_pages set title = 'הדף שלי' where id = $1", [own])).rowCount)).toBe(1);
    // a member cannot hand their page to someone else
    expect((await pgError(asUser(m1.id, (q) => q("update public.booking_pages set user_id = $2 where id = $1", [own, m2.id])))).code).toBe("42501");
    expect(await asUser(admin.id, async (q) => (await q("update public.booking_pages set is_active = false where id = $1", [own])).rowCount)).toBe(1);
    // the token is the server's
    expect((await pgError(asUser(m1.id, (q) => q("update public.booking_pages set token = 'x' where id = $1", [own])))).code).toBe("42501");
    expect(await asUser(m1.id, async (q) => (await q("delete from public.booking_pages where id = $1", [own])).rowCount)).toBe(1);
    expect(await asUser(admin.id, async (q) => (await q("delete from public.booking_pages where id = $1", [byAdmin])).rowCount)).toBe(1);
  });
});

// "עדכנו אותי כשזה זמין" (migration plan_waitlist): every role asks for itself and
// sees only its own requests; nobody changes or removes them from the browser.
describe("plan waitlist: own rows, every role", () => {
  let owner: U;
  let org: string;
  const people: Record<string, U> = {};

  beforeAll(async () => {
    owner = await createUser("wait-owner");
    org = await createOrg(owner.id);
    people.owner = owner;
    for (const role of ["admin", "manager", "member", "viewer"] as const) {
      people[role] = await addMember(org, owner.id, role, `wait-${role}`);
    }
  });

  it("each role adds and sees only its own request", async () => {
    for (const [role, user] of Object.entries(people)) {
      await asUser(user.id, (q) => q("insert into public.plan_waitlist (organization_id, plan_key) values ($1, 'business')", [org]));
      const seen = await asUser(user.id, (q) => count(q, "select 1 from public.plan_waitlist where organization_id = $1", [org]));
      expect(seen, role).toBe(1);
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.plan_waitlist where organization_id = $1", [org]))).toBe(5);
  });

  it("nobody asks for someone else, changes or removes a request", async () => {
    const forged = await pgError(
      asUser(people.member.id, (q) =>
        q("insert into public.plan_waitlist (organization_id, user_id, plan_key) values ($1, $2, 'business')", [org, people.viewer.id]),
      ),
    );
    expect(forged.code).toBe("42501");
    for (const user of Object.values(people)) {
      expect((await pgError(asUser(user.id, (q) => q("update public.plan_waitlist set plan_key = plan_key where organization_id = $1", [org])))).code).toBe("42501");
      expect((await pgError(asUser(user.id, (q) => q("delete from public.plan_waitlist where organization_id = $1", [org])))).code).toBe("42501");
    }
  });
});
