import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import sourceCases from "../unit/fixtures/landing-sources.json";
import { asAdmin, asAnon, asService, asUser, closePool, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

// LND-14 (owner (388) א, CLAUDE.md hard rule 5, LND-13's pattern): cookieless counters on the landing page. One definer function
// for the service role only, daily counters per kind and source in schema app (never a row per visitor), a rate limit that keeps
// only a bucket number, the source folded to a closed shape, and one platform read (counts, aal2, owner/support/readonly).

const hash = () => randomUUID().replaceAll("-", "").padEnd(64, "b").slice(0, 64);

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super("rollback");
  }
}

async function rolledBack<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  try {
    await asAdmin(async (q) => {
      throw new Rollback(await fn(q));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
  throw new Error("unreachable");
}

/** Runs one event as the service role inside the caller's transaction, then returns to the superuser. */
async function event(q: Query, kind: string | null, source: string | null, ipHash: string | null = hash()) {
  await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  await q("set local role service_role");
  const r = (await q<{ r: Record<string, unknown> }>("select public.landing_event($1, $2, $3) as r", [kind, source, ipHash])).rows[0].r;
  await q("reset role");
  return r;
}

const counters = async (q: Query) =>
  (await q<{ kind: string; source: string; n: number }>("select kind, source, n from app.landing_event_days order by kind, source")).rows;

describe("landing page measurement (LND-14)", () => {
  it("only the service role may count; no API role reads the tables or runs the helpers", async () => {
    const user = await createUser("landing");
    expect((await pgError(asAnon((q) => q("select public.landing_event('visit', null, null)")))).code).toBe("42501");
    expect((await pgError(asUser(user.id, (q) => q("select public.landing_event('visit', null, null)")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.platform_landing_measurement(30)")))).code).toBe("42501");
    for (const table of ["app.landing_event_days", "app.landing_event_counts"]) {
      expect((await pgError(asService((q) => q(`select * from ${table}`)))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q(`select * from ${table}`)))).code).toBe("42501");
      expect((await pgError(asUser(user.id, (q) => q(`select * from ${table}`)))).code).toBe("42501");
    }
    for (const fn of ["app.run_landing_event_purge()", "app.landing_event_purge_rows(10)", "app.landing_event_source('x')"]) {
      expect((await pgError(asService((q) => q(`select ${fn}`)))).code).toBe("42501");
    }
    const acl = await asAdmin(async (q) =>
      (
        await q<{ fn: string; grantee: string }>(`
          select p.proname as fn, coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
          from pg_proc p, aclexplode(p.proacl) a
          where p.oid in ('public.landing_event(text, text, text)'::regprocedure, 'public.platform_landing_measurement(integer)'::regprocedure)
            and a.privilege_type = 'EXECUTE' and a.grantee::regrole::text <> 'postgres'
          order by 1, 2`)
      ).rows,
    );
    expect(acl).toEqual([
      { fn: "landing_event", grantee: "service_role" },
      { fn: "platform_landing_measurement", grantee: "authenticated" },
    ]);
  });

  it("keeps daily counters per kind and source only, and folds the source", async () => {
    const result = await rolledBack(async (q) => {
      const answers = [
        await event(q, "visit", null),
        await event(q, "visit", ""),
        await event(q, "visit", " Facebook "),
        await event(q, "signup_click", "facebook"),
        await event(q, "signup", "facebook"),
        await event(q, "visit", "פייסבוק"),
        await event(q, "visit", "a b"),
        await event(q, "visit", "x".repeat(41)),
      ];
      const bad = [await event(q, "purchase", "x"), await event(q, null, "x")];
      const columns = (
        await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'landing_event_days' order by 1")
      ).rows.map((r) => r.c);
      const days = (await q<{ d: string }>("select distinct day::text as d, ((now() at time zone 'Asia/Jerusalem')::date)::text as today from app.landing_event_days")).rows;
      return { answers, bad, rows: await counters(q), columns, days };
    });
    expect(result.answers.every((a) => a.counted === true)).toBe(true);
    expect(result.bad).toEqual([{ counted: false }, { counted: false }]);
    expect(result.columns).toEqual(["day", "kind", "n", "source"]);
    expect(result.days).toHaveLength(1);
    expect(result.rows).toEqual([
      { kind: "signup", source: "facebook", n: 1 },
      { kind: "signup_click", source: "facebook", n: 1 },
      { kind: "visit", source: "direct", n: 2 },
      { kind: "visit", source: "facebook", n: 1 },
      { kind: "visit", source: "other", n: 3 },
    ]);
  });

  it("without a sender hash nothing is counted", async () => {
    const result = await rolledBack(async (q) => ({
      none: await event(q, "visit", "x", null),
      bad: await event(q, "visit", "x", "not-a-hash"),
      rows: await counters(q),
      buckets: Number((await q<{ n: number }>("select count(*)::int as n from app.landing_event_counts")).rows[0].n),
    }));
    expect(result.none).toEqual({ counted: false });
    expect(result.bad).toEqual({ counted: false });
    expect(result.rows).toEqual([]);
    expect(result.buckets).toBe(0);
  });

  it("counts a sender at most the kind's limit in 10 minutes, silently, keeping only a bucket number", async () => {
    const sender = hash();
    const result = await rolledBack(async (q) => {
      const limits = (await q<{ v: number; c: number; s: number }>("select app.landing_event_limit('visit') as v, app.landing_event_limit('signup_click') as c, app.landing_event_limit('signup') as s")).rows[0];
      const clicks = [];
      for (let i = 0; i < 11; i++) clicks.push(await event(q, "signup_click", "google", sender));
      const otherKind = await event(q, "signup", "google", sender);
      const otherSender = await event(q, "signup_click", "google");
      const rows = await counters(q);
      // the window rolls over
      await q("update app.landing_event_counts set window_start = now() - interval '11 minutes'");
      const after = await event(q, "signup_click", "google", sender);
      const columns = (
        await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'landing_event_counts' order by 1")
      ).rows.map((r) => r.c);
      return { limits, clicks, otherKind, otherSender, rows, after, columns };
    });
    expect(result.limits).toEqual({ v: 30, c: 10, s: 5 });
    expect(result.clicks.slice(0, 10).every((a) => a.counted === true)).toBe(true);
    expect(result.clicks[10]).toEqual({ counted: false });
    expect(result.otherKind).toEqual({ counted: true });
    expect(result.otherSender).toEqual({ counted: true });
    expect(result.rows).toEqual([
      { kind: "signup", source: "google", n: 1 },
      { kind: "signup_click", source: "google", n: 11 },
    ]);
    expect(result.after).toEqual({ counted: true });
    expect(result.columns).toEqual(["bucket", "kind", "n", "window_start"]);
  });

  it("past 200 sources a day a new one is counted as other", async () => {
    const result = await rolledBack(async (q) => {
      await q(
        `insert into app.landing_event_days (day, kind, source, n)
         select (now() at time zone 'Asia/Jerusalem')::date, 'visit', 's' || g, 1 from generate_series(1, 200) g`,
      );
      const fresh = await event(q, "visit", "brandnew");
      const known = await event(q, "visit", "s7");
      const rows = (await q<{ source: string; n: number }>("select source, n from app.landing_event_days where source in ('brandnew', 'other', 's7') order by 1")).rows;
      return { fresh, known, rows, cap: (await q<{ c: number }>("select app.landing_event_source_cap() as c")).rows[0].c };
    });
    expect(result.cap).toBe(200);
    expect(result.fresh).toEqual({ counted: true });
    expect(result.known).toEqual({ counted: true });
    expect(result.rows).toEqual([
      { source: "other", n: 1 },
      { source: "s7", n: 2 },
    ]);
  });

  it("the cap of 200 sources a day is shared by the three kinds", async () => {
    const result = await rolledBack(async (q) => {
      await q(
        `insert into app.landing_event_days (day, kind, source, n)
         select (now() at time zone 'Asia/Jerusalem')::date, 'visit', 's' || g, 1 from generate_series(1, 200) g`,
      );
      await event(q, "signup_click", "clicksource");
      await event(q, "signup", "signupsource");
      await event(q, "signup_click", "s9");
      return (
        await q<{ kind: string; source: string; n: number }>(
          "select kind, source, n from app.landing_event_days where kind <> 'visit' order by kind, source",
        )
      ).rows;
    });
    expect(result).toEqual([
      { kind: "signup", source: "other", n: 1 },
      { kind: "signup_click", source: "other", n: 1 },
      { kind: "signup_click", source: "s9", n: 1 },
    ]);
  });

  it("'direct' and 'other' are never held by the cap", async () => {
    const result = await rolledBack(async (q) => {
      // a day full of 200 named sources and no direct or other row yet
      await q(
        `insert into app.landing_event_days (day, kind, source, n)
         select (now() at time zone 'Asia/Jerusalem')::date, 'visit', 's' || g, 1 from generate_series(1, 200) g`,
      );
      await event(q, "visit", null);
      await event(q, "signup_click", "");
      await event(q, "visit", "not a source");
      await event(q, "visit", "brandnew");
      return (
        await q<{ kind: string; source: string; n: number }>(
          "select kind, source, n from app.landing_event_days where source in ('direct', 'other', 'brandnew') order by kind, source",
        )
      ).rows;
    });
    expect(result).toEqual([
      { kind: "signup_click", source: "direct", n: 1 },
      { kind: "visit", source: "direct", n: 1 },
      { kind: "visit", source: "other", n: 2 },
    ]);
  });

  it("app.landing_event_source runs the shared fixture as landingSource() does", async () => {
    const answers = await asAdmin(async (q) => {
      const out: Array<{ input: string | null; got: string; want: string }> = [];
      for (const c of sourceCases as Array<{ input: string | null; source: string }>) {
        const got = (await q<{ s: string }>("select app.landing_event_source($1) as s", [c.input])).rows[0].s;
        out.push({ input: c.input, got, want: c.source });
      }
      return out;
    });
    expect(answers.length).toBeGreaterThan(10);
    for (const a of answers) expect(a.got, JSON.stringify(a.input)).toBe(a.want);
  });

  it("touches no other table", async () => {
    const result = await rolledBack(async (q) => {
      const before = (await q<{ t: string; n: string }>("select relname as t, n_tup_ins + n_tup_upd + n_tup_del as n from pg_stat_xact_all_tables where schemaname in ('public', 'app', 'auth')")).rows;
      await event(q, "visit", "x");
      await event(q, "signup", "x");
      const after = (await q<{ t: string; n: string }>("select relname as t, n_tup_ins + n_tup_upd + n_tup_del as n from pg_stat_xact_all_tables where schemaname in ('public', 'app', 'auth')")).rows;
      const was = new Map(before.map((r) => [r.t, r.n]));
      return after.filter((r) => Number(r.n) !== Number(was.get(r.t) ?? 0)).map((r) => r.t).sort();
    });
    expect(result).toEqual(["landing_event_counts", "landing_event_days"]);
  });

  it("the platform read: counts per day and source, owner/support/readonly with aal2 only", async () => {
    const owner = await createUser("lm-owner");
    const support = await createUser("lm-support");
    const finance = await createUser("lm-finance");
    const readonly = await createUser("lm-readonly");
    const result = await rolledBack(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'owner'), ($2, 'support'), ($3, 'finance'), ($4, 'readonly')", [owner.id, support.id, finance.id, readonly.id]);
      await q(
        `insert into app.landing_event_days (day, kind, source, n) values
           ((now() at time zone 'Asia/Jerusalem')::date, 'visit', 'facebook', 7),
           ((now() at time zone 'Asia/Jerusalem')::date, 'signup_click', 'facebook', 3),
           ((now() at time zone 'Asia/Jerusalem')::date, 'signup', 'facebook', 1),
           ((now() at time zone 'Asia/Jerusalem')::date - 2, 'visit', 'direct', 4),
           ((now() at time zone 'Asia/Jerusalem')::date - 40, 'visit', 'direct', 99)`,
      );
      const read = async (id: string, aal: string) => {
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated", aal })]);
        await q("set local role authenticated");
        await q("savepoint s");
        const out = await q<{ r: Record<string, unknown> }>("select public.platform_landing_measurement(30) as r").then(
          (res) => res.rows[0].r,
          (e: { code?: string }) => e.code ?? "error",
        );
        await q("rollback to savepoint s");
        await q("reset role");
        return out;
      };
      return {
        owner: await read(owner.id, "aal2"),
        support: await read(support.id, "aal2"),
        readonly: await read(readonly.id, "aal2"),
        finance: await read(finance.id, "aal2"),
        ownerAal1: await read(owner.id, "aal1"),
      };
    });
    const ownerRead = result.owner as { days: number; rows: Array<Record<string, unknown>> };
    expect(ownerRead.days).toBe(30);
    expect(ownerRead.rows).toHaveLength(2);
    expect(ownerRead.rows[0]).toMatchObject({ source: "facebook", visits: 7, signup_clicks: 3, signups: 1 });
    expect(ownerRead.rows[1]).toMatchObject({ source: "direct", visits: 4, signup_clicks: null, signups: null });
    expect(Object.keys(ownerRead.rows[0]).sort()).toEqual(["day", "signup_clicks", "signups", "source", "visits"]);
    expect(typeof result.support).toBe("object");
    expect(typeof result.readonly).toBe("object");
    expect(result.finance).toBe("42501");
    expect(result.ownerAal1).toBe("42501");
  });

  it("the purge removes only counters older than 25 months; the wrapper runs it", async () => {
    const result = await rolledBack(async (q) => {
      await q(
        `insert into app.landing_event_days (day, kind, source, n) values
           ((now() at time zone 'Asia/Jerusalem')::date - interval '26 months', 'visit', 'old', 1),
           ((now() at time zone 'Asia/Jerusalem')::date - interval '24 months', 'visit', 'kept', 1)`,
      );
      const removed = (await q<{ n: number }>("select app.run_landing_event_purge() as n")).rows[0].n;
      const left = (await q<{ source: string }>("select source from app.landing_event_days where source in ('old', 'kept')")).rows.map((r) => r.source);
      return { removed, left };
    });
    expect(result.removed).toBe(1);
    expect(result.left).toEqual(["kept"]);
  });
});
