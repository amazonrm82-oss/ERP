import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string };
type DbError = { code?: string; hint?: string; detail?: string; message: string };

/**
 * FLD (owner, 9 November 2026): owners and admins delete a custom field only while nothing uses it. The database
 * refuses a person's delete of a field in use (trigger field_definitions_delete_guard, hint custom_field:in_use,
 * the reasons in the detail) and tells the page why (public.custom_field_usage, counts only).
 */
describe("deleting a custom field (FLD)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let seq = 0;

  const define = async (object: string, type = "text", extra: { options?: string[]; condition?: unknown; key?: string } = {}) => {
    const key = extra.key ?? `d_${++seq}`;
    const id = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, condition)
           values ($1, $2, $3, $3, $4, $5, $6) returning id`,
          [org, object, key, type, JSON.stringify(extra.options ?? []), extra.condition === undefined ? null : JSON.stringify(extra.condition)],
        )
      ).rows[0].id,
    );
    return { id, key };
  };
  const del = (user: U, id: string) =>
    asUser(user.id, async (q) => (await q("delete from public.field_definitions where organization_id = $1 and id = $2", [org, id])).rowCount);
  const refused = async (id: string, user: U = owner) => (await pgError(del(user, id))) as DbError;
  const exists = (id: string) => asAdmin(async (q) => (await q("select 1 from public.field_definitions where id = $1", [id])).rowCount === 1);
  const reasonsOf = (object: string, id: string) =>
    asAdmin(async (q) =>
      (await q<{ reason: string }>("select reason from app.custom_field_uses($1, $2, $3) order by reason", [org, object, id])).rows.map((r) => r.reason),
    );
  const expectInUse = async (id: string, reason: string) => {
    const error = await refused(id);
    expect(error.hint).toBe("custom_field:in_use");
    expect((error.detail ?? "").split(",")).toContain(reason);
    expect(await exists(id)).toBe(true);
  };

  beforeAll(async () => {
    owner = await createUser("fdel-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "fdel-admin");
    manager = await addMember(org, owner.id, "manager", "fdel-manager");
    member = await addMember(org, owner.id, "member", "fdel-member");
    viewer = await addMember(org, owner.id, "viewer", "fdel-viewer");
    outsider = await createUser("fdel-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("an unused field: owners and admins delete it, managers, members and viewers do not", async () => {
    const f = await define("lead");
    for (const user of [manager, member, viewer]) {
      expect(await del(user, f.id)).toBe(0);
    }
    expect(await exists(f.id)).toBe(true);
    expect(await reasonsOf("lead", f.id)).toEqual([]);
    expect(await del(owner, f.id)).toBe(1);
    expect(await exists(f.id)).toBe(false);
    const g = await define("contact");
    expect(await del(admin, g.id)).toBe(1);
  });

  it("the delete is in the audit log", async () => {
    const f = await define("company");
    expect(await del(owner, f.id)).toBe(1);
    const rows = await asAdmin(async (q) =>
      (
        await q<{ actor_id: string | null }>(
          "select actor_id from public.audit_log where organization_id = $1 and entity_type = 'field_definitions' and entity_id = $2 and action = 'delete'",
          [org, f.id],
        )
      ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(owner.id);
  });

  it("stored values, a record in the recycle bin included, keep the field; an empty value does not", async () => {
    const f = await define("lead");
    const lead = await insertLead(owner.id, org, { custom_fields: { [f.key]: "ערך" } });
    await expectInUse(f.id, "values");
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    await expectInUse(f.id, "values");
    // an empty string is no value
    await asAdmin((q) => q("update public.leads set custom_fields = jsonb_build_object($2::text, '  ') where id = $1", [lead, f.key]));
    expect(await reasonsOf("lead", f.id)).toEqual([]);
    expect(await del(owner, f.id)).toBe(1);
  });

  it("values of every record type count, on their own type only", async () => {
    // the same key on two record types: a contact's value keeps only the contact field
    const contactField = await define("contact", "text", { key: "same_key" });
    const dealField = await define("deal", "text", { key: "same_key" });
    await asUser(owner.id, (q) =>
      q("insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'רות', $2)", [org, JSON.stringify({ same_key: "x" })]),
    );
    await expectInUse(contactField.id, "values");
    expect(await reasonsOf("deal", dealField.id)).toEqual([]);
    expect(await del(owner, dealField.id)).toBe(1);
  });

  it("a unique field's recorded value keeps it", async () => {
    const f = await define("lead");
    await asUser(owner.id, (q) => q("update public.field_definitions set is_unique = true where id = $1", [f.id]));
    await insertLead(owner.id, org, { custom_fields: { [f.key]: "U-1" } });
    expect(await reasonsOf("lead", f.id)).toEqual(["values"]);
    await expectInUse(f.id, "values");
  });

  it("a file field's waiting upload and its current file keep it (184)", async () => {
    const f = await define("lead", "file");
    const lead = await insertLead(owner.id, org);
    const file = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, custom_field_key) values ($1, $2, 'חוזה.pdf', 'application/pdf', 100, $3) returning id",
          [org, lead, f.key],
        )
      ).rows[0].id,
    );
    await expectInUse(f.id, "files");
    // confirmed and set as the value: the current file
    await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [file]));
    await asUser(owner.id, (q) => q("update public.leads set custom_fields = $2 where id = $1", [lead, JSON.stringify({ $merge: { [f.key]: file } })]));
    expect(await reasonsOf("lead", f.id)).toEqual(["files", "values"]);
  });

  it("earlier versions of a field's file do not keep it, and stay as plain files of the record (184)", async () => {
    const f = await define("lead", "file");
    const lead = await insertLead(owner.id, org);
    const upload = async () => {
      const id = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes, custom_field_key) values ($1, $2, 'גרסה.pdf', 'application/pdf', 100, $3) returning id",
            [org, lead, f.key],
          )
        ).rows[0].id,
      );
      await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [id]));
      await asUser(owner.id, (q) => q("update public.leads set custom_fields = $2 where id = $1", [lead, JSON.stringify({ $merge: { [f.key]: id } })]));
      return id;
    };
    const first = await upload();
    const second = await upload();
    const third = await upload();
    const fileOf = (id: string) =>
      asAdmin(async (q) => (await q<{ k: string | null; p: string | null }>("select custom_field_key as k, previous_id as p from public.files where id = $1", [id])).rows[0]);
    expect((await fileOf(third)).p).toBe(second);
    expect((await fileOf(second)).p).toBe(first);
    // clearing the value releases the current file only
    await asUser(owner.id, (q) => q("update public.leads set custom_fields = $2 where id = $1", [lead, JSON.stringify({ $merge: { [f.key]: null } })]));
    expect(await fileOf(third)).toBeUndefined();
    expect(await reasonsOf("lead", f.id)).toEqual([]);
    expect(await del(owner, f.id)).toBe(1);
    // no file row is deleted: the versions stay, no longer of a field, their line kept
    expect(await fileOf(first)).toEqual({ k: null, p: null });
    expect(await fileOf(second)).toEqual({ k: null, p: first });
  });

  it("another field's condition keeps its controller", async () => {
    const ctl = await define("lead", "select", { options: ["א", "ב"] });
    await define("lead", "text", { condition: { field: ctl.key, op: "filled", effect: "show" } });
    await expectInUse(ctl.id, "condition");
  });

  it("a lead score rule, an automation, a form and a routing rule keep a lead field", async () => {
    const score = await define("lead");
    await asUser(owner.id, (q) => q("insert into public.lead_score_rules (organization_id, field, op, points) values ($1, $2, 'filled', 5)", [org, `cf:${score.key}`]));
    await expectInUse(score.id, "lead_score");

    const auto = await define("lead");
    await asAdmin((q) =>
      q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'עדכון', 'lead', 'created', $2, false)", [
        org,
        JSON.stringify([{ type: "set_field", field: `cf:${auto.key}`, value: "x" }]),
      ]),
    );
    await expectInUse(auto.id, "automation");

    const trig = await define("lead", "date");
    await asAdmin((q) =>
      q(
        "insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions, is_active) values ($1, 'תאריך', 'lead', 'date_reached', $2, $3, false)",
        [org, JSON.stringify({ field: `cf:${trig.key}`, days: 1, direction: "before" }), JSON.stringify([{ type: "notify" }])],
      ),
    );
    await expectInUse(trig.id, "automation");

    const form = await define("lead");
    await asAdmin((q) => q("insert into public.forms (organization_id, name, fields) values ($1, 'טופס', $2)", [org, JSON.stringify([{ key: "full_name" }, { key: `cf:${form.key}` }])]));
    await expectInUse(form.id, "form");

    const area = await define("lead", "select", { options: ["צפון", "דרום"] });
    await asAdmin((q) =>
      q("insert into public.lead_routing_rules (organization_id, is_active, field_key, field_value, user_id) values ($1, false, $2, 'צפון', $3)", [org, area.key, owner.id]),
    );
    await expectInUse(area.id, "routing_rule");
  });

  it("a conversion mapping keeps the lead field; its target is deleted and the mapping cleared (185)", async () => {
    const leadField = await define("lead");
    const target = await define("contact");
    await asUser(owner.id, (q) =>
      q("insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, target_field_id) values ($1, $2, 'contact', $3)", [org, leadField.id, target.id]),
    );
    await expectInUse(leadField.id, "conversion");
    expect(await reasonsOf("contact", target.id)).toEqual([]);
    expect(await del(owner, target.id)).toBe(1);
    const row = await asAdmin(async (q) =>
      (await q<{ mode: string; target_removed: boolean }>("select mode, target_removed from public.conversion_field_maps where lead_field_id = $1", [leadField.id])).rows[0],
    );
    expect(row).toEqual({ mode: "none", target_removed: true });
    // the lead field is free now
    expect(await reasonsOf("lead", leadField.id)).toEqual([]);
    expect(await del(owner, leadField.id)).toBe(1);
  });

  it("the card layout, the completeness setting, shared saved views and segments keep a field", async () => {
    const layout = await define("company");
    await asAdmin((q) =>
      q("insert into public.card_layouts (organization_id, object_type, groups) values ($1, 'company', $2)", [
        org,
        JSON.stringify([{ title: "פרטים", columns: 1, fields: [`cf:${layout.key}`] }]),
      ]),
    );
    await expectInUse(layout.id, "card_layout");

    const complete = await define("deal");
    await asAdmin((q) =>
      q("update public.completeness_settings set fields = array_append(fields, $2) where organization_id = $1 and object_type = 'deal'", [org, `cf:${complete.key}`]),
    );
    await expectInUse(complete.id, "completeness");

    // a saved view shared with the business, by its sort ("-cf:<key>")
    const view = await define("lead");
    await asUser(owner.id, (q) =>
      q("insert into public.saved_views (organization_id, object_type, name, scope, owner_id, config) values ($1, 'lead', 'של כולם', 'org', $2, $3)", [
        org,
        owner.id,
        JSON.stringify({ sort: `-cf:${view.key}` }),
      ]),
    );
    await expectInUse(view.id, "saved_view");
    // a team's view whose only use is its advanced filter, kept as json text inside filters.f (escaped quotes)
    const filtered = await define("lead");
    const team = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id);
    await asAdmin((q) =>
      q("insert into public.saved_views (organization_id, object_type, name, scope, team_id, owner_id, config) values ($1, 'lead', 'צוות', 'team', $2, $3, $4)", [
        org,
        team,
        owner.id,
        JSON.stringify({ filters: { f: JSON.stringify({ match: "all", groups: [{ match: "all", conditions: [{ field: `cf:${filtered.key}`, op: "filled" }] }] }) } }),
      ]),
    );
    expect(await asAdmin(async (q) => (await q<{ t: string }>("select config::text as t from public.saved_views where name = 'צוות' and organization_id = $1", [org])).rows[0].t)).toContain(
      `\\"cf:${filtered.key}\\"`,
    );
    await expectInUse(filtered.id, "saved_view");

    const segment = await define("contact");
    await asAdmin((q) =>
      q("insert into public.segments (organization_id, object_type, kind, name, filter) values ($1, 'contact', 'dynamic', 'פילוח', $2)", [
        org,
        JSON.stringify({ all: [{ field: `cf:${segment.key}`, op: "filled" }] }),
      ]),
    );
    await expectInUse(segment.id, "segment");
  });

  it("people's own list columns, board card fields and private saved views do not keep a field (183)", async () => {
    const column = await define("contact");
    await asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'contact', $2)", [org, JSON.stringify([{ key: `cf:${column.key}` }])]));
    const board = await define("deal");
    await asUser(member.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'deal_board', $2)", [org, JSON.stringify([{ key: `cf:${board.key}` }])]));
    const view = await define("company");
    await asUser(member.id, (q) =>
      q("insert into public.saved_views (organization_id, object_type, name, owner_id, config) values ($1, 'company', 'שלי', $2, $3)", [
        org,
        member.id,
        JSON.stringify({ sort: `-cf:${view.key}`, columns: [{ key: `cf:${view.key}` }] }),
      ]),
    );
    for (const [object, f] of [["contact", column], ["deal", board], ["company", view]] as const) {
      expect(await reasonsOf(object, f.id)).toEqual([]);
      expect(await del(owner, f.id)).toBe(1);
    }
    // the stale keys stay where the person put them (the lists skip a field that is gone)
    expect(
      await asAdmin(async (q) => (await q("select 1 from public.saved_views where organization_id = $1 and config::text like $2", [org, `%cf:${view.key}%`])).rowCount),
    ).toBe(1);
  });

  it("a key that only starts like another key is not a use", async () => {
    const short = await define("lead", "text", { key: "pre" });
    await define("lead", "text", { key: "prefix" });
    await asAdmin((q) => q("insert into public.forms (organization_id, name, fields) values ($1, 'טופס 2', $2)", [org, JSON.stringify([{ key: "cf:prefix" }])]));
    expect(await reasonsOf("lead", short.id)).toEqual([]);
    expect(await del(owner, short.id)).toBe(1);
  });

  it("the page reads the reasons by field (owners and admins only); other businesses learn nothing", async () => {
    const used = await define("lead");
    const free = await define("lead");
    await insertLead(owner.id, org, { custom_fields: { [used.key]: "x" } });
    const usage = await asUser(admin.id, async (q) =>
      (await q<{ u: Record<string, Array<{ reason: string; uses: number }>> }>("select public.custom_field_usage($1, 'lead') as u", [org])).rows[0].u,
    );
    expect(usage[used.id]).toEqual([{ reason: "values", uses: 1 }]);
    expect(usage[free.id]).toBeUndefined();
    for (const user of [manager, member, viewer, outsider]) {
      expect((await pgError(asUser(user.id, (q) => q("select public.custom_field_usage($1, 'lead')", [org])))).code).toBe("42501");
    }
    expect((await pgError(asUser(outsider.id, (q) => q("select * from app.custom_field_uses($1, 'lead', $2)", [org, used.id])))).code).toBe("42501");
    // the outsider's delete reaches nothing; nor does an owner's in another business
    expect(await asUser(outsider.id, async (q) => (await q("delete from public.field_definitions where id = $1", [free.id])).rowCount)).toBe(0);
    expect(await exists(free.id)).toBe(true);
    const theirs = await asUser(outsider.id, async (q) =>
      (await q<{ id: string }>("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'x1', 'x1', 'text') returning id", [otherOrg])).rows[0].id,
    );
    expect(await asUser(owner.id, async (q) => (await q("delete from public.field_definitions where id = $1", [theirs])).rowCount)).toBe(0);
    // a value in another business does not keep this business's field of the same key
    await insertLead(outsider.id, otherOrg, { custom_fields: { x1: "v" } });
    const mine = await define("lead", "text", { key: "x1" });
    expect(await reasonsOf("lead", mine.id)).toEqual([]);
    expect(await del(owner, mine.id)).toBe(1);
  });

  it("a server delete (the business's own cascade) is not judged", async () => {
    const f = await define("lead");
    await insertLead(owner.id, org, { custom_fields: { [f.key]: "x" } });
    await asAdmin((q) => q("delete from public.field_definitions where id = $1", [f.id]));
    expect(await exists(f.id)).toBe(false);
  });

  describe("a value written at the same moment", () => {
    const personClient = async (userId: string) => {
      const client = new Client({ connectionString: TEST_DB_URL });
      await client.connect();
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await client.query("set local role authenticated");
      return client;
    };
    const settle = <T,>(promise: Promise<T>) => {
      const state = { done: false };
      const result = promise.then(
        () => {
          state.done = true;
          return null;
        },
        (error: DbError) => {
          state.done = true;
          return error;
        },
      );
      return { state, result };
    };
    const wait = () => new Promise((resolve) => setTimeout(resolve, 250));

    it("a value written before the delete is counted once its writer commits", async () => {
      const f = await define("lead");
      const lead = await insertLead(owner.id, org);
      const writer = await personClient(owner.id);
      const deleter = await personClient(admin.id);
      try {
        await writer.query("update public.leads set custom_fields = custom_fields || $2::jsonb where id = $1", [lead, JSON.stringify({ [f.key]: "race" })]);
        const pending = settle(deleter.query("delete from public.field_definitions where id = $1", [f.id]));
        await wait();
        expect(pending.state.done).toBe(false);
        await writer.query("commit");
        expect((await pending.result)?.hint).toBe("custom_field:in_use");
        await deleter.query("rollback");
      } finally {
        await writer.end();
        await deleter.end();
      }
      expect(await exists(f.id)).toBe(true);
    });

    it("a value written while the delete is open waits for it, and is then refused", async () => {
      const f = await define("lead");
      const lead = await insertLead(owner.id, org);
      const deleter = await personClient(admin.id);
      const writer = await personClient(owner.id);
      try {
        const deleted = await deleter.query("delete from public.field_definitions where id = $1", [f.id]);
        expect(deleted.rowCount).toBe(1);
        const pending = settle(writer.query("update public.leads set custom_fields = custom_fields || $2::jsonb where id = $1", [lead, JSON.stringify({ [f.key]: "late" })]));
        await wait();
        expect(pending.state.done).toBe(false);
        await deleter.query("commit");
        expect((await pending.result)?.hint).toBe("custom_field:invalid");
        await writer.query("rollback");
      } finally {
        await writer.end();
        await deleter.end();
      }
      expect(await exists(f.id)).toBe(false);
      const stored = await asAdmin(async (q) => (await q<{ c: Record<string, unknown> }>("select custom_fields as c from public.leads where id = $1", [lead])).rows[0].c);
      expect(stored[f.key]).toBeUndefined();
    });
  });
});
