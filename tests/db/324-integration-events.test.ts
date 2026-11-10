import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown>;
type Claimed = { arrival: string; lease: string };
type Event = { kind: string; code: string | null; hits: number };

const envelope = (body: string) => `ps1.1.AAAAAAAAAAAAAAAA.${body}.BBBBBBBBBBBBBBBBBBBBBB`;

/**
 * INT-03: every connection keeps a sync log (kind, short code, time; nothing of a lead, a token or a person), written only
 * by the server's triggers, read by owners and admins; a failing connection tells the active owners and admins once a day.
 */
describe("integration sync log and failure notice (INT-03)", () => {
  let owner: U, admin: U, manager: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let seq = (process.pid % 100000) * 1000 + 500;
  const id = () => String(8100000000 + (seq += 1));

  const events = (conn: string) =>
    asAdmin(async (q) => (await q<Event>("select kind, code, hits from public.integration_events where connection_id = $1 order by created_at, kind", [conn])).rows);
  const kinds = async (conn: string) => (await events(conn)).map((e) => e.kind);
  const makeConnection = (who: U, o: string, page: string) =>
    asUser(who.id, async (q) => {
      const made = (await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'הדף') returning id", [o, page])).rows[0].id;
      await q("select public.integration_secret_set($1, $2, $3, 1)", [o, made, envelope(`VG9rZW4${o.slice(0, 4)}`)]);
      return made;
    });
  const arrive = async (page: string) => {
    const got = await asService(async (q) => (await q<{ r: Answer }>("select public.meta_lead_receive($1, $2) as r", [page, JSON.stringify([{ id: id() }])])).rows[0].r);
    const claimed = await asService(
      async (q) => (await q<{ r: Claimed[] }>("select public.meta_lead_claim(20, $1::uuid[]) as r", [got.arrivals as string[]])).rows[0].r,
    );
    return claimed[0];
  };
  const finish = (c: Claimed, lead: Answer | null, error: string | null = null) =>
    asService(
      async (q) =>
        (await q<{ r: string }>("select public.meta_lead_finish($1, $2, $3, $4) as r", [c.arrival, c.lease, lead === null ? null : JSON.stringify(lead), error])).rows[0].r,
    );
  const notices = (o: string, conn: string) =>
    asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and entity_type = 'integration' and entity_id = $2", [o, conn]));

  beforeAll(async () => {
    owner = await createUser("intev-owner");
    org = await createOrg(owner.id, "עסק היומן");
    admin = await addMember(org, owner.id, "admin", "intev-admin");
    manager = await addMember(org, owner.id, "manager", "intev-manager");
    member = await addMember(org, owner.id, "member", "intev-member");
    outsider = await createUser("intev-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("logs a connection's life: made, token saved, switched off, on again", async () => {
    const conn = await makeConnection(owner, org, id());
    expect(await kinds(conn)).toEqual(["created", "token_saved"]);
    await asUser(admin.id, (q) => q("update public.integrations set status = 'disconnected' where id = $1", [conn]));
    await asUser(admin.id, (q) => q("update public.integrations set status = 'connected' where id = $1", [conn]));
    // a rename is not a log line
    await asUser(admin.id, (q) => q("update public.integrations set name = 'שם חדש' where id = $1", [conn]));
    expect(await kinds(conn)).toEqual(["created", "token_saved", "disconnected", "connected"]);
  });

  it("logs fetch outcomes folded into one line a day, and verification; nothing of the lead", async () => {
    const page = id();
    const conn = await makeConnection(owner, org, page);
    for (const n of [1, 2]) {
      const c = await arrive(page);
      expect(await finish(c, { full_name: `ליד ${n}`, phone: `050-77700${n}0`, email: `lead${n}@example.test` })).toBe("accepted");
    }
    // a lead with no name, phone or email is refused (counted), a provider hiccup is tried again (counted)
    expect(await finish(await arrive(page), { message: "x" })).toBe("refused");
    expect(await finish(await arrive(page), null, "graph_unavailable")).toBe("retry");
    const log = await events(conn);
    expect(log).toEqual(
      expect.arrayContaining([
        { kind: "verified", code: null, hits: 1 },
        { kind: "fetch_ok", code: null, hits: 2 },
        { kind: "lead_refused", code: "invalid", hits: 1 },
        { kind: "fetch_failed", code: "graph_unavailable", hits: 1 },
      ]),
    );
    const text = JSON.stringify(await asAdmin(async (q) => (await q("select * from public.integration_events where integration_id = $1", [conn])).rows));
    expect(text).not.toContain("050-777");
    expect(text).not.toContain("example.test");
    expect(text).not.toContain("ליד");
  });

  it("an unverified connection gets no fetch lines: a page it may not hold shows it no counts (review finding 1)", async () => {
    const page = id();
    const conn = await makeConnection(owner, org, page);
    expect(await finish(await arrive(page), null, "not_found")).toBe("refused");
    expect(await finish(await arrive(page), null, "graph_unavailable")).toBe("retry");
    const log = await kinds(conn);
    expect(log).toEqual(["created", "token_saved"]);
    expect(log.some((k) => k.startsWith("fetch_") || k.startsWith("lead_"))).toBe(false);
  });

  it("a token Meta refuses: one log line each time, one notice a day to the active owners and admins only", async () => {
    const page = id();
    const conn = await makeConnection(owner, org, page);
    expect(await finish(await arrive(page), null, "token_invalid")).toBe("retry");
    expect(await kinds(conn)).toContain("token_invalid");
    // owner and admin, nobody else
    expect(await notices(org, conn)).toBe(2);
    const got = await asAdmin(async (q) =>
      (await q<{ user_id: string; type: string; body: string }>("select user_id, type, body from public.notifications where entity_id = $1 order by user_id", [conn])).rows,
    );
    expect(got.map((n) => n.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect(got.every((n) => n.type === "system" && !n.body.includes(page))).toBe(true);
    // a new token and a second refusal on the same day: logged again, no second notice
    await asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, conn, envelope("TmV3VG9rZW4")]));
    expect(await finish(await arrive(page), null, "token_invalid")).toBe("retry");
    expect((await kinds(conn)).filter((k) => k === "token_invalid")).toHaveLength(2);
    expect(await notices(org, conn)).toBe(2);
  });

  it("a page proven by another business ends this connection: page_taken is logged and its business told", async () => {
    const page = id();
    const mine = await makeConnection(owner, org, page);
    const theirs = await makeConnection(outsider, otherOrg, page);
    // their lead arrives first and is fetched with their token: their connection is verified, mine ends
    const claimed = await asService(async (q) => {
      const got = (await q<{ r: Answer }>("select public.meta_lead_receive($1, $2) as r", [page, JSON.stringify([{ id: id() }])])).rows[0].r;
      return (await q<{ r: (Claimed & { integration_id: string })[] }>("select public.meta_lead_claim(20, $1::uuid[]) as r", [got.arrivals as string[]])).rows[0].r;
    });
    const theirArrival = claimed.find((c) => c.integration_id === theirs);
    expect(theirArrival).toBeDefined();
    expect(await finish(theirArrival!, { full_name: "ליד שלהם", phone: "050-8880001" })).toBe("accepted");
    expect(await kinds(mine)).toContain("page_taken");
    expect(await notices(org, mine)).toBe(2);
    // their log says nothing about my business; mine is not readable by them
    expect(await kinds(theirs)).not.toContain("page_taken");
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.integration_events where integration_id = $1", [mine]))).toBe(0);
  });

  it("owners and admins read the log; managers, members and outsiders see nothing; nobody writes it", async () => {
    const conn = await makeConnection(owner, org, id());
    for (const u of [owner, admin]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.integration_events where integration_id = $1", [conn])), u.email).toBeGreaterThan(0);
    }
    for (const u of [manager, member, outsider]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.integration_events where integration_id = $1", [conn])), u.email).toBe(0);
    }
    for (const u of [owner, admin]) {
      expect((await pgError(asUser(u.id, (q) => q("insert into public.integration_events (organization_id, integration_id, connection_id, provider, kind, day) values ($1, $2, $2, 'meta_lead_ads', 'fetch_ok', current_date)", [org, conn])))).code).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("update public.integration_events set hits = 9 where integration_id = $1", [conn])))).code).toBe("42501");
      expect((await pgError(asUser(u.id, (q) => q("delete from public.integration_events where integration_id = $1", [conn])))).code).toBe("42501");
    }
  });

  it("removing a connection keeps its log, ids and codes only, still for owners and admins only (owner (228) ב)", async () => {
    const conn = await makeConnection(owner, org, id());
    await asUser(owner.id, (q) => q("delete from public.integrations where id = $1", [conn]));
    const rows = await asAdmin(
      async (q) => (await q<{ integration_id: string | null; provider: string; kind: string }>("select integration_id, provider, kind from public.integration_events where connection_id = $1 order by created_at", [conn])).rows,
    );
    expect(rows.map((r) => r.kind)).toEqual(["created", "token_saved"]);
    expect(rows.every((r) => r.integration_id === null && r.provider === "meta_lead_ads")).toBe(true);
    expect(await asUser(admin.id, (q) => count(q, "select 1 from public.integration_events where connection_id = $1", [conn]))).toBe(2);
    for (const u of [manager, member, outsider]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.integration_events where connection_id = $1", [conn])), u.email).toBe(0);
    }
  });

  it("a deleted connection's lines are kept 12 months from the DELETION, whatever their age (review finding 2)", async () => {
    const conn = await makeConnection(owner, org, id());
    await asAdmin((q) =>
      q(
        `insert into public.integration_events (organization_id, integration_id, connection_id, provider, kind, day, created_at, last_at)
         values ($1, $2, $2, 'meta_lead_ads', 'error', current_date - 700, now() - interval '22 months', now() - interval '22 months')`,
        [org, conn],
      ),
    );
    await asUser(owner.id, (q) => q("delete from public.integrations where id = $1", [conn]));
    const stamped = await asAdmin(
      async (q) => (await q<{ n: number; stamped: number }>("select count(*)::int as n, count(connection_deleted_at)::int as stamped from public.integration_events where connection_id = $1", [conn])).rows[0],
    );
    expect(stamped).toEqual({ n: 3, stamped: 3 });
    const purge = () => asAdmin((q) => q("select app.purge_old_integration_events()"));
    const left = () => asAdmin((q) => count(q, "select 1 from public.integration_events where connection_id = $1", [conn]));
    // a line written 11 months before the delete, 11 months after it: kept
    await asAdmin((q) =>
      q("update public.integration_events set connection_deleted_at = now() - interval '11 months', last_at = now() - interval '22 months' where connection_id = $1", [conn]),
    );
    await purge();
    expect(await left()).toBe(3);
    // 12 months after the delete: gone
    await asAdmin((q) => q("update public.integration_events set connection_deleted_at = now() - interval '12 months 1 day' where connection_id = $1", [conn]));
    await purge();
    expect(await left()).toBe(0);
  });

  it("deleting a business takes its connections' lines with it (the stamp steps aside)", async () => {
    const someone = await createUser("intev-gone");
    const gone = await createOrg(someone.id, "עסק שנמחק");
    const conn = await makeConnection(someone, gone, id());
    await asAdmin((q) => q("delete from public.organizations where id = $1", [gone]));
    expect(await asAdmin((q) => count(q, "select 1 from public.integration_events where connection_id = $1", [conn]))).toBe(0);
  });

  it("lines older than 12 months are removed by the nightly job; newer ones and a deleted connection's recent ones stay", async () => {
    const conn = await makeConnection(owner, org, id());
    await asAdmin((q) =>
      q(
        `insert into public.integration_events (organization_id, integration_id, connection_id, provider, kind, day, created_at, last_at)
         values ($1, $2, $2, 'meta_lead_ads', 'error', current_date - 400, now() - interval '13 months', now() - interval '13 months'),
                ($1, $2, $2, 'meta_lead_ads', 'error', current_date - 300, now() - interval '11 months', now() - interval '11 months')`,
        [org, conn],
      ),
    );
    const removed = await asAdmin(async (q) => (await q<{ n: number }>("select app.purge_old_integration_events() as n")).rows[0].n);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await asAdmin(
      async (q) => (await q<{ old: number; recent: number }>(
        `select count(*) filter (where last_at < now() - interval '12 months')::int as old,
                count(*) filter (where last_at >= now() - interval '12 months')::int as recent
           from public.integration_events where connection_id = $1`,
        [conn],
      )).rows[0],
    );
    expect(left).toEqual({ old: 0, recent: 3 });
    // the job is scheduled, and no API role may run the purge
    const rows = await asAdmin(
      async (q) =>
        (await q<{ name: string; authenticated: boolean; service: boolean }>(
          `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                  has_function_privilege('service_role', p.oid, 'execute') as service
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname in ('purge_old_integration_events', 'integration_events_purge_rows')`,
        )).rows,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r, r.name).toMatchObject({ authenticated: false, service: false });
  });

  it("the log helpers are server-only", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; authenticated: boolean; service: boolean }>(
            `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                    has_function_privilege('service_role', p.oid, 'execute') as service
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname in ('integration_event_log', 'integration_failure_notice', 'integrations_events', 'meta_lead_arrivals_events', 'integration_event_day')`,
          )
        ).rows,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r, r.name).toMatchObject({ authenticated: false, service: false });
  });
});
