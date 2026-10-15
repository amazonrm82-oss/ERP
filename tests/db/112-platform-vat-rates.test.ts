import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

// ADM-01 (owner, 15 October 2026): VAT rates managed from the platform panel. Platform owners only, with
// two-step verification; future days only; a rate whose day has begun is locked; every action is logged.

// platform staff made here leave at the end: another file checks it holds the only platform owner
const staffIds: string[] = [];
const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};

// far-future days, so they never meet a real rate a later migration adds
const D1 = "2096-01-01";
const D2 = "2096-02-01";
const D3 = "2096-03-01";
const D4 = "2096-04-01";

afterAll(async () => {
  // test rows are all in the future, which the guard lets go
  await asAdmin((q) => q("delete from public.vat_rates where effective_from >= '2096-01-01' and effective_from < '2097-01-01'"));
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

type Row = { id: string; effective_from: string; rate_bp: number; note: string | null; cancelled: boolean };
const rowOn = async (day: string): Promise<Row | undefined> =>
  (
    await asAdmin((q) =>
      q<Row>(
        "select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, rate_bp, note, cancelled_at is not null as cancelled from public.vat_rates where effective_from = $1",
        [day],
      ),
    )
  ).rows[0];
const rateAt = (day: string) => asAdmin(async (q) => (await q<{ r: number | null }>("select app.vat_rate_at($1::date) as r", [day])).rows[0].r);
const logs = (action: string, id: string) =>
  asAdmin((q) => count(q, "select 1 from app.platform_log where action = $1 and details->>'id' = $2", [action, id]));

const add = (userId: string, day: string, bp: number, note: string | null = null) =>
  asMfaUser(userId, async (q) => (await q<{ id: string }>("select public.platform_add_vat_rate($1::date, $2, $3) as id", [day, bp, note])).rows[0].id);
const update = (userId: string, id: string, day: string, bp: number, note: string | null = null) =>
  asMfaUser(userId, async (q) => (await q<{ id: string }>("select public.platform_update_vat_rate($1, $2::date, $3, $4) as id", [id, day, bp, note])).rows[0].id);
const remove = (userId: string, id: string) => asMfaUser(userId, (q) => q("select public.platform_remove_vat_rate($1)", [id]));

describe("ADM-01: VAT rates from the platform panel", () => {
  let owner: { id: string };
  let seeded: string;

  beforeAll(async () => {
    owner = await createUser("adm01-platform-owner");
    await makeStaff(owner.id, "owner");
    seeded = (await rowOn("2025-01-01"))!.id;
  });

  it("the platform owner with two-step verification adds a future rate; it is logged and counts from its day", async () => {
    const before = await rateAt("2095-12-31");
    const id = await add(owner.id, D1, 1900, "  19% בדיקה  ");
    expect(await rowOn(D1)).toEqual({ id, effective_from: D1, rate_bp: 1900, note: "19% בדיקה", cancelled: false });
    expect(await rateAt("2095-12-31")).toBe(before);
    expect(await rateAt(D1)).toBe(1900);
    expect(await logs("vat_rate.add", id)).toBe(1);
    const entry = await asAdmin(
      async (q) => (await q<{ actor_id: string; organization_id: string | null; details: Record<string, unknown> }>("select actor_id, organization_id, details from app.platform_log where action = 'vat_rate.add' and details->>'id' = $1", [id])).rows[0],
    );
    expect(entry.actor_id).toBe(owner.id);
    expect(entry.organization_id).toBeNull();
    expect(entry.details).toMatchObject({ effective_from: D1, rate_bp: 1900, note: "19% בדיקה" });
  });

  it("other platform roles, a session without two-step verification, customers and visitors are refused", async () => {
    for (const role of ["support", "finance", "readonly"]) {
      const staff = await createUser(`adm01-${role}`);
      await makeStaff(staff.id, role);
      expect((await pgError(add(staff.id, D4, 1900))).code, role).toBe("42501");
      expect((await pgError(update(staff.id, seeded, D4, 1900))).code, role).toBe("42501");
      expect((await pgError(remove(staff.id, seeded))).code, role).toBe("42501");
    }
    // the platform owner on a password-only session
    expect((await pgError(asUser(owner.id, (q) => q("select public.platform_add_vat_rate($1::date, 1900)", [D4])))).code).toBe("42501");
    // the owner of a business is not platform staff
    const customer = await createUser("adm01-customer");
    await createOrg(customer.id);
    expect((await pgError(add(customer.id, D4, 1900))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.platform_add_vat_rate($1::date, 1900)", [D4])))).code).toBe("42501");
    // and a client still cannot write the table directly
    expect((await pgError(asMfaUser(owner.id, (q) => q("insert into public.vat_rates (effective_from, rate_bp) values ($1, 1900)", [D4])))).code).toBe("42501");
    expect((await pgError(asMfaUser(owner.id, (q) => q("update public.vat_rates set cancelled_at = now()")))).code).toBe("42501");
    expect(await rowOn(D4)).toBeUndefined();
  });

  it("only a day after today in Israel; a sane rate; a short note; one live rate per day", async () => {
    for (const day of ["2026-01-01", "(now() at time zone 'Asia/Jerusalem')::date"]) {
      const sql = `select public.platform_add_vat_rate(${day.startsWith("(") ? day : `'${day}'::date`}, 1900)`;
      const err = await pgError(asMfaUser(owner.id, (q) => q(sql)));
      expect([err.code, err.hint], day).toEqual(["P0001", "vat:rate_in_force"]);
    }
    // tomorrow is fine (rolled back by the error at the end)
    const tomorrow = await pgError(
      asMfaUser(owner.id, async (q) => {
        await q("select public.platform_add_vat_rate((now() at time zone 'Asia/Jerusalem')::date + 1, 1900)");
        throw Object.assign(new Error("rollback"), { code: "ok" });
      }),
    );
    expect(tomorrow.code).toBe("ok");
    for (const bp of [-1, 10001]) expect((await pgError(add(owner.id, D4, bp))).code, String(bp)).toBe("22023");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_add_vat_rate($1::date, null)", [D4])))).code).toBe("22023");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_add_vat_rate(null, 1900)")))).code).toBe("22023");
    expect((await pgError(add(owner.id, D4, 1900, "x".repeat(201)))).code).toBe("22023");
    const taken = await pgError(add(owner.id, D1, 2000));
    expect([taken.code, taken.hint]).toEqual(["P0001", "vat:date_taken"]);
    expect(await rowOn(D4)).toBeUndefined();
    expect((await rowOn(D1))!.rate_bp).toBe(1900);
  });

  it("a future rate may be corrected and moved within the future; each change is logged", async () => {
    const id = (await rowOn(D1))!.id;
    expect(await update(owner.id, id, D1, 1950, "תוקן")).toBe(id);
    expect(await rowOn(D1)).toMatchObject({ id, rate_bp: 1950, note: "תוקן", cancelled: false });
    expect(await update(owner.id, id, D2, 1950, "תוקן")).toBe(id);
    expect(await rowOn(D1)).toBeUndefined();
    expect(await rowOn(D2)).toMatchObject({ id, rate_bp: 1950 });
    expect(await logs("vat_rate.update", id)).toBe(2);
    // not onto a day that has begun, not onto another live rate's day
    const past = await pgError(update(owner.id, id, "2026-01-01", 1950));
    expect([past.code, past.hint]).toEqual(["P0001", "vat:rate_in_force"]);
    const other = await add(owner.id, D3, 2000);
    const taken = await pgError(update(owner.id, id, D3, 1950));
    expect([taken.code, taken.hint]).toEqual(["P0001", "vat:date_taken"]);
    // nothing changed by the refusals
    expect(await rowOn(D2)).toMatchObject({ id, rate_bp: 1950 });
    expect(await rowOn(D3)).toMatchObject({ id: other, rate_bp: 2000 });
  });

  it("a rate in force is locked: no correction, no removal, for the platform owner too", async () => {
    for (const run of [() => update(owner.id, seeded, "2025-01-01", 1850), () => update(owner.id, seeded, D4, 1800), () => remove(owner.id, seeded)]) {
      const err = await pgError(run());
      expect([err.code, err.hint]).toEqual(["P0001", "vat:rate_in_force"]);
    }
    expect(await rowOn("2025-01-01")).toMatchObject({ rate_bp: 1800, cancelled: false });
    // and the guard holds for every writer, the database owner included: cancelling or reviving a row in force
    const err = await pgError(asAdmin((q) => q("update public.vat_rates set cancelled_at = now() where id = $1", [seeded])));
    expect([err.code, err.hint]).toEqual(["P0001", "vat:rate_in_force"]);
    expect(await logs("vat_rate.update", seeded)).toBe(0);
    expect(await logs("vat_rate.remove", seeded)).toBe(0);
  });

  it("removing a future rate cancels it: it no longer counts, is logged, and the day can be used again", async () => {
    const id = (await rowOn(D3))!.id;
    expect(await rateAt(D3)).toBe(2000);
    await remove(owner.id, id);
    expect(await rowOn(D3)).toMatchObject({ id, cancelled: true });
    // the earlier rate (D2) applies again from D3
    expect(await rateAt(D3)).toBe(1950);
    expect(await asAdmin(async (q) => (await q<{ r: number }>("select app.document_vat_rate($1::date) as r", [D3])).rows[0].r)).toBe(1950);
    expect(await logs("vat_rate.remove", id)).toBe(1);
    // a cancelled rate cannot be removed or corrected again
    expect((await pgError(remove(owner.id, id))).code).toBe("P0002");
    expect((await pgError(update(owner.id, id, D3, 2100))).code).toBe("P0002");
    // adding on that day again revives the same row
    expect(await add(owner.id, D3, 2100)).toBe(id);
    expect(await rowOn(D3)).toMatchObject({ id, rate_bp: 2100, cancelled: false });
    expect(await rateAt(D3)).toBe(2100);
    // moving a live rate onto a cancelled day: that row takes the values, the moved one is cancelled
    await remove(owner.id, id);
    const moving = (await rowOn(D2))!.id;
    expect(await update(owner.id, moving, D3, 1975)).toBe(id);
    expect(await rowOn(D3)).toMatchObject({ id, rate_bp: 1975, cancelled: false });
    expect(await rowOn(D2)).toMatchObject({ id: moving, cancelled: true });
    expect(await rateAt(D2)).toBe(await rateAt("2095-12-31"));
  });

  it("no API role may truncate the table (a truncate skips the row guard)", async () => {
    const rows = await asAdmin(
      async (q) =>
        (await q<{ role: string; t: boolean }>("select r as role, has_table_privilege(r, 'public.vat_rates', 'truncate') as t from unnest(array['anon', 'authenticated', 'service_role']) r")).rows,
    );
    expect(rows).toEqual([
      { role: "anon", t: false },
      { role: "authenticated", t: false },
      { role: "service_role", t: false },
    ]);
    expect((await pgError(asService((q) => q("truncate public.vat_rates")))).code).toBe("42501");
    expect(await rowOn("2025-01-01")).toMatchObject({ rate_bp: 1800 });
  });

  it("the new functions are not executable by anon, and the helpers not by clients", async () => {
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ fn: string; anon: boolean; auth: boolean }>(
            `select p.oid::regprocedure::text as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as auth
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname like 'platform_%vat_rate')
                 or (n.nspname = 'app' and p.proname in ('vat_rate_input', 'vat_rate_place'))
              order by 1`,
          )
        ).rows,
    );
    expect(grants).toHaveLength(5);
    for (const g of grants) {
      expect(g.anon, g.fn).toBe(false);
      expect(g.auth, g.fn).toBe(g.fn.startsWith("platform_"));
    }
  });
});
