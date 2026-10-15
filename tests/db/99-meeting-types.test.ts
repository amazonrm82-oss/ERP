import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STAGE_COLOR_VALUES } from "@/features/deals/stage-colors";
import { DEFAULT_MEETING_TYPES } from "@/features/meeting-types/schema";
import { MEETING_TYPES } from "@/features/meetings/schema";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

function migrationText(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_meeting_types.sql"));
  if (!file) throw new Error("no migration *_meeting_types.sql");
  return readFileSync(path.join(dir, file), "utf8");
}

type Busy = { user_id: string; meeting_id: string | null; title: string | null; starts_at: Date; ends_at: Date; busy_from: Date; busy_to: Date };

/**
 * CAL-08: meeting types are a managed list (members read, owners/admins of a writable organization
 * write, 50 per organization, seeded); a type may link an offerable product while the plan holds
 * products; a meeting may pick an active type and keeps it when the type is hidden; deleting a type
 * clears the link; the type's buffers count as busy in public.meeting_busy().
 */
describe("meeting types (CAL-08)", () => {
  let owner: U, admin: U, member: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;

  const typesOf = (o: string) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string; name: string; duration_minutes: number; meeting_format: string | null; color: string | null; position: number }>(
          "select id, name, duration_minutes, meeting_format, color, position from public.meeting_types where organization_id = $1 order by position",
          [o],
        )
      ).rows,
    );

  const newType = (userId: string, o: string, name: string, extra: Record<string, unknown> = {}) =>
    asUser(userId, async (q) => {
      const cols = ["organization_id", "name", ...Object.keys(extra)];
      const params = [o, name, ...Object.values(extra)];
      return (
        await q<{ id: string }>(
          `insert into public.meeting_types (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          params,
        )
      ).rows[0].id;
    });

  const newMeeting = (userId: string, start: string, end: string, typeId: string | null = null, o = org) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at, meeting_type_id) values ($1, 'פגישה', $2, $3, $4) returning id",
          [o, start, end, typeId],
        )
      ).rows[0].id,
    );

  const busy = (caller: U, users: string[], from: string, to: string) =>
    asUser(caller.id, async (q) => (await q<Busy>("select * from public.meeting_busy($1, $2::uuid[], $3, $4)", [org, users, from, to])).rows);

  const setFeatures = (o: string, features: Record<string, unknown>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify(features)]));

  const newProduct = (o: string, name: string) =>
    asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, $2) returning id", [o, name])).rows[0].id);

  beforeAll(async () => {
    owner = await createUser("mt-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "mt-admin");
    member = await addMember(org, owner.id, "member", "mt-member");
    viewer = await addMember(org, owner.id, "viewer", "mt-viewer");
    stranger = await createUser("mt-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
  });

  it("a new organization starts with the default types, the same as the app's list", async () => {
    const types = await typesOf(org);
    expect(types.map((t) => ({ name: t.name, minutes: t.duration_minutes, format: t.meeting_format, color: t.color }))).toEqual(
      DEFAULT_MEETING_TYPES.map((t) => ({ name: t.name, minutes: t.minutes, format: t.format, color: t.color })),
    );
    expect(types.map((t) => t.position)).toEqual(DEFAULT_MEETING_TYPES.map((_, i) => i));
    // no buffers in the defaults (owner)
    expect(
      await asAdmin((q) => count(q, "select 1 from public.meeting_types where organization_id = $1 and (buffer_before_minutes <> 0 or buffer_after_minutes <> 0)", [org])),
    ).toBe(0);
  });

  it("the migration seeds existing organizations whose list is empty, and leaves the others alone", async () => {
    const sql = migrationText();
    const backfill = sql.slice(sql.lastIndexOf("\nselect app.seed_meeting_types") + 1);
    expect(backfill.startsWith("select app.seed_meeting_types(o.id) from public.organizations o;")).toBe(true);
    const empty = await createOrg(owner.id, "עסק ריק");
    await asAdmin((q) => q("update public.meeting_types set name = name || ' ישן' where organization_id = $1", [org]));
    // an organization that emptied its list: in the migration's terms, one that existed before it
    await asUser(owner.id, (q) => q("delete from public.meeting_types where organization_id = $1", [empty]));
    expect(await typesOf(empty)).toHaveLength(0);
    await asAdmin((q) => q(backfill.split("\n")[0]));
    expect((await typesOf(empty)).map((t) => t.name)).toEqual(DEFAULT_MEETING_TYPES.map((t) => t.name));
    // an organization that has types keeps exactly its own
    expect((await typesOf(org)).every((t) => t.name.endsWith(" ישן"))).toBe(true);
    await asAdmin((q) => q("update public.meeting_types set name = regexp_replace(name, ' ישן$', '') where organization_id = $1", [org]));
  });

  it("the palette and the formats are the app's lists", async () => {
    const sql = migrationText();
    expect(sql).toContain(`check (color in (${STAGE_COLOR_VALUES.map((c) => `'${c}'`).join(", ")}))`);
    expect(sql).toContain(`check (meeting_format in (${MEETING_TYPES.map((c) => `'${c}'`).join(", ")}))`);
  });

  it("members read the list; owners and admins write it; members, viewers and outsiders do not", async () => {
    for (const u of [member, viewer]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.meeting_types where organization_id = $1", [org]))).toBe(DEFAULT_MEETING_TYPES.length);
      expect((await pgError(newType(u.id, org, "ניסיון"))).code).toBe("42501");
      await asUser(u.id, async (q) => {
        expect((await q("update public.meeting_types set name = name where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.meeting_types where organization_id = $1", [org])).rowCount).toBe(0);
      });
    }
    expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.meeting_types where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(newType(stranger.id, org, "פריצה"))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select 1 from public.meeting_types")))).code).toBe("42501");

    const id = await newType(admin.id, org, "ייעוץ", { duration_minutes: 45, buffer_before_minutes: 10, buffer_after_minutes: 15, color: "danger" });
    await asUser(owner.id, async (q) => {
      expect((await q("update public.meeting_types set duration_minutes = 50 where id = $1", [id])).rowCount).toBe(1);
    });
    // the changes are audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'meeting_types' and entity_id = $1", [id]))).toBeGreaterThanOrEqual(2);
  });

  it("refuses values outside the limits and a second type of the same name", async () => {
    for (const extra of [
      { duration_minutes: 4 },
      { duration_minutes: 721 },
      { buffer_before_minutes: -1 },
      { buffer_after_minutes: 241 },
      { color: "#ff0000" },
      { meeting_format: "zoom" },
      { location: "" },
    ]) {
      expect((await pgError(newType(owner.id, org, `בדיקה ${JSON.stringify(extra)}`, extra))).code, JSON.stringify(extra)).toBe("23514");
    }
    expect((await pgError(newType(owner.id, org, " רווח"))).code).toBe("23514");
    expect((await pgError(newType(owner.id, org, "פגישת מכירה".toUpperCase()))).code).toBe("23505");
  });

  it("allows 50 types per organization (hint meeting_types:max)", async () => {
    const other = await createOrg(owner.id, "עסק מלא");
    const have = (await typesOf(other)).length;
    await asUser(owner.id, async (q) => {
      for (let i = have; i < 50; i++) await q("insert into public.meeting_types (organization_id, name) values ($1, $2)", [other, `סוג ${i}`]);
    });
    const error = await pgError(newType(owner.id, other, "אחד יותר מדי"));
    expect(error).toMatchObject({ code: "P0001", hint: "meeting_types:max" });
    // an outsider hears RLS's plain refusal, not the count
    expect(await pgError(newType(stranger.id, other, "פריצה"))).toMatchObject({ code: "42501" });
  });

  it("links only an offerable product of the organization, and only while the plan holds products", async () => {
    const product = await newProduct(org, "ייעוץ שעה");
    const typeId = await newType(owner.id, org, "שעת ייעוץ", { product_id: product });
    expect(typeId).toBeTruthy();

    const archived = await newProduct(org, "שירות ישן");
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [archived]));
    expect(await pgError(newType(owner.id, org, "עם שירות בארכיון", { product_id: archived }))).toMatchObject({ code: "P0001", hint: "meeting_type:product" });
    const inactive = await newProduct(org, "שירות מושבת");
    await asUser(owner.id, (q) => q("update public.products set is_active = false where id = $1", [inactive]));
    expect(await pgError(asUser(owner.id, (q) => q("update public.meeting_types set product_id = $2 where id = $1", [typeId, inactive])))).toMatchObject({
      hint: "meeting_type:product",
    });
    // another organization's product: the composite key refuses it
    const foreign = await asUser(stranger.id, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'של אחרים') returning id", [otherOrg])).rows[0].id,
    );
    expect((await pgError(newType(owner.id, org, "עם מוצר זר", { product_id: foreign }))).code).toMatch(/^(23503|P0001)$/);

    // a product archived after it was linked stays linked; editing other fields still works
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [product]));
    await asUser(owner.id, async (q) => {
      expect((await q("update public.meeting_types set duration_minutes = 60 where id = $1", [typeId])).rowCount).toBe(1);
    });

    const fresh = await newProduct(org, "שירות חדש");
    await setFeatures(org, { products: false });
    expect(await pgError(newType(owner.id, org, "בלי מוצרים בחבילה", { product_id: fresh }))).toMatchObject({ code: "P0001", hint: "feature:products" });
    // a type without a service is fine without the flag
    expect(await newType(owner.id, org, "בלי שירות")).toBeTruthy();
    await setFeatures(org, {});
  });

  it("deleting a linked product clears the link", async () => {
    const product = await newProduct(org, "שירות למחיקה");
    const typeId = await newType(owner.id, org, "סוג עם שירות למחיקה", { product_id: product });
    await asUser(owner.id, (q) => q("delete from public.products where id = $1", [product]));
    const row = await asAdmin(async (q) => (await q<{ product_id: string | null }>("select product_id from public.meeting_types where id = $1", [typeId])).rows[0]);
    expect(row.product_id).toBeNull();
  });

  it("a meeting picks an active type of its organization, keeps a type hidden later, and loses it when the type is deleted", async () => {
    const typeId = (await typesOf(org))[0].id;
    const meeting = await newMeeting(member.id, "2026-12-01T08:00:00Z", "2026-12-01T08:30:00Z", typeId);

    await asUser(owner.id, (q) => q("update public.meeting_types set is_active = false where id = $1", [typeId]));
    // kept on an edit of something else
    await asUser(member.id, async (q) => {
      expect((await q("update public.meetings set title = 'שם חדש' where id = $1", [meeting])).rowCount).toBe(1);
    });
    // but not picked anew
    expect(await pgError(newMeeting(member.id, "2026-12-02T08:00:00Z", "2026-12-02T08:30:00Z", typeId))).toMatchObject({ code: "P0001", hint: "meeting:type" });

    // another organization's type: refused (the composite key, or the trigger)
    const foreignType = (await typesOf(otherOrg))[0].id;
    expect((await pgError(newMeeting(member.id, "2026-12-03T08:00:00Z", "2026-12-03T08:30:00Z", foreignType))).code).toMatch(/^(23503|P0001)$/);

    await asUser(owner.id, (q) => q("delete from public.meeting_types where id = $1", [typeId]));
    const row = await asAdmin(async (q) =>
      (await q<{ meeting_type_id: string | null; title: string }>("select meeting_type_id, title from public.meetings where id = $1", [meeting])).rows[0],
    );
    expect(row).toEqual({ meeting_type_id: null, title: "שם חדש" });
  });

  it("an outsider learns nothing about the organization's types through a meeting", async () => {
    const typeId = (await typesOf(org))[0].id;
    // the stranger writes into their own organization with this organization's type: the key refuses it
    expect((await pgError(newMeeting(stranger.id, "2026-12-04T08:00:00Z", "2026-12-04T08:30:00Z", typeId, otherOrg))).code).toMatch(/^(23503|P0001)$/);
    // and into this organization: plain RLS refusal
    expect((await pgError(newMeeting(stranger.id, "2026-12-04T08:00:00Z", "2026-12-04T08:30:00Z", typeId, org))).code).toBe("42501");
  });

  it("counts a meeting type's buffers as busy, and returns them next to the meeting's own times", async () => {
    const typeId = await newType(owner.id, org, "פגישת שטח", { duration_minutes: 60, buffer_before_minutes: 30, buffer_after_minutes: 15 });
    // 10:00-11:00 with buffers: busy 09:30-11:15
    const meeting = await newMeeting(member.id, "2026-12-10T10:00:00Z", "2026-12-10T11:00:00Z", typeId);

    // only the buffer after overlaps 11:00-11:10
    const after = await busy(member, [member.id], "2026-12-10T11:00:00Z", "2026-12-10T11:10:00Z");
    expect(after).toHaveLength(1);
    expect(after[0].meeting_id).toBe(meeting);
    expect(after[0].starts_at.toISOString()).toBe("2026-12-10T10:00:00.000Z");
    expect(after[0].ends_at.toISOString()).toBe("2026-12-10T11:00:00.000Z");
    expect(after[0].busy_from.toISOString()).toBe("2026-12-10T09:30:00.000Z");
    expect(after[0].busy_to.toISOString()).toBe("2026-12-10T11:15:00.000Z");
    // only the buffer before overlaps 09:00-09:45
    expect(await busy(member, [member.id], "2026-12-10T09:00:00Z", "2026-12-10T09:45:00Z")).toHaveLength(1);
    // outside the buffers: free
    expect(await busy(member, [member.id], "2026-12-10T11:15:00Z", "2026-12-10T12:00:00Z")).toHaveLength(0);
    expect(await busy(member, [member.id], "2026-12-10T08:00:00Z", "2026-12-10T09:30:00Z")).toHaveLength(0);

    // a meeting without a type has no buffers
    await newMeeting(member.id, "2026-12-11T10:00:00Z", "2026-12-11T11:00:00Z");
    const plain = await busy(member, [member.id], "2026-12-11T09:00:00Z", "2026-12-11T12:00:00Z");
    expect(plain).toHaveLength(1);
    expect(plain[0].busy_from.toISOString()).toBe("2026-12-11T10:00:00.000Z");
    expect(plain[0].busy_to.toISOString()).toBe("2026-12-11T11:00:00.000Z");
    expect(await busy(member, [member.id], "2026-12-11T11:00:00Z", "2026-12-11T11:10:00Z")).toHaveLength(0);

    // the largest buffers (240 minutes) are still found
    const wide = await newType(owner.id, org, "יום שטח", { buffer_before_minutes: 240, buffer_after_minutes: 240 });
    await newMeeting(member.id, "2026-12-12T10:00:00Z", "2026-12-12T11:00:00Z", wide);
    expect(await busy(member, [member.id], "2026-12-12T14:30:00Z", "2026-12-12T14:45:00Z")).toHaveLength(1);
    expect(await busy(member, [member.id], "2026-12-12T15:00:00Z", "2026-12-12T15:15:00Z")).toHaveLength(0);
    expect(await busy(member, [member.id], "2026-12-12T05:45:00Z", "2026-12-12T06:15:00Z")).toHaveLength(1);
  });

  it("buffers are read live from the type: no type, or a type deleted later, means 0 before and 0 after (owner)", async () => {
    // no type
    await newMeeting(member.id, "2026-12-14T10:00:00Z", "2026-12-14T11:00:00Z");
    const none = await busy(member, [member.id], "2026-12-14T09:00:00Z", "2026-12-14T12:00:00Z");
    expect(none.map((r) => [r.busy_from.toISOString(), r.busy_to.toISOString()])).toEqual([["2026-12-14T10:00:00.000Z", "2026-12-14T11:00:00.000Z"]]);

    // a type with buffers, deleted after the meeting was saved
    const typeId = await newType(owner.id, org, "סוג שיימחק", { buffer_before_minutes: 30, buffer_after_minutes: 30 });
    const meeting = await newMeeting(member.id, "2026-12-15T10:00:00Z", "2026-12-15T11:00:00Z", typeId);
    const before = await busy(member, [member.id], "2026-12-15T11:00:00Z", "2026-12-15T11:20:00Z");
    expect(before.map((r) => r.busy_to.toISOString())).toEqual(["2026-12-15T11:30:00.000Z"]);

    await asUser(owner.id, (q) => q("delete from public.meeting_types where id = $1", [typeId]));
    expect(await asAdmin(async (q) => (await q<{ t: string | null }>("select meeting_type_id as t from public.meetings where id = $1", [meeting])).rows[0].t)).toBeNull();
    const after = await busy(member, [member.id], "2026-12-15T09:00:00Z", "2026-12-15T12:00:00Z");
    expect(after.map((r) => [r.meeting_id, r.busy_from.toISOString(), r.busy_to.toISOString()])).toEqual([
      [meeting, "2026-12-15T10:00:00.000Z", "2026-12-15T11:00:00.000Z"],
    ]);
    // the former buffer after is free again
    expect(await busy(member, [member.id], "2026-12-15T11:00:00Z", "2026-12-15T11:20:00Z")).toHaveLength(0);
  });

  it("meeting_busy's first cut is as wide as the largest buffer the table allows", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ def: string }>(
          `select pg_get_constraintdef(c.oid) as def from pg_constraint c
            where c.conrelid = 'public.meeting_types'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%buffer_%_minutes%'`,
        )
      ).rows,
    );
    expect(rows).toHaveLength(2);
    const maxes = rows.map((r) => Number(/<= (\d+)/.exec(r.def)?.[1]));
    expect(new Set(maxes).size).toBe(1);
    const fn = await asAdmin(async (q) =>
      (await q<{ def: string }>("select pg_get_functiondef('public.meeting_busy(uuid, uuid[], timestamptz, timestamptz, uuid)'::regprocedure) as def")).rows[0].def,
    );
    const cuts = [...fn.matchAll(/interval '(\d+) minutes'/g)].map((m) => Number(m[1]));
    expect(cuts).toHaveLength(2);
    for (const cut of cuts) expect(cut).toBe(maxes[0]);
    // and the limit itself is enforced
    expect((await pgError(newType(owner.id, org, "מרווח גדול מדי", { buffer_after_minutes: maxes[0] + 1 }))).code).toBe("23514");
  });

  it("the old meeting_busy is out of the API, and the new one is definer, pinned and for authenticated only", async () => {
    const fns = await asAdmin(async (q) =>
      (
        await q<{ schema: string; name: string; secdef: boolean; config: string[] | null; anon: boolean; auth: boolean; service: boolean }>(`
          select n.nspname as schema, p.proname as name, p.prosecdef as secdef, p.proconfig as config,
                 has_function_privilege('anon', p.oid, 'execute') as anon,
                 has_function_privilege('authenticated', p.oid, 'execute') as auth,
                 has_function_privilege('service_role', p.oid, 'execute') as service
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.proname like 'meeting_busy%' order by n.nspname`)
      ).rows,
    );
    expect(fns.map((f) => `${f.schema}.${f.name}`)).toEqual(["app.meeting_busy_0192_retired", "public.meeting_busy"]);
    expect(fns[0]).toMatchObject({ anon: false, auth: false, service: false });
    expect(fns[1]).toMatchObject({ secdef: true, anon: false, auth: true });
    expect(fns[1].config).toContain('search_path=""');
  });
});
