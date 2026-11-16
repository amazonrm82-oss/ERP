import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// QUO-08 / QUO-18 (owner's answer (385) ב, migration quote_links_many): several live links per quote, each until the quote
// closes or the links are revoked by hand; at most 10 live (an 11th revokes the oldest); views counted per quote.

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown> & { quote?: Record<string, unknown>; status_page?: { state: string } };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("several live links per quote (owner (385) ב)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sentQuote = async (u: U, orgId: string) => {
    const p = await defaultPipeline(orgId);
    return asUser(u.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [orgId])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          orgId,
          p.pipelineId,
          p.stages[0].id,
          contact,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, current_date + 30) returning id", [orgId, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [orgId, quote]);
      await q("select public.quote_send($1, $2)", [orgId, quote]);
      return quote;
    });
  };
  const create = (u: U, orgId: string, quote: string) => asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [orgId, quote])).t);
  const page = (token: string) => asService(async (q) => (await one<{ p: Answer }>(q, "select public.quote_public($1) as p", [token])).p);
  const notFound = async (token: string) => expect((await pgError(page(token))).code).toBe("P0002");

  beforeAll(async () => {
    owner = await createUser("qlm-owner");
    org = await createOrg(owner.id, "עסק הקישורים");
    member = await addMember(org, owner.id, "member", "qlm-member");
    outsider = await createUser("qlm-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    for (const [u, o] of [
      [owner, org],
      [outsider, otherOrg],
    ] as const) {
      await asUser(u.id, (q) =>
        q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [o]),
      );
    }
  });

  it("two links both open the page; revoking ends both; a closed quote shows only its state on both", async () => {
    const quote = await sentQuote(member, org);
    const a = await create(member, org, quote);
    const b = await create(owner, org, quote);
    expect((await page(a)).quote).toBeDefined();
    expect((await page(b)).quote).toBeDefined();
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, quote]));
    for (const t of [a, b]) expect(Object.keys(await page(t))).toEqual(["status_page"]);

    const other = await sentQuote(member, org);
    const c = await create(member, org, other);
    const d = await create(member, org, other);
    expect(await asUser(member.id, async (q) => (await one<{ r: boolean }>(q, "select public.quote_link_revoke($1, $2) as r", [org, other])).r)).toBe(true);
    await notFound(c);
    await notFound(d);
    // a link made after the revoke works, and only it
    const e = await create(member, org, other);
    expect((await page(e)).quote).toBeDefined();
    await notFound(c);
  });

  it("at most 10 live links: the 11th revokes the oldest", async () => {
    const quote = await sentQuote(member, org);
    const tokens: string[] = [];
    for (let i = 0; i < 11; i += 1) tokens.push(await create(member, org, quote));
    await notFound(tokens[0]);
    for (const t of tokens.slice(1)) expect((await page(t)).quote).toBeDefined();
    expect(await asUser(member.id, async (q) => (await one<{ s: Answer }>(q, "select public.quote_link_status($1, $2) as s", [org, quote])).s)).toMatchObject({ active: true, live: 10 });
  });

  it("the view limit is the quote's, shared by its links; the per-sender limit stays", async () => {
    const quote = await sentQuote(member, org);
    const a = await create(member, org, quote);
    const b = await create(member, org, quote);
    const answers = await asService(async (q) => {
      const out: unknown[] = [];
      for (let i = 0; i < 121; i += 1) out.push((await one<{ p: Answer }>(q, "select public.quote_public($1) as p", [i % 2 ? a : b])).p.rate_limited ?? false);
      return out;
    });
    expect(answers.slice(0, 120).every((x) => x === false)).toBe(true);
    expect(answers[120]).toBe(true);
    expect((await page(a)).rate_limited).toBe(true);
    // one counter row per quote
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from app.quote_links where quote_id = $1", [quote])).n)).toBe(1);
  });

  it("the tokens are never selectable, only their hashes are kept, and each business's token opens its own quote only", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_table_privilege($1, 'app.quote_link_tokens', 'select') as ok", [role])).ok), role).toBe(false);
    }
    const mine = await sentQuote(member, org);
    const theirs = await sentQuote(outsider, otherOrg);
    const t1 = await create(member, org, mine);
    const t2 = await create(outsider, otherOrg, theirs);
    const kept = await asAdmin(async (q) => (await q<{ h: string; org: string }>("select token_hash as h, organization_id as org from app.quote_link_tokens where quote_id = any($1::uuid[])", [[mine, theirs]])).rows);
    expect(kept.map((r) => r.h).sort()).toEqual([sha256(t1), sha256(t2)].sort());
    expect(JSON.stringify(kept)).not.toContain(t1);
    expect(kept.find((r) => r.h === sha256(t2))?.org).toBe(otherOrg);
    // another business cannot make, revoke or read a link of this quote
    expect((await pgError(create(outsider, org, mine))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, mine])))).code).toBe("42501");
    expect((await page(t1)).quote).toBeDefined();
  });

  const issue = (q: Query, quote: string, job: string | null = null) =>
    q<{ t: string }>("select app.quote_link_token_issue($1, $2, $3, $4, $5) as t", [org, quote, member.id, job ? "message" : "screen", job]).then((r) => r.rows[0].t);
  const status = (quote: string) => asUser(member.id, async (q) => (await one<{ s: Answer }>(q, "select public.quote_link_status($1, $2) as s", [org, quote])).s);

  it("delta review 1: a revoke racing an issue leaves no working link behind a row that says none, and never deadlocks", async () => {
    const quote = await sentQuote(member, org);
    await create(member, org, quote);
    // the issue holds the quote's row; the revoke waits for it and then ends every link, the new one too
    let raced = "";
    let revoked: Promise<unknown> = Promise.resolve();
    await asAdmin(async (q) => {
      raced = await issue(q, quote);
      revoked = asUser(member.id, (r) => r("select public.quote_link_revoke($1, $2)", [org, quote]));
      await pause(300);
    });
    await revoked;
    await notFound(raced);
    expect(await status(quote)).toMatchObject({ active: false, live: 0 });
    // the other order: the revoke holds the row; the issue waits and then makes a link that works
    let later: Promise<string> = Promise.resolve("");
    await create(member, org, quote);
    await asUser(member.id, async (q) => {
      await q("select public.quote_link_revoke($1, $2)", [org, quote]);
      later = asAdmin((a) => issue(a, quote));
      await pause(300);
    });
    expect((await page(await later)).quote).toBeDefined();
    expect(await status(quote)).toMatchObject({ active: true, live: 1 });
  });

  it("delta reviews 2 and 3: no link is revoked on the spot; at the cap a surely-undelivered message's link goes first, then a re-composed job's earlier link; one transaction never ties", async () => {
    const quote = await sentQuote(member, org);
    const contact = await asAdmin(async (q) => (await one<{ c: string }>(q, "select contact_id as c from public.quotes where id = $1", [quote])).c);
    const template = await asAdmin(
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'הצעה', 'sms', 'requested_document', 'שלום {קישור להצעה}') returning id", [org])).id,
    );
    const job = () =>
      asAdmin(
        async (q) =>
          (
            await one<{ id: string }>(q, "select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [
              org,
              JSON.stringify({ channel: "sms", message_type: "requested_document", template_id: template, quote_id: quote, contact_id: contact, sent_by_user_id: member.id }),
            ])
          ).id,
      );
    // a job composed again (its lease ran out after the provider took it): both links stay live, either may be the one sent
    const j1 = await job();
    const firstTry = await asAdmin((q) => issue(q, quote, j1));
    const reComposed = await asAdmin((q) => issue(q, quote, j1));
    expect((await page(firstTry)).quote).toBeDefined();
    expect((await page(reComposed)).quote).toBeDefined();
    // a dead job whose provider answer is unknown may have been delivered; a refused one surely was not
    const j2 = await job();
    const unknownLink = await asAdmin((q) => issue(q, quote, j2));
    await asAdmin((q) => q("update app.jobs set status = 'dead', provider_error_code = 'unknown_timeout', message_outcome = null, last_error = 'timeout' where id = $1", [j2]));
    const j3 = await job();
    const refusedLink = await asAdmin((q) => issue(q, quote, j3));
    await asAdmin((q) => q("update app.jobs set status = 'refused' where id = $1", [j3]));
    const screen: string[] = [];
    for (let i = 0; i < 6; i += 1) screen.push(await create(member, org, quote));
    expect(await status(quote)).toMatchObject({ live: 10 });
    // the 11th: the refused message's link goes, though it is not the oldest
    screen.push(await create(member, org, quote));
    await notFound(refusedLink);
    for (const t of [firstTry, reComposed, unknownLink]) expect((await page(t)).quote).toBeDefined();
    // the 12th: the re-composed job's earlier link goes next; the possibly delivered unknown_* link stays
    screen.push(await create(member, org, quote));
    await notFound(firstTry);
    for (const t of [reComposed, unknownLink, ...screen]) expect((await page(t)).quote).toBeDefined();
    // eleven issues in one transaction: the first one is the one revoked
    const other = await sentQuote(member, org);
    const many = await asAdmin(async (q) => {
      const out: string[] = [];
      for (let i = 0; i < 11; i += 1) out.push(await issue(q, other));
      return out;
    });
    await notFound(many[0]);
    for (const t of many.slice(1)) expect((await page(t)).quote).toBeDefined();
  });
});
