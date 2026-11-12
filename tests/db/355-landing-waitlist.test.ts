import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

// LND-13 (owner, 13 October 2026, CLAUDE.md hard rule 5): the landing page's "notify me" for a coming-soon plan. One definer
// function for the service role only, an app-schema table nobody else reads, one row per email and plan, the same answer new
// or not, a rate limit that keeps only a bucket number, and platform reads (counts for staff, addresses for the owner only).

const VERSION = "waitlist-draft-1";
const hash = () => randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64);

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super("rollback");
  }
}

/** Runs as the service role inside a transaction the superuser opened, then rolls it all back. */
async function asServiceRolledBack<T>(arrange: (q: Query) => Promise<void>, fn: (q: Query) => Promise<T>): Promise<T> {
  try {
    await asAdmin(async (q) => {
      await arrange(q);
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await q("set local role service_role");
      const value = await fn(q);
      await q("reset role");
      throw new Rollback(value);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as T;
    throw error;
  }
  throw new Error("unreachable");
}

const submit = (q: Query, email: string, plan = "business", consent = true, version = VERSION, ipHash: string | null = hash()) =>
  q<{ r: Record<string, unknown> }>("select public.landing_waitlist_submit($1, $2, $3, $4, $5) as r", [email, plan, consent, version, ipHash]).then(
    (res) => res.rows[0].r,
  );

describe("landing page notify-me (LND-13)", () => {
  it("only the service role may call it; no API role reads the tables", async () => {
    const user = await createUser("waitlist");
    expect((await pgError(asAnon((q) => q("select public.landing_waitlist_submit('a@b.co', 'business', true, $1, null)", [VERSION])))).code).toBe("42501");
    expect((await pgError(asUser(user.id, (q) => q("select public.landing_waitlist_submit('a@b.co', 'business', true, $1, null)", [VERSION])))).code).toBe("42501");
    for (const fn of ["public.platform_landing_waitlist_counts()", "public.platform_landing_waitlist('business')"]) {
      expect((await pgError(asAnon((q) => q(`select ${fn}`)))).code).toBe("42501");
    }
    for (const table of ["app.landing_waitlist", "app.landing_waitlist_counts", "app.landing_waitlist_totals"]) {
      expect((await pgError(asService((q) => q(`select * from ${table}`)))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q(`select * from ${table}`)))).code).toBe("42501");
    }
    const acl = await asAdmin(async (q) =>
      (
        await q<{ grantee: string }>(`
          select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
          from pg_proc p, aclexplode(p.proacl) a
          where p.oid = 'public.landing_waitlist_submit(text, text, boolean, text, text)'::regprocedure and a.privilege_type = 'EXECUTE'`)
      ).rows.map((r) => r.grantee),
    );
    expect(acl.filter((g) => g !== "postgres")).toEqual(["service_role"]);
  });

  it("stores email, plan, consent, wording version and date only, once per email and plan, with the same answer", async () => {
    const rows = await asServiceRolledBack(
      async (q) => void (await q("update public.plans set availability = 'coming_soon' where key = 'business'")),
      async (q) => {
        const first = await submit(q, "  Dana@Example.CO ");
        const again = await submit(q, "dana@example.co");
        await q("reset role");
        const stored = (await q("select * from app.landing_waitlist where email = 'dana@example.co'")).rows;
        return { first, again, stored };
      },
    );
    expect(rows.first).toEqual({ status: "received" });
    expect(rows.again).toEqual({ status: "received" });
    expect(rows.stored).toHaveLength(1);
    expect(Object.keys(rows.stored[0]).sort()).toEqual(["consent", "consent_wording_version", "created_at", "email", "id", "plan_key"]);
    expect(rows.stored[0]).toMatchObject({ email: "dana@example.co", plan_key: "business", consent: true, consent_wording_version: VERSION });
  });

  it("takes only a coming-soon plan, a ticked consent with a known wording, and a real-looking address", async () => {
    const answers = await asServiceRolledBack(
      async (q) => {
        await q("update public.plans set availability = 'coming_soon' where key = 'business'");
        await q("update public.plans set availability = 'available' where key = 'pro'");
      },
      async (q) => {
        const out = {
          available: await submit(q, "a@example.co", "pro"),
          unknown: await submit(q, "a@example.co", "nope"),
          unticked: await submit(q, "a@example.co", "business", false),
          oldWording: await submit(q, "a@example.co", "business", true, "other-1"),
          badEmail: await submit(q, "not an email"),
        };
        await q("reset role");
        const n = (await q<{ n: number }>("select count(*)::int as n from app.landing_waitlist where email = 'a@example.co'")).rows[0].n;
        return { ...out, n };
      },
    );
    expect(answers.available).toEqual({ status: "invalid", field: "plan" });
    expect(answers.unknown).toEqual({ status: "invalid", field: "plan" });
    expect(answers.unticked).toEqual({ status: "invalid", field: "consent" });
    expect(answers.oldWording).toEqual({ status: "invalid", field: "consent" });
    expect(answers.badEmail).toEqual({ status: "invalid", field: "email" });
    expect(answers.n).toBe(0);
  });

  it("refuses a sender after 5 tries in 10 minutes and keeps only a bucket number", async () => {
    const sender = hash();
    const result = await asServiceRolledBack(
      async (q) => void (await q("update public.plans set availability = 'coming_soon' where key = 'business'")),
      async (q) => {
        const answers = [];
        for (let i = 0; i < 6; i++) answers.push(await submit(q, `s${i}@example.co`, "business", true, VERSION, sender));
        await q("reset role");
        const columns = (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'landing_waitlist_counts' order by 1")).rows.map((r) => r.c);
        return { answers, columns };
      },
    );
    expect(result.answers.slice(0, 5).every((a) => (a as { status?: string }).status === "received")).toBe(true);
    expect(result.answers[5]).toEqual({ rate_limited: true });
    expect(result.columns).toEqual(["bucket", "n", "window_start"]);
  });

  it("without a sender hash nothing is stored: the answer is the rate-limited one (fail closed)", async () => {
    const result = await asServiceRolledBack(
      async (q) => void (await q("update public.plans set availability = 'coming_soon' where key = 'business'")),
      async (q) => {
        const none = await submit(q, "nohash@example.co", "business", true, VERSION, null);
        const bad = await submit(q, "nohash@example.co", "business", true, VERSION, "not-a-hash");
        await q("reset role");
        const n = (await q<{ n: number }>("select count(*)::int as n from app.landing_waitlist where email = 'nohash@example.co'")).rows[0].n;
        return { none, bad, n };
      },
    );
    expect(result.none).toEqual({ rate_limited: true });
    expect(result.bad).toEqual({ rate_limited: true });
    expect(result.n).toBe(0);
  });

  it("caps new rows for everyone at 200 an hour and 1,000 a day, counts only new rows, and rolls the windows over", async () => {
    const result = await asServiceRolledBack(
      async (q) => {
        await q("update public.plans set availability = 'coming_soon' where key = 'business'");
        await q("insert into app.landing_waitlist (email, plan_key, consent, consent_wording_version) values ('known@example.co', 'business', true, $1)", [VERSION]);
        await q("update app.landing_waitlist_totals set window_start = now(), n = case kind when 'hour' then 199 else 500 end");
      },
      async (q) => {
        const totals = async () => {
          await q("reset role");
          const rows = (await q<{ kind: string; n: number }>("select kind, n from app.landing_waitlist_totals order by kind")).rows;
          await q("set local role service_role");
          return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
        };
        const repeat = await submit(q, "known@example.co");
        const afterRepeat = await totals();
        const last = await submit(q, "cap1@example.co");
        const afterLast = await totals();
        const overHour = await submit(q, "cap2@example.co");
        const knownAtCap = await submit(q, "known@example.co");
        await q("reset role");
        await q("update app.landing_waitlist_totals set window_start = now() - interval '61 minutes' where kind = 'hour'");
        await q("update app.landing_waitlist_totals set window_start = now(), n = 999 where kind = 'day'");
        await q("set local role service_role");
        const rolled = await submit(q, "cap3@example.co");
        const afterRoll = await totals();
        const overDay = await submit(q, "cap4@example.co");
        await q("reset role");
        const stored = (await q<{ email: string }>("select email from app.landing_waitlist where email like 'cap%' order by email")).rows.map((r) => r.email);
        const caps = (await q<{ h: number; d: number }>("select app.landing_waitlist_cap('hour') as h, app.landing_waitlist_cap('day') as d")).rows[0];
        const columns = (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'landing_waitlist_totals' order by 1")).rows.map((r) => r.c);
        return { repeat, afterRepeat, last, afterLast, overHour, knownAtCap, rolled, afterRoll, overDay, stored, caps, columns };
      },
    );
    expect(result.caps).toEqual({ h: 200, d: 1000 });
    expect(result.columns).toEqual(["kind", "n", "window_start"]);
    expect(result.repeat).toEqual({ status: "received" });
    expect(result.afterRepeat).toEqual({ day: 500, hour: 199 });
    expect(result.last).toEqual({ status: "received" });
    expect(result.afterLast).toEqual({ day: 501, hour: 200 });
    expect(result.overHour).toEqual({ rate_limited: true });
    expect(result.knownAtCap).toEqual({ rate_limited: true });
    expect(result.rolled).toEqual({ status: "received" });
    expect(result.afterRoll).toEqual({ day: 1000, hour: 1 });
    expect(result.overDay).toEqual({ rate_limited: true });
    expect(result.stored).toEqual(["cap1@example.co", "cap3@example.co"]);
  });

  it("a plan's addresses go with the plan", async () => {
    const left = await (async () => {
      try {
        await asAdmin(async (q) => {
          await q(
            `insert into public.plans (key, name_he, name_en, price_monthly_agorot, price_annual_agorot, availability)
             values ('wl_test', 'בדיקה', 'Test', 0, 0, 'coming_soon')`,
          );
          await q("insert into app.landing_waitlist (email, plan_key, consent, consent_wording_version) values ('gone@example.co', 'wl_test', true, $1)", [VERSION]);
          await q("delete from public.plans where key = 'wl_test'");
          throw new Rollback((await q<{ n: number }>("select count(*)::int as n from app.landing_waitlist where email = 'gone@example.co'")).rows[0].n);
        });
      } catch (error) {
        if (error instanceof Rollback) return error.value as number;
        throw error;
      }
      throw new Error("unreachable");
    })();
    expect(left).toBe(0);
  });

  it("platform reads: counts for staff roles, addresses for the owner only, and each read is logged", async () => {
    const owner = await createUser("platform-owner");
    const support = await createUser("platform-support");
    const finance = await createUser("platform-finance");
    const readonly = await createUser("platform-readonly");
    const result = await (async () => {
      try {
        await asAdmin(async (q) => {
          await q("insert into app.platform_staff (user_id, role) values ($1, 'owner'), ($2, 'support'), ($3, 'finance'), ($4, 'readonly')", [owner.id, support.id, finance.id, readonly.id]);
          await q("update public.plans set availability = 'coming_soon' where key = 'business'");
          await q("insert into app.landing_waitlist (email, plan_key, consent, consent_wording_version) values ('x@example.co', 'business', true, $1)", [VERSION]);
          const claims = (id: string) => JSON.stringify({ sub: id, role: "authenticated", aal: "aal2" });
          await q("select set_config('request.jwt.claims', $1, true)", [claims(support.id)]);
          await q("set local role authenticated");
          const counts = (await q<{ r: Record<string, number> }>("select public.platform_landing_waitlist_counts() as r")).rows[0].r;
          await q("savepoint s");
          const supportList = await q("select public.platform_landing_waitlist('business')").then(
            () => "ok",
            (e: { code?: string }) => e.code,
          );
          await q("rollback to savepoint s");
          const others: Record<string, { counts: number | string; list: string }> = {};
          for (const [name, id] of [["finance", finance.id], ["readonly", readonly.id]] as const) {
            await q("select set_config('request.jwt.claims', $1, true)", [claims(id)]);
            const c = (await q<{ r: Record<string, number> }>("select public.platform_landing_waitlist_counts() as r")).rows[0].r;
            await q("savepoint t");
            const l = await q("select public.platform_landing_waitlist('business')").then(
              () => "ok",
              (e: { code?: string }) => e.code ?? "error",
            );
            await q("rollback to savepoint t");
            others[name] = { counts: c.business, list: l };
          }
          await q("select set_config('request.jwt.claims', $1, true)", [claims(owner.id)]);
          const list = (await q<{ r: Array<Record<string, unknown>> }>("select public.platform_landing_waitlist('business') as r")).rows[0].r;
          await q("reset role");
          const logged = (await q<{ n: number }>("select count(*)::int as n from app.platform_log where action = 'landing_waitlist.read' and actor_id = $1", [owner.id])).rows[0].n;
          throw new Rollback({ counts, supportList, others, list, logged });
        });
      } catch (error) {
        if (error instanceof Rollback) return error.value as { counts: Record<string, number>; supportList: string; others: Record<string, { counts: number | string; list: string }>; list: Array<Record<string, unknown>>; logged: number };
        throw error;
      }
      throw new Error("unreachable");
    })();
    expect(result.counts.business).toBeGreaterThanOrEqual(1);
    expect(result.supportList).toBe("42501");
    for (const role of ["finance", "readonly"]) {
      expect(result.others[role].counts).toBeGreaterThanOrEqual(1);
      expect(result.others[role].list).toBe("42501");
    }
    expect(result.list.some((r) => r.email === "x@example.co")).toBe(true);
    expect(result.logged).toBe(1);
  });

  it("the purge removes only addresses older than 12 months, and no API role may run it", async () => {
    const removed = await (async () => {
      try {
        await asAdmin(async (q) => {
          await q("update public.plans set availability = 'coming_soon' where key = 'business'");
          await q(
            `insert into app.landing_waitlist (email, plan_key, consent, consent_wording_version, created_at)
             values ('old@example.co', 'business', true, $1, now() - interval '13 months'),
                    ('new@example.co', 'business', true, $1, now() - interval '11 months')`,
            [VERSION],
          );
          await q("select app.purge_old_landing_waitlist()");
          const left = (await q<{ email: string }>("select email from app.landing_waitlist where email in ('old@example.co', 'new@example.co')")).rows.map((r) => r.email);
          throw new Rollback(left);
        });
      } catch (error) {
        if (error instanceof Rollback) return error.value as string[];
        throw error;
      }
      throw new Error("unreachable");
    })();
    expect(removed).toEqual(["new@example.co"]);
    expect((await pgError(asService((q) => q("select app.purge_old_landing_waitlist()")))).code).toBe("42501");
  });
});
