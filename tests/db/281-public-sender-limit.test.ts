import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

// OPS-02, the owner's answers of 2 November 2026.
// (40) ב + (42) ד: the secret-link pages (quote, order, statement, the booking-manage link) share ONE limit per sender against
//     guessed links: once a sender had 120 "not found" answers in 10 minutes across them, public.public_sender_check refuses
//     BEFORE the token is looked up. public.public_sender_miss records one miss (atomic upsert) after a "not found"; found
//     answers are never counted. Both service_role only, 65,536 reused buckets, no hash kept. The form, widget, booking page
//     and card never take it (src/lib/public-sender-server.ts; the unit inventory pins who calls it).
// (41) ב: the quote page also limits each sender to 60 views in 10 minutes (as order_public / statement_public), counted after
//     the lookup, the sender scoped to the quote, handed over in the x-crm-sender header (app.public_sender_header).

const sender = (label: string) => createHash("sha256").update(label).digest("hex");
const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
const check = (hash: string | null) => asService(async (q) => (await one<{ ok: boolean }>(q, "select public.public_sender_check($1) as ok", [hash])).ok);
const miss = (hash: string | null) => asService(async (q) => (await one<{ n: number | null }>(q, "select public.public_sender_miss($1) as n", [hash])).n);
const BUCKET = "((hashtextextended($1, 0) % 65536) + 65536) % 65536";
const bucketMisses = (hash: string) =>
  asAdmin(async (q) => (await q<{ misses: number }>(`select misses from app.public_sender_counts where bucket = ${BUCKET}`, [hash])).rows[0]?.misses ?? 0);
const expire = (hash: string) =>
  asAdmin((q) => q(`update app.public_sender_counts set window_start = now() - interval '11 minutes' where bucket = ${BUCKET}`, [hash]));

describe("OPS-02 (40), (42): the secret-link pages' shared limit of not-found answers per sender", () => {
  it("the limit is one named number: 120", async () => {
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.public_sender_limit() as n")).n)).toBe(120);
  });

  it("120 misses per sender in 10 minutes, then refused before any lookup; the check itself counts nothing; the window passes", async () => {
    const a = sender("ops02b-a");
    const b = sender("ops02b-b");
    // the two senders do not share a bucket (fixed labels, checked once here)
    expect(
      await asAdmin(async (q) => (await one<{ same: boolean }>(q, `select ${BUCKET} = ${BUCKET.replaceAll("$1", "$2")} as same`, [a, b])).same),
    ).toBe(false);
    await expire(a);
    for (let i = 0; i < 119; i += 1) expect(await miss(a)).toBe(i + 1);
    // checks only read: any number of them leaves the count alone
    for (let i = 0; i < 5; i += 1) expect(await check(a)).toBe(true);
    expect(await bucketMisses(a)).toBe(119);
    expect(await miss(a)).toBe(120);
    expect(await check(a)).toBe(false);
    // another sender is counted apart
    expect(await check(b)).toBe(true);
    await expire(a);
    expect(await check(a)).toBe(true);
    expect(await miss(a)).toBe(1);
  });

  it("anything but a keyed hash is neither checked nor counted (no secret = no hash: fail open)", async () => {
    const before = await asAdmin(async (q) => (await one<{ n: string }>(q, "select coalesce(sum(misses), 0) as n from app.public_sender_counts")).n);
    for (const value of [null, "", "not-a-hash", sender("upper").toUpperCase(), sender("short").slice(0, 63)]) {
      expect(await check(value)).toBe(true);
      expect(await miss(value)).toBeNull();
    }
    const after = await asAdmin(async (q) => (await one<{ n: string }>(q, "select coalesce(sum(misses), 0) as n from app.public_sender_counts")).n);
    expect(after).toBe(before);
  });

  it("keeps no hash: bucket, window and count only; no client role reads the table or calls the functions", async () => {
    expect(
      await asAdmin(async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'public_sender_counts' order by 1")).rows.map((r) => r.c),
      ),
    ).toEqual(["bucket", "misses", "window_start"]);
    const rights = await asAdmin(async (q) =>
      (
        await q<{ r: string; t: boolean; lim: boolean; chk: boolean; mis: boolean }>(
          `select r, has_table_privilege(r, 'app.public_sender_counts', 'select') as t,
                  has_function_privilege(r, 'app.public_sender_limit()', 'execute') as lim,
                  has_function_privilege(r, 'public.public_sender_check(text)', 'execute') as chk,
                  has_function_privilege(r, 'public.public_sender_miss(text)', 'execute') as mis
             from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
        )
      ).rows,
    );
    expect(rights).toEqual([
      { r: "anon", t: false, lim: false, chk: false, mis: false },
      { r: "authenticated", t: false, lim: false, chk: false, mis: false },
      { r: "service_role", t: false, lim: false, chk: true, mis: true },
    ]);
    const user = await createUser("ops02b-user");
    for (const fn of ["public_sender_check", "public_sender_miss"]) {
      expect((await pgError(asUser(user.id, (q) => q(`select public.${fn}($1)`, [sender("u")])))).code, fn).toBe("42501");
      expect((await pgError(asAnon((q) => q(`select public.${fn}($1)`, [sender("u")])))).code, fn).toBe("42501");
    }
    const fns = await asAdmin(async (q) =>
      (
        await q<{ sig: string; def: boolean; cfg: string[] }>(
          "select p.oid::regprocedure::text as sig, p.prosecdef as def, p.proconfig as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'public_sender_%' order by 1",
        )
      ).rows,
    );
    expect(fns).toEqual([
      { sig: "public_sender_check(text)", def: true, cfg: ['search_path=""'] },
      { sig: "public_sender_miss(text)", def: true, cfg: ['search_path=""'] },
    ]);
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
  /** the bucket public.quote_public counts a sender's header value in (1,024 per quote) */
  const bucketOf = (quote: string, hash: string) =>
    asAdmin(
      async (q) =>
        (await one<{ b: number }>(q, "select (((hashtextextended(app.quote_link_sender($1, $2), 0) % 1024) + 1024) % 1024)::int as b", [quote, hash])).b,
    );
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

  /** a secret-link page's flow, as src/lib/public-sender-server.ts runs it: check, the page's own function, a miss on not found */
  const pageView = async (token: string, publicHash: string) => {
    if (!(await check(publicHash))) return "refused";
    try {
      return await view(token, null);
    } catch (error) {
      if ((error as { code?: string }).code !== "P0002") throw error;
      await miss(publicHash);
      return "not-found";
    }
  };

  it("(40): guessed tokens count before the lookup; after 120 misses even a real link is refused for that sender", async () => {
    const link = await newLink();
    const guesser = sender("ops02b-guesser");
    await expire(guesser);
    for (let i = 0; i < 120; i += 1) expect(await pageView(`${i}`.padStart(64, "z"), guesser), `guess ${i + 1}`).toBe("not-found");
    expect(await bucketMisses(guesser)).toBe(120);
    expect(await pageView(link.token, guesser)).toBe("refused");
    expect(await pageView("q".repeat(64), guesser)).toBe("refused");
    // the refused requests never reached the lookup, so they counted nothing more
    expect(await bucketMisses(guesser)).toBe(120);
    // another sender still opens the link
    expect(limited((await pageView(link.token, sender("ops02b-other"))) as Record<string, unknown>)).toBe(false);
  });

  it("(40), (42): found answers never count: a customer opens a real quote 200 times and is never refused by the shared limit", async () => {
    const link = await newLink();
    const customer = sender("ops02b-customer");
    await expire(customer);
    for (let i = 0; i < 200; i += 1) {
      // only the link's own window may stop them; reset it as ten minutes passing would
      if (i % 100 === 0) await asAdmin((q) => q("update app.quote_links set window_count = 0 where quote_id = $1", [link.quote]));
      const answer = await pageView(link.token, customer);
      expect(answer, `view ${i + 1}`).not.toBe("refused");
      expect(limited(answer as Record<string, unknown>), `view ${i + 1}`).toBe(false);
    }
    expect(await bucketMisses(customer)).toBe(0);
  });

  it("60 views per sender in 10 minutes, then rate_limited; another sender, and the same sender on another quote, go on", async () => {
    const first = await newLink();
    const second = await newLink();
    const a = sender("ops02b-quote-a");
    for (let i = 0; i < 60; i += 1) expect(limited(await view(first.token, a)), `view ${i + 1}`).toBe(false);
    expect(await view(first.token, a)).toEqual({ rate_limited: true });
    // another sender, in another of the quote's 1,024 buckets
    const bucketA = await bucketOf(first.quote, a);
    let b = sender("ops02b-quote-b");
    for (let i = 0; (await bucketOf(first.quote, b)) === bucketA; i++) b = sender(`ops02b-quote-b${i}`);
    expect(limited(await view(first.token, b))).toBe(false);
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
    // three senders in three different buckets, so none reaches its own 60
    const many: string[] = [];
    const used = new Set<number>();
    for (let i = 0; many.length < 3; i++) {
      const hash = sender(`ops02b-many-${i}`);
      const bucket = await bucketOf(link.quote, hash);
      if (used.has(bucket)) continue;
      used.add(bucket);
      many.push(hash);
    }
    for (let i = 0; i < 120; i += 1) expect(limited(await view(link.token, many[i % 3])), `view ${i + 1}`).toBe(false);
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
