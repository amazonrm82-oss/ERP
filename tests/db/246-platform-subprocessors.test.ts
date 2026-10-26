import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Query, asAdmin, asAnon, asMfaUser, asService, asUser, addMember, closePool, count, createOrg, createUser, pgError } from "./helpers";

// ADM-01 (subprocessors): the platform owner manages the list customers see. Platform owners only, with two-step
// verification; a new entry starts at least 14 days ahead and every active business owner is told once; an entry in
// force is locked (only an end day in the future, or a missing location/website filled once); every action is logged.

const staffIds: string[] = [];
const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};
const TITLE = "קבלן משנה חדש";
const CHANGE = "שינוי ברשימת קבלני המשנה";
const PREFIX = "בדיקת ADM01 ";

afterAll(async () => {
  await asAdmin(async (q) => {
    await q("delete from public.notifications where type = 'system' and title = any($1)", [[TITLE, CHANGE]]);
    // future and cancelled test rows only (the guard lets those go)
    await q("delete from public.subprocessors where name like $1 and (cancelled_at is not null or effective_from > current_date)", [`${PREFIX}%`]);
    await q("delete from app.platform_staff where user_id = any($1)", [staffIds]);
  });
  await closePool();
});

type Fields = { name: string; purpose?: string; data?: string; location?: string | null; website?: string | null; from: string };
const args = (f: Fields) => [f.name, f.purpose ?? "תפקיד", f.data ?? "מידע", f.location ?? null, f.website ?? null, f.from];
const add = (userId: string, f: Fields) =>
  asMfaUser(userId, async (q) => (await q<{ id: string }>("select public.platform_add_subprocessor($1, $2, $3, $4, $5, $6::date) as id", args(f))).rows[0].id);
const update = (userId: string, id: string, f: Fields) =>
  asMfaUser(userId, async (q) => (await q<{ id: string }>("select public.platform_update_subprocessor($1, $2, $3, $4, $5, $6, $7::date) as id", [id, ...args(f)])).rows[0].id);
const remove = (userId: string, id: string) => asMfaUser(userId, (q) => q("select public.platform_remove_subprocessor($1)", [id]));
const end = (userId: string, id: string, day: string | null) => asMfaUser(userId, (q) => q("select public.platform_end_subprocessor($1, $2::date)", [id, day]));

const dayIn = (days: number) =>
  asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone 'Asia/Jerusalem')::date + $1::int, 'YYYY-MM-DD') as d", [days])).rows[0].d);
const row = (id: string) =>
  asAdmin(async (q) => (await q("select name, purpose, location, website, to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(ends_on, 'YYYY-MM-DD') as ends_on, cancelled_at is not null as cancelled from public.subprocessors where id = $1", [id])).rows[0]);
const notices = (userId: string, name: string, title = TITLE) =>
  asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'system' and title = $2 and body like $3", [userId, title, `${name} %`]));
type PublicList<E> = { entries: E[]; updated_on: string | null };
const logs = (action: string, id: string) => asAdmin((q) => count(q, "select 1 from app.platform_log where action = $1 and details->>'id' = $2", [action, id]));

describe("ADM-01: subprocessors from the platform panel", () => {
  let owner: { id: string };
  let bizOwner: { id: string };
  let bizAdmin: { id: string };
  let orgA: string;
  let orgB: string;
  let seeded: string;
  let D20: string;
  let D30: string;

  beforeAll(async () => {
    owner = await createUser("adm01s-platform-owner");
    await makeStaff(owner.id, "owner");
    bizOwner = await createUser("adm01s-biz-owner");
    orgA = await createOrg(bizOwner.id, "עסק א");
    orgB = await createOrg(bizOwner.id, "עסק ב");
    bizAdmin = await addMember(orgA, bizOwner.id, "admin", "adm01s-biz-admin");
    seeded = (await asAdmin(async (q) => (await q<{ id: string }>("select id from public.subprocessors where name = 'Supabase'")).rows[0])).id;
    D20 = await dayIn(20);
    D30 = await dayIn(30);
  });

  it("the migration seeds today's list, in force, and the public function returns only public fields", async () => {
    const names = await asAdmin(async (q) =>
      (await q<{ name: string }>("select name from public.subprocessors where effective_from <= current_date and cancelled_at is null order by effective_from, created_at, id")).rows.map((r) => r.name),
    );
    expect(names.slice(0, 3)).toEqual(["Supabase", "Vercel", "שירותי הדחיפה של הדפדפנים"]);
    const result = await asService(async (q) => (await q<{ l: PublicList<Record<string, unknown>> }>("select public.subprocessors_public_page() as l")).rows[0].l);
    expect(Object.keys(result).sort()).toEqual(["entries", "updated_on"]);
    // the seed keeps the legal version's day as the last change
    expect(result.updated_on).toBe("2026-10-13");
    const list = result.entries;
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(["country", "data_categories", "effective_from", "ends_on", "name", "purpose"]);
    }
    // no client reads the table directly (the screens use the platform and public-page functions), and nobody writes it
    expect((await pgError(asUser(bizAdmin.id, (q) => q("select * from public.subprocessors")))).code).toBe("42501");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select * from public.subprocessors")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select * from public.subprocessors")))).code).toBe("42501");
    // the public page's function is for the service key only
    const grants = await asAdmin(async (q) =>
      (await q<{ r: string }>("select r from unnest(array['anon', 'authenticated', 'service_role', 'public']) r where r <> 'public' and has_function_privilege(r, 'public.subprocessors_public_page()', 'execute')")).rows.map((x) => x.r),
    );
    expect(grants).toEqual(["service_role"]);
    expect((await pgError(asAnon((q) => q("select public.subprocessors_public_page()")))).code).toBe("42501");
    expect((await pgError(asUser(bizAdmin.id, (q) => q("select public.subprocessors_public_page()")))).code).toBe("42501");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.subprocessors_public_page()")))).code).toBe("42501");
    for (const sql of [
      "insert into public.subprocessors (name, purpose, data_categories, effective_from) values ('x', 'x', 'x', '2099-01-01')",
      "update public.subprocessors set name = name",
      "delete from public.subprocessors",
      "truncate public.subprocessors",
      "select * from public.subprocessors",
    ]) {
      expect((await pgError(asMfaUser(owner.id, (q) => q(sql)))).code, sql).toBe("42501");
      expect((await pgError(asService((q) => q(sql)))).code, `service ${sql}`).toBe("42501");
    }
  });

  it("only the platform owner with two-step verification manages the list", async () => {
    for (const role of ["support", "finance", "readonly"]) {
      const staff = await createUser(`adm01s-${role}`);
      await makeStaff(staff.id, role);
      expect((await pgError(add(staff.id, { name: `${PREFIX}x`, from: D30 }))).code, role).toBe("42501");
      expect((await pgError(end(staff.id, seeded, D30))).code, role).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("select public.platform_add_subprocessor('x', 'x', 'x', null, null, $1::date)", [D30])))).code).toBe("42501");
    expect((await pgError(add(bizOwner.id, { name: `${PREFIX}x`, from: D30 }))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.platform_add_subprocessor('x', 'x', 'x', null, null, $1::date)", [D30])))).code).toBe("42501");
  });

  it("a new entry needs 14 days of notice and valid fields; each business owner is told once per business", async () => {
    for (const days of [-1, 0, 1, 13]) {
      const err = await pgError(add(owner.id, { name: `${PREFIX}early`, from: await dayIn(days) }));
      expect([err.code, err.hint], String(days)).toEqual(["P0001", "subprocessor:notice"]);
    }
    for (const bad of [{ name: " " }, { name: "x".repeat(121) }, { purpose: "" }, { data: "x".repeat(501) }, { website: "http://a.example" }, { website: "https://a b" }]) {
      const err = await pgError(add(owner.id, { name: `${PREFIX}bad`, from: D30, ...bad }));
      expect(err.code, JSON.stringify(bad)).toBe("22023");
    }
    const id = await add(owner.id, { name: `${PREFIX}חדש`, purpose: "  שליחת מיילים  ", website: "https://mail.example", from: D30 });
    expect(await row(id)).toMatchObject({ name: `${PREFIX}חדש`, purpose: "שליחת מיילים", effective_from: D30, cancelled: false });
    // one notice per business the owner owns, none to an admin
    expect(await notices(bizOwner.id, `${PREFIX}חדש`)).toBe(2);
    expect(await notices(bizAdmin.id, `${PREFIX}חדש`)).toBe(0);
    const body = await asAdmin(async (q) => (await q<{ body: string; organization_id: string }>("select body, organization_id from public.notifications where user_id = $1 and title = $2 and organization_id = $3", [bizOwner.id, TITLE, orgA])).rows[0]);
    expect(body.body).toContain(D30.split("-").reverse().join("."));
    expect(await asUser(bizOwner.id, (q) => count(q, "select 1 from public.notifications where title = $1 and organization_id = any($2)", [TITLE, [orgA, orgB]]))).toBe(2);
    expect(await logs("subprocessor.add", id)).toBe(1);
    const entry = await asAdmin(async (q) => (await q<{ actor_id: string; details: Record<string, unknown> }>("select actor_id, details from app.platform_log where action = 'subprocessor.add' and details->>'id' = $1", [id])).rows[0]);
    expect(entry.actor_id).toBe(owner.id);
    expect(entry.details).toMatchObject({ name: `${PREFIX}חדש`, notices: expect.any(Number) });

    // the upcoming entry is listed with its day
    const list = await asService(async (q) => (await q<{ l: PublicList<{ name: string; effective_from: string }> }>("select public.subprocessors_public_page() as l")).rows[0].l.entries);
    expect(list.find((e) => e.name === `${PREFIX}חדש`)?.effective_from).toBe(D30);
  });

  it("correcting a future entry: location/website quietly; a new name, day, purpose or data announced again with 14 days", async () => {
    const id = await add(owner.id, { name: `${PREFIX}תיקון`, from: D30 });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(2);
    expect(await update(owner.id, id, { name: `${PREFIX}תיקון`, location: "אירופה", website: "https://x.example", from: D30 })).toBe(id);
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(2);
    const early = await pgError(update(owner.id, id, { name: `${PREFIX}תיקון`, from: await dayIn(5) }));
    expect([early.code, early.hint]).toEqual(["P0001", "subprocessor:notice"]);
    await update(owner.id, id, { name: `${PREFIX}תיקון`, location: "אירופה", website: "https://x.example", from: D20 });
    expect(await row(id)).toMatchObject({ effective_from: D20, location: "אירופה" });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(4);
    await update(owner.id, id, { name: `${PREFIX}תיקון`, purpose: "תפקיד מעודכן", location: "אירופה", website: "https://x.example", from: D20 });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(6);
    await update(owner.id, id, { name: `${PREFIX}תיקון`, purpose: "תפקיד מעודכן", data: "מידע אחר", location: "אירופה", website: "https://x.example", from: D20 });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(8);
    // the same values again change nothing and send nothing
    await update(owner.id, id, { name: `${PREFIX}תיקון`, purpose: "תפקיד מעודכן", data: "מידע אחר", location: "אירופה", website: "https://x.example", from: D20 });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(8);
    expect(await logs("subprocessor.update", id)).toBe(4);
    // a spacing fix is not new content: whitespace runs (no-break spaces included) collapse to one space
    await update(owner.id, id, { name: ` ${PREFIX}תיקון `, purpose: "תפקיד\u00a0 \t מעודכן", data: "מידע\n\nאחר", location: "אירופה", website: "https://x.example", from: D20 });
    expect(await row(id)).toMatchObject({ name: `${PREFIX}תיקון`, purpose: "תפקיד מעודכן" });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(8);
    // going back to an earlier version is announced again (A -> B -> A)
    await update(owner.id, id, { name: `${PREFIX}תיקון`, purpose: "תפקיד", data: "מידע אחר", location: "אירופה", website: "https://x.example", from: D20 });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(10);
    await update(owner.id, id, { name: `${PREFIX}תיקון`, purpose: "תפקיד מעודכן", data: "מידע אחר", location: "אירופה", website: "https://x.example", from: D20 });
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(12);
    // a purpose or data change once the day is less than 14 days away is refused like a new day
    const late = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.subprocessors (name, purpose, data_categories, effective_from) values ($1, 'p', 'd', $2::date) returning id", [`${PREFIX}קרוב`, await dayIn(3)])).rows[0].id);
    for (const change of [{ purpose: "חדש" }, { data: "חדש" }]) {
      const err = await pgError(update(owner.id, late, { name: `${PREFIX}קרוב`, purpose: "p", data: "d", from: await dayIn(3), ...change }));
      expect([err.code, err.hint], JSON.stringify(change)).toEqual(["P0001", "subprocessor:notice"]);
    }
    // an end day on an upcoming entry is part of its announcement, under the 14-day rule
    const lateEnd = await pgError(end(owner.id, late, await dayIn(10)));
    expect([lateEnd.code, lateEnd.hint]).toEqual(["P0001", "subprocessor:notice"]);
    await end(owner.id, id, D30);
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`)).toBe(14);
    const withEnd = await asAdmin(async (q) => (await q<{ body: string }>("select body from public.notifications where user_id = $1 and title = $2 and organization_id = $3 order by created_at desc, id limit 1", [bizOwner.id, TITLE, orgA])).rows[0].body);
    expect(withEnd).toContain(`ויוסר ממנה ב-${D30.split("-").reverse().join(".")}`);
    // a start day moved onto or past the end day is refused with its own hint
    const past = await pgError(update(owner.id, id, { name: `${PREFIX}תיקון`, purpose: "תפקיד מעודכן", data: "מידע אחר", location: "אירופה", website: "https://x.example", from: D30 }));
    expect([past.code, past.hint]).toEqual(["P0001", "subprocessor:end_before_start"]);
    const before = await pgError(end(owner.id, id, D20));
    expect([before.code, before.hint]).toEqual(["P0001", "subprocessor:end_before_start"]);
    // an upcoming entry's end day is told inside its announcement, never as a separate change notice
    expect(await notices(bizOwner.id, `${PREFIX}תיקון`, CHANGE)).toBe(0);
  });

  it("removing a future entry cancels it: hidden, logged, locked", async () => {
    const id = await add(owner.id, { name: `${PREFIX}הסרה`, from: D30 });
    await remove(owner.id, id);
    expect(await row(id)).toMatchObject({ cancelled: true });
    expect(await notices(bizOwner.id, `${PREFIX}הסרה`, CHANGE)).toBe(2);
    expect(await notices(bizAdmin.id, `${PREFIX}הסרה`, CHANGE)).toBe(0);
    const removed = await asAdmin(async (q) => (await q<{ body: string }>("select body from public.notifications where user_id = $1 and title = $2 and body like $3 limit 1", [bizOwner.id, CHANGE, `${PREFIX}הסרה %`])).rows[0].body);
    expect(removed).toContain("לא יצטרף לרשימת קבלני המשנה");
    // a cancelled entry is not readable by customers; platform staff list it through the platform function
    const staff = await createUser("adm01s-readonly-list");
    await makeStaff(staff.id, "readonly");
    for (const who of [owner.id, staff.id]) {
      const ids = await asMfaUser(who, async (q) => (await q<{ id: string; cancelled_at: string | null }>("select id, cancelled_at from public.platform_list_subprocessors()")).rows);
      expect(ids.find((r) => r.id === id)?.cancelled_at).not.toBeNull();
    }
    expect((await pgError(asMfaUser(bizOwner.id, (q) => q("select * from public.platform_list_subprocessors()")))).code).toBe("42501");
    expect((await pgError(asUser(staff.id, (q) => q("select * from public.platform_list_subprocessors()")))).code).toBe("42501");
    // the audience count is for the platform owner: one per business per active owner
    const audience = await asMfaUser(owner.id, async (q) => (await q<{ n: number }>("select public.platform_subprocessor_audience() as n")).rows[0].n);
    const expected = await asAdmin((q) => count(q, "select 1 from public.memberships m join public.organizations o on o.id = m.organization_id where m.role = 'owner' and m.status = 'active' and o.deleted_at is null"));
    expect(audience).toBe(expected);
    expect((await pgError(asMfaUser(staff.id, (q) => q("select public.platform_subprocessor_audience()")))).code).toBe("42501");
    // the last-change day: live entries added or changed, entries removed, entries that ended (rolled back)
    const changed = await pgError(
      asAdmin(async (q) => {
        await q("alter table public.subprocessors disable trigger user");
        await q("update public.subprocessors set created_at = '2026-01-01T10:00:00Z', updated_at = '2026-01-01T10:00:00Z', cancelled_at = case when cancelled_at is null then null else '2026-01-01T10:00:00Z'::timestamptz end, ends_on = null");
        const day = async () => (await q<{ l: PublicList<unknown> }>("select public.subprocessors_public_page() as l")).rows[0].l.updated_on;
        expect(await day()).toBe("2026-01-01");
        // a removed entry moves it, though it is not listed
        await q("update public.subprocessors set cancelled_at = '2026-02-02T10:00:00Z' where id = $1", [id]);
        expect(await day()).toBe("2026-02-02");
        // an entry that ended moves it to its end day, though it is not listed
        await q("update public.subprocessors set ends_on = '2026-10-20' where name = 'Vercel'");
        expect(await day()).toBe("2026-10-20");
        // a live entry's change moves it
        await q("update public.subprocessors set updated_at = '2026-10-22T10:00:00Z' where name = 'Supabase'");
        expect(await day()).toBe("2026-10-22");
        throw Object.assign(new Error("rollback"), { code: "ok" });
      }),
    );
    expect(changed.code).toBe("ok");
    expect(await logs("subprocessor.remove", id)).toBe(1);
    const list = await asService(async (q) => (await q<{ l: PublicList<{ name: string }> }>("select public.subprocessors_public_page() as l")).rows[0].l.entries);
    expect(list.some((e) => e.name === `${PREFIX}הסרה`)).toBe(false);
    expect((await pgError(remove(owner.id, id))).code).toBe("P0002");
    expect((await pgError(update(owner.id, id, { name: `${PREFIX}הסרה`, from: D30 }))).code).toBe("P0002");
    const revive = await pgError(asAdmin((q) => q("update public.subprocessors set cancelled_at = null where id = $1", [id])));
    expect([revive.code, revive.hint]).toEqual(["P0001", "subprocessor:in_force"]);
  });

  it("an entry in force is locked for every writer; it ends only from a future day", async () => {
    for (const run of [
      () => update(owner.id, seeded, { name: "Supabase 2", purpose: "מסד הנתונים, ההתחברות, האימות הדו-שלבי ועדכונים בזמן אמת.", data: "כל המידע בשירות.", from: "2026-10-13" }),
      () => update(owner.id, seeded, { name: "Supabase", purpose: "מסד הנתונים, ההתחברות, האימות הדו-שלבי ועדכונים בזמן אמת.", data: "כל המידע בשירות.", from: D30 }),
      () => remove(owner.id, seeded),
      () => end(owner.id, seeded, "2026-01-01"),
    ]) {
      const err = await pgError(run());
      expect([err.code, err.hint]).toEqual(["P0001", "subprocessor:in_force"]);
    }
    for (const sql of ["update public.subprocessors set purpose = 'x' where id = $1", "update public.subprocessors set cancelled_at = now() where id = $1", "delete from public.subprocessors where id = $1"]) {
      const err = await pgError(asAdmin((q) => q(sql, [seeded])));
      expect([err.code, err.hint], sql).toEqual(["P0001", "subprocessor:in_force"]);
    }
    // a location or website that was empty may be filled once (rolled back: the seed stays as it is)
    const filled = await pgError(
      asMfaUser(owner.id, async (q) => {
        await q("select public.platform_update_subprocessor($1, 'Supabase', 'מסד הנתונים, ההתחברות, האימות הדו-שלבי ועדכונים בזמן אמת.', 'כל המידע בשירות.', 'האיחוד האירופי', null, '2026-10-13')", [seeded]);
        expect((await q<{ l: string }>("select location as l from public.platform_list_subprocessors() where id = $1", [seeded])).rows[0].l).toBe("האיחוד האירופי");
        await expect(
          q("select public.platform_update_subprocessor($1, 'Supabase', 'מסד הנתונים, ההתחברות, האימות הדו-שלבי ועדכונים בזמן אמת.', 'כל המידע בשירות.', 'ישראל', null, '2026-10-13')", [seeded]),
        ).rejects.toMatchObject({ hint: "subprocessor:in_force" });
        throw Object.assign(new Error("rollback"), { code: "ok" });
      }),
    );
    expect(filled.code).toBe("ok");

    // a future end day, moved, cleared, logged; listed until it comes
    const id = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.subprocessors where name = 'Vercel'")).rows[0].id);
    await end(owner.id, id, D30);
    await end(owner.id, id, D30);
    await end(owner.id, id, D20);
    // an entry in force leaving is announced once per end day, per business per owner
    expect(await notices(bizOwner.id, "Vercel", CHANGE)).toBe(4);
    const ending = await asAdmin(async (q) => (await q<{ body: string }>("select body from public.notifications where user_id = $1 and title = $2 and organization_id = $3 order by created_at desc limit 1", [bizOwner.id, CHANGE, orgA])).rows[0].body);
    expect(ending).toContain("יוסר מרשימת קבלני המשנה");
    const l = await asService(async (q) => (await q<{ l: PublicList<{ name: string; ends_on: string | null }> }>("select public.subprocessors_public_page() as l")).rows[0].l.entries);
    expect(l.find((e) => e.name === "Vercel")?.ends_on).toBe(D20);
    await end(owner.id, id, null);
    // clearing an announced end day is announced: it stays
    expect(await notices(bizOwner.id, "Vercel", CHANGE)).toBe(6);
    const stays = await asAdmin(async (q) => (await q<{ body: string }>("select body from public.notifications where user_id = $1 and title = $2 and organization_id = $3 and body like 'Vercel %' order by created_at desc, id desc limit 1", [bizOwner.id, CHANGE, orgA])).rows[0].body);
    expect(stays).toContain("יישאר ברשימת קבלני המשנה");
    // D1 -> D2 -> D1 announces each step, the return included
    await end(owner.id, id, D30);
    await end(owner.id, id, D20);
    await end(owner.id, id, D30);
    expect(await notices(bizOwner.id, "Vercel", CHANGE)).toBe(12);
    await end(owner.id, id, null);
    expect(await notices(bizOwner.id, "Vercel", CHANGE)).toBe(14);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'subprocessor.end' and details->>'id' = $1", [id]))).toBe(7);
    // an ended entry is locked, and no longer listed
    await asAdmin(async (q) => {
      await q("alter table public.subprocessors disable trigger subprocessors_guard");
      await q("update public.subprocessors set ends_on = current_date where id = $1", [id]);
      await q("alter table public.subprocessors enable trigger subprocessors_guard");
      const l = (await q<{ l: PublicList<{ name: string }> }>("select public.subprocessors_public_page() as l")).rows[0].l.entries;
      expect(l.some((e) => e.name === "Vercel")).toBe(false);
      await expect(q("update public.subprocessors set ends_on = null where id = $1", [id])).rejects.toMatchObject({ hint: "subprocessor:in_force" });
      throw Object.assign(new Error("rollback"), { code: "ok" });
    }).catch((e) => expect(e.code).toBe("ok"));
    expect(await row(id)).toMatchObject({ ends_on: null });
  });

  it("a suspended owner and a deleted business are not told", async () => {
    const other = await createUser("adm01s-suspended-owner");
    const org = await createOrg(other.id);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, other.id]));
    const gone = await createUser("adm01s-deleted-business-owner");
    const goneOrg = await createOrg(gone.id);
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [goneOrg]));
    await add(owner.id, { name: `${PREFIX}מושעה`, from: D30 });
    expect(await notices(other.id, `${PREFIX}מושעה`)).toBe(0);
    expect(await notices(gone.id, `${PREFIX}מושעה`)).toBe(0);
    // the same owner's live business is told, so the deleted one was skipped by the business rule
    const liveOrg = await createOrg(gone.id, "עסק חי");
    await add(owner.id, { name: `${PREFIX}חי`, from: D30 });
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and title = $2 and body like $3 and organization_id = $4", [gone.id, TITLE, `${PREFIX}חי %`, liveOrg]))).toBe(1);
    expect(await notices(gone.id, `${PREFIX}חי`)).toBe(1);
  });

  it("the website never reaches the public page", async () => {
    await add(owner.id, { name: `${PREFIX}אתר`, website: "https://secret-site.example/path", from: D30 });
    const page = await asService(async (q) => (await q<{ l: PublicList<Record<string, unknown>> }>("select public.subprocessors_public_page() as l")).rows[0].l);
    const entry = page.entries.find((e) => e.name === `${PREFIX}אתר`);
    expect(entry).toBeTruthy();
    expect(Object.keys(entry!)).not.toContain("website");
    expect(JSON.stringify(page)).not.toContain("secret-site.example");
  });

  it("the public page answers at most 60 reads a minute in total, then refuses", async () => {
    // each step runs in one transaction, so now() and its minute are fixed: no minute boundary can flake it
    expect((await pgError(asService((q) => q("select * from app.subprocessor_page_reads")))).code).toBe("42501");
    const page = async (q: Query) => (await q<{ l: Record<string, unknown> }>("select public.subprocessors_public_page() as l")).rows[0].l;
    const counter = async (q: Query) =>
      (await q<{ reads: number; ahead: boolean }>("select reads, minute > date_trunc('minute', now()) as ahead from app.subprocessor_page_reads")).rows[0];
    await asAdmin(async (q) => {
      await q("insert into app.subprocessor_page_reads (id, minute, reads) values (1, date_trunc('minute', now()), 59) on conflict (id) do update set minute = excluded.minute, reads = 59");
      await q("set local role service_role");
      expect(await page(q)).toHaveProperty("entries");
      expect(await page(q)).toEqual({ refused: "rate" });
    });
    // a new minute starts again
    await asAdmin(async (q) => {
      await q("update app.subprocessor_page_reads set minute = date_trunc('minute', now()) - interval '1 minute', reads = 500");
      expect(await page(q)).toHaveProperty("entries");
      expect((await counter(q)).reads).toBe(1);
    });
    // a late commit never moves the minute back: it counts toward the newer minute
    await asAdmin(async (q) => {
      await q("update app.subprocessor_page_reads set minute = date_trunc('minute', now()) + interval '1 minute', reads = 5");
      await page(q);
      expect(await counter(q)).toEqual({ reads: 6, ahead: true });
      await q("update app.subprocessor_page_reads set minute = date_trunc('minute', now()), reads = 0");
    });
    // the counter keeps no address or input: one row, a minute and a count
    const columns = await asAdmin(async (q) =>
      (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'subprocessor_page_reads' order by 1")).rows.map((r) => r.c),
    );
    expect(columns).toEqual(["id", "minute", "reads"]);
  });
});
