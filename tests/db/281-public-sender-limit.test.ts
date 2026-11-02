import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

// OPS-02, the owner's answers of 2 November 2026.
// (40) ב: every public page and route counts the request against ONE limit per sender before it looks its token up: 120 in
//     10 minutes across all public pages together (public.public_sender_take, service_role only, 65,536 reused buckets, no
//     hash kept). The app calls it first (src/lib/public-sender-server.ts), so a made-up token counts like a real one.
// (41) ב: the quote page also limits each sender to 60 views in 10 minutes (as order_public / statement_public), counted after
//     the lookup, the sender scoped to the quote, handed over in the x-crm-sender header (app.public_sender_header).

const sender = (label: string) => createHash("sha256").update(label).digest("hex");
const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

describe("OPS-02 (40): one limit per sender before the token lookup (public.public_sender_take)", () => {
  const take = (hash: string | null) => asService(async (q) => (await one<{ ok: boolean }>(q, "select public.public_sender_take($1) as ok", [hash])).ok);
  const bucketRow = (hash: string) =>
    asAdmin(async (q) =>
      one<{ requests: number }>(
        q,
        "select requests from app.public_sender_counts where bucket = ((hashtextextended($1, 0) % 65536) + 65536) % 65536",
        [hash],
      ),
    );
  const expire = (hash: string) =>
    asAdmin((q) =>
      q(
        "update app.public_sender_counts set window_start = now() - interval '11 minutes' where bucket = ((hashtextextended($1, 0) % 65536) + 65536) % 65536",
        [hash],
      ),
    );

  it("the limit is one named number: 120, closed to every client role", async () => {
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.public_sender_limit() as n")).n)).toBe(120);
  });

  it("120 requests per sender in 10 minutes across all pages together; the 121st is refused; the window passes", async () => {
    const a = sender("ops02b-a");
    const b = sender("ops02b-b");
    // the two senders do not share a bucket (fixed labels, checked once here)
    expect(
      await asAdmin(async (q) =>
        (await one<{ same: boolean }>(q, "select (hashtextextended($1, 0) % 65536 + 65536) % 65536 = (hashtextextended($2, 0) % 65536 + 65536) % 65536 as same", [a, b])).same,
      ),
    ).toBe(false);
    await expire(a);
    // 60 requests on one page and 60 on another (the app takes the same scope 'public' everywhere): one count
    for (let i = 0; i < 120; i += 1) expect(await take(a), `request ${i + 1}`).toBe(true);
    expect((await bucketRow(a))?.requests).toBe(120);
    expect(await take(a)).toBe(false);
    expect(await take(a)).toBe(false);
    // another sender is counted apart
    expect(await take(b)).toBe(true);
    await expire(a);
    expect(await take(a)).toBe(true);
    expect((await bucketRow(a))?.requests).toBe(1);
  });

  it("is counted before the token is looked up: a made-up token counts like a real one", async () => {
    // the page's flow: take first, then its own function, which answers not found
    const c = sender("ops02b-not-found");
    await expire(c);
    for (let i = 0; i < 120; i += 1) {
      expect(await take(c)).toBe(true);
      expect((await pgError(asService((q) => q("select public.quote_public($1)", ["x".repeat(64)])))).code).toBe("P0002");
    }
    expect(await take(c)).toBe(false);
  });

  it("anything but a keyed hash is not counted (no secret = no hash: fail open)", async () => {
    const before = await asAdmin(async (q) => (await one<{ n: string }>(q, "select coalesce(sum(requests), 0) as n from app.public_sender_counts")).n);
    for (const value of [null, "", "not-a-hash", sender("upper").toUpperCase(), sender("short").slice(0, 63)]) expect(await take(value)).toBe(true);
    const after = await asAdmin(async (q) => (await one<{ n: string }>(q, "select coalesce(sum(requests), 0) as n from app.public_sender_counts")).n);
    expect(after).toBe(before);
  });

  it("keeps no hash: bucket, window and count only; no client role reads the table or calls the functions", async () => {
    expect(
      await asAdmin(async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'public_sender_counts' order by 1")).rows.map((r) => r.c),
      ),
    ).toEqual(["bucket", "requests", "window_start"]);
    const rights = await asAdmin(async (q) =>
      (
        await q<{ r: string; t: boolean; lim: boolean; take: boolean }>(
          `select r, has_table_privilege(r, 'app.public_sender_counts', 'select') as t,
                  has_function_privilege(r, 'app.public_sender_limit()', 'execute') as lim,
                  has_function_privilege(r, 'public.public_sender_take(text)', 'execute') as take
             from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
        )
      ).rows,
    );
    expect(rights).toEqual([
      { r: "anon", t: false, lim: false, take: false },
      { r: "authenticated", t: false, lim: false, take: false },
      { r: "service_role", t: false, lim: false, take: true },
    ]);
    const user = await createUser("ops02b-user");
    expect((await pgError(asUser(user.id, (q) => q("select public.public_sender_take($1)", [sender("u")])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.public_sender_take($1)", [sender("u")])))).code).toBe("42501");
    // definer with a pinned search_path, one signature
    const fn = await asAdmin(async (q) =>
      (
        await q<{ sig: string; def: boolean; cfg: string[] }>(
          "select p.oid::regprocedure::text as sig, p.prosecdef as def, p.proconfig as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'public_sender_take'",
        )
      ).rows,
    );
    expect(fn).toEqual([{ sig: "public_sender_take(text)", def: true, cfg: ["search_path=\"\""] }]);
  });
});

describe("OPS-02 (41): the quote page's per-sender view limit (public.quote_public)", () => {
  let owner: { id: string };
  let org: string;
  let pipelineId: string;
  let stageId: string;

  const newLink = async () => {
    const contact = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [org])).id);
    return asUser(owner.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          contact,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t;
      return { quote, token };
    });
  };
  /** one page view as the server makes it: the quote-scoped keyed hash in x-crm-sender (null = no header) */
  const view = (token: string, hash: string | null) =>
    asService(async (q) => {
      if (hash !== null) await q("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-crm-sender": hash })]);
      return (await one<{ p: Record<string, unknown> }>(q, "select public.quote_public($1) as p", [token])).p;
    });
  const limited = (answer: Record<string, unknown>) => answer.rate_limited === true;
  const counted = (quote: string) =>
    asAdmin(async (q) => Number((await one<{ n: string }>(q, "select coalesce(sum(views), 0) as n from app.quote_link_view_counts where quote_id = $1", [quote])).n));

  beforeAll(async () => {
    owner = await createUser("ops02b-quote-owner");
    org = await createOrg(owner.id);
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [org],
      ),
    );
  });

  it("60 views per sender in 10 minutes, then rate_limited; another sender, and the same sender on another quote, go on", async () => {
    const first = await newLink();
    const second = await newLink();
    const a = sender("ops02b-quote-a");
    for (let i = 0; i < 60; i += 1) expect(limited(await view(first.token, a)), `view ${i + 1}`).toBe(false);
    expect(await view(first.token, a)).toEqual({ rate_limited: true });
    expect(limited(await view(first.token, sender("ops02b-quote-b")))).toBe(false);
    expect(limited(await view(second.token, a))).toBe(false);
    // a read without the header (the signed PDF's own read, a page older than the migration) is not counted per sender
    const before = await counted(first.quote);
    expect(limited(await view(first.token, null))).toBe(false);
    expect(await counted(first.quote)).toBe(before);
    // the window passes
    await asAdmin((q) => q("update app.quote_link_view_counts set window_start = now() - interval '11 minutes' where quote_id = $1", [first.quote]));
    expect(limited(await view(first.token, a))).toBe(false);
  });

  it("the link's own 120 views in 10 minutes still hold, whoever the senders are", async () => {
    const link = await newLink();
    for (let i = 0; i < 120; i += 1) expect(limited(await view(link.token, sender(`ops02b-many-${i % 3}`))), `view ${i + 1}`).toBe(false);
    expect(await view(link.token, sender("ops02b-fresh"))).toEqual({ rate_limited: true });
    expect(await view(link.token, null)).toEqual({ rate_limited: true });
  });

  it("not found is unchanged and counts nothing per sender; only bucket numbers kept; counters go with the quote", async () => {
    const a = sender("ops02b-quote-nf");
    expect((await pgError(view("y".repeat(64), a))).code).toBe("P0002");
    expect(
      await asAdmin(async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'quote_link_view_counts' order by 1")).rows.map((r) => r.c),
      ),
    ).toEqual(["bucket", "organization_id", "quote_id", "views", "window_start"]);
    const grants = await asAdmin(async (q) =>
      (
        await q<{ t: boolean }>(
          "select bool_or(has_table_privilege(r, 'app.quote_link_view_counts', 'select')) as t from unnest(array['anon', 'authenticated', 'service_role']) r",
        )
      ).rows[0].t,
    );
    expect(grants).toBe(false);
    // quote_public keeps one signature and stays the service role's only
    const sigs = await asAdmin(async (q) =>
      (
        await q<{ sig: string }>(
          "select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'quote_public'",
        )
      ).rows.map((r) => r.sig),
    );
    expect(sigs).toEqual(["quote_public(text)"]);
    const link = await newLink();
    expect((await pgError(asUser(owner.id, (q) => q("select public.quote_public($1)", [link.token])))).code).toBe("42501");
    await view(link.token, a);
    expect(await counted(link.quote)).toBe(1);
  });
});
