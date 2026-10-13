import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

const rateAt = (userId: string, day: string | null) =>
  asUser(userId, async (q) => (await q<{ r: number | null }>("select app.vat_rate_at($1::date) as r", [day])).rows[0].r);

/** TAX-03: VAT rates by effective date (platform table public.vat_rates). */
describe("VAT rates", () => {
  let user: { id: string };

  beforeAll(async () => {
    user = await createUser("vat-user");
    await createOrg(user.id);
  });

  it("is seeded: 17% from 1 October 2015, 18% from 1 January 2025", async () => {
    const rows = await asUser(user.id, async (q) =>
      (await q<{ effective_from: string; rate_bp: number }>("select to_char(effective_from, 'YYYY-MM-DD') as effective_from, rate_bp from public.vat_rates order by effective_from")).rows,
    );
    // contained, not equal: a later migration may add future rates without touching this test
    expect(rows).toEqual(
      expect.arrayContaining([
        { effective_from: "2015-10-01", rate_bp: 1700 },
        { effective_from: "2025-01-01", rate_bp: 1800 },
      ]),
    );
    expect(rows[0]).toEqual({ effective_from: "2015-10-01", rate_bp: 1700 });
  });

  it("a document uses the rate of its own date; the boundaries are exact", async () => {
    expect(await rateAt(user.id, "2024-12-31")).toBe(1700);
    expect(await rateAt(user.id, "2025-01-01")).toBe(1800);
    expect(await rateAt(user.id, "2026-10-13")).toBe(1800);
    expect(await rateAt(user.id, "2015-10-01")).toBe(1700);
    // before the first known rate, and for no date: no rate, never a guess
    expect(await rateAt(user.id, "2015-09-30")).toBeNull();
    expect(await rateAt(user.id, null)).toBeNull();
  });

  it("a change of rate is a new row: older dates keep the old rate", async () => {
    // inside a rolled-back transaction, as the platform would add it
    // far in the future, so a real future rate added by a later migration does not clash
    const baseline = await rateAt(user.id, "2099-06-30");
    let result: unknown;
    await asAdmin(async (q) => {
      await q("insert into public.vat_rates (effective_from, rate_bp) values ('2099-07-01', 1900)");
      const rows = await q<{ before: number; on: number; after: number }>(
        "select app.vat_rate_at('2099-06-30') as before, app.vat_rate_at('2099-07-01') as on, app.vat_rate_at('2099-12-31') as after",
      );
      result = rows.rows[0];
      throw new Error("rollback");
    }).catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });
    expect(result).toEqual({ before: baseline, on: 1900, after: 1900 });
    expect(await rateAt(user.id, "2099-12-31")).toBe(baseline);
  });

  it("one rate per day, and a rate between 0% and 100%", async () => {
    expect((await pgError(asAdmin((q) => q("insert into public.vat_rates (effective_from, rate_bp) values ('2025-01-01', 1900)")))).code).toBe("23505");
    expect((await pgError(asAdmin((q) => q("insert into public.vat_rates (effective_from, rate_bp) values ('2031-01-01', -1)")))).code).toBe("23514");
    expect((await pgError(asAdmin((q) => q("insert into public.vat_rates (effective_from, rate_bp) values ('2031-01-01', 10001)")))).code).toBe("23514");
  });

  it("no client writes it; anonymous callers cannot even read it", async () => {
    for (const sql of [
      "insert into public.vat_rates (effective_from, rate_bp) values ('2031-01-01', 0)",
      "update public.vat_rates set rate_bp = 0",
      "delete from public.vat_rates",
    ]) {
      expect((await pgError(asUser(user.id, (q) => q(sql)))).code, sql).toBe("42501");
    }
    expect((await pgError(asAnon((q) => q("select * from public.vat_rates")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select app.vat_rate_at(current_date)")))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.vat_rates where rate_bp = 0"))).toBe(0);
  });

  it("the server (later: document functions) reads it too", async () => {
    expect(await asService(async (q) => (await q<{ r: number }>("select app.vat_rate_at('2025-06-01') as r")).rows[0].r)).toBe(1800);
  });

  it("with TAX-01: an exempt business has no VAT line whatever the rate", async () => {
    const owner = await createUser("vat-exempt-owner");
    const org = await createOrg(owner.id);
    await asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'exempt')", [org]));
    const row = await asUser(owner.id, async (q) =>
      (await q<{ charges: boolean; rate: number }>("select app.org_charges_vat($1) as charges, app.vat_rate_at('2025-06-01') as rate", [org])).rows[0],
    );
    expect(row).toEqual({ charges: false, rate: 1800 });
  });

  // ---------------------------------------------------------------------------
  // Owner's checks (13 October 2026)
  // ---------------------------------------------------------------------------
  const docRate = (userId: string, day: string) =>
    asUser(userId, async (q) => (await q<{ r: number }>("select app.document_vat_rate($1::date) as r", [day])).rows[0].r);

  // runs fn as the database owner (the way a migration writes) and rolls everything back
  const inRolledBack = async <T,>(fn: (q: Query) => Promise<T>): Promise<T> => {
    let out: T | undefined;
    await asAdmin(async (q) => {
      out = await fn(q);
      throw new Error("rollback");
    }).catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });
    return out as T;
  };

  it("owner check (a): a document dated before the first rate is refused with hint vat:before_table", async () => {
    const err = await pgError(docRate(user.id, "2015-09-30"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("vat:before_table");
    const noDate = await pgError(asUser(user.id, (q) => q("select app.document_vat_rate(null)")));
    expect(noDate.code).toBe("22004");
    expect(await docRate(user.id, "2015-10-01")).toBe(1700);
  });

  it("owner check 1: an 18% row from 2025-01-01 exists, and a document dated today is at 18%", async () => {
    expect(await asUser(user.id, (q) => count(q, "select 1 from public.vat_rates where effective_from = '2025-01-01' and rate_bp = 1800"))).toBe(1);
    const today = await asUser(user.id, async (q) => (await q<{ r: number }>("select app.document_vat_rate(current_date) as r")).rows[0].r);
    expect(today).toBe(1800);
  });

  it("owner check 2: the rate follows the document date, not when it was created", async () => {
    // both documents are created now (2026); only their dates differ
    const rows = await asUser(user.id, async (q) =>
      (
        await q<{ d: string; r: number }>(
          "select to_char(d, 'YYYY-MM-DD') as d, app.document_vat_rate(d) as r from (values ('2024-12-31'::date), ('2025-01-01'::date)) v(d) order by d",
        )
      ).rows,
    );
    expect(rows).toEqual([
      { d: "2024-12-31", r: 1700 },
      { d: "2025-01-01", r: 1800 },
    ]);
  });

  it("owner check 3: a future rate is a row added like a migration, with no code change", async () => {
    const baseline = await asUser(user.id, async (q) =>
      (await q<{ before: number; today: number }>("select app.document_vat_rate('2098-12-31') as before, app.document_vat_rate(current_date) as today")).rows[0],
    );
    expect(baseline.today).toBe(1800);
    const result = await inRolledBack(async (q) => {
      await q("insert into public.vat_rates (effective_from, rate_bp, note) values ('2099-01-01', 1900, '19%')");
      return (
        await q<{ before: number; on: number; today: number }>(
          "select app.document_vat_rate('2098-12-31') as before, app.document_vat_rate('2099-01-01') as on, app.document_vat_rate(current_date) as today",
        )
      ).rows[0];
    });
    expect(result).toEqual({ before: baseline.before, on: 1900, today: 1800 });
  });

  it("owner check 4: a sent document keeps the rate and amounts it stored when the table changes later", async () => {
    // No quote/document table exists yet (quote and document waves). This stands in for one with the rule
    // they must follow: the rate and the totals are stored on the document when it is made.
    const result = await inRolledBack(async (q) => {
      await q(
        `create temp table sent_document (doc_date date not null, net_agorot bigint not null, vat_rate_bp integer not null, vat_agorot bigint not null)`,
      );
      await q(
        `insert into sent_document (doc_date, net_agorot, vat_rate_bp, vat_agorot)
         select d, 27000, app.document_vat_rate(d), round(27000 * app.document_vat_rate(d) / 10000.0)
           from (values ('2025-06-01'::date)) v(d)`,
      );
      // later: the table changes, both ways (a new row covering the date, and an edited row). Editing a rate
      // already in force is refused by vat_rates_guard; only a migration that disables the trigger can, as here.
      await q("alter table public.vat_rates disable trigger vat_rates_guard");
      await q("insert into public.vat_rates (effective_from, rate_bp) values ('2025-03-01', 1900)");
      await q("update public.vat_rates set rate_bp = 1850 where effective_from = '2025-01-01'");
      return (
        await q<{ stored_rate: number; stored_vat: string; rate_now: number }>(
          "select vat_rate_bp as stored_rate, vat_agorot::text as stored_vat, app.document_vat_rate(doc_date) as rate_now from sent_document",
        )
      ).rows[0];
    });
    // 270.00 at 18% = 48.60 (SPEC-ADDITIONS 4.6), unchanged although today's lookup for that date would give 19%
    expect(result).toEqual({ stored_rate: 1800, stored_vat: "4860", rate_now: 1900 });
  });

  it("a rate already in force is never changed or removed; a future one can be corrected", async () => {
    // as the database owner: even a migration is refused unless it disables the trigger on purpose
    for (const sql of [
      "update public.vat_rates set rate_bp = 1850 where effective_from = '2025-01-01'",
      "update public.vat_rates set effective_from = '2025-02-01' where effective_from = '2025-01-01'",
      "delete from public.vat_rates where effective_from = '2015-10-01'",
    ]) {
      const err = await pgError(asAdmin((q) => q(sql)));
      expect(err.code, sql).toBe("P0001");
      expect(err.hint, sql).toBe("vat:rate_in_force");
    }
    const result = await inRolledBack(async (q) => {
      await q("insert into public.vat_rates (effective_from, rate_bp) values ('2099-03-01', 1900)");
      // a future row may be corrected, moved within the future, or removed
      await q("update public.vat_rates set rate_bp = 1950 where effective_from = '2099-03-01'");
      await q("update public.vat_rates set effective_from = '2099-04-01' where effective_from = '2099-03-01'");
      // but not moved to a day that has already begun
      const moved = await q("savepoint s").then(() =>
        q("update public.vat_rates set effective_from = (now() at time zone 'Asia/Jerusalem')::date where effective_from = '2099-04-01'").then(
          () => "allowed",
          (err: { hint?: string }) => err.hint,
        ),
      );
      await q("rollback to savepoint s");
      const removed = (await q("delete from public.vat_rates where effective_from = '2099-04-01'")).rowCount;
      return { moved, removed };
    });
    expect(result).toEqual({ moved: "vat:rate_in_force", removed: 1 });
    // a note may still be fixed on any row
    await inRolledBack((q) => q("update public.vat_rates set note = '18% (2025)' where effective_from = '2025-01-01'"));
  });

  it("a new rate may not start on a day that has begun (Israel time); the seed can run again", async () => {
    for (const day of ["2026-01-01", "(now() at time zone 'Asia/Jerusalem')::date"]) {
      const sql = `insert into public.vat_rates (effective_from, rate_bp) values (${day.startsWith("(") ? day : `'${day}'`}, 1900)`;
      const err = await pgError(asAdmin((q) => q(sql)));
      expect([err.code, err.hint], sql).toEqual(["P0001", "vat:rate_in_force"]);
    }
    const ok = await inRolledBack(async (q) =>
      (await q("insert into public.vat_rates (effective_from, rate_bp) values ((now() at time zone 'Asia/Jerusalem')::date + 1, 1900)")).rowCount,
    );
    expect(ok).toBe(1);
    // the migration's seed, run a second time: the stored days pass the guard and are skipped
    const again = await inRolledBack(async (q) =>
      (
        await q(
          "insert into public.vat_rates (effective_from, rate_bp, note) values ('2015-10-01', 1700, '17%'), ('2025-01-01', 1800, '18%') on conflict (effective_from) do nothing",
        )
      ).rowCount,
    );
    expect(again).toBe(0);
  });
});
