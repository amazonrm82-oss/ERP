import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown> & {
  quote: Record<string, unknown>;
  customer: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  business: Record<string, unknown>;
  design: Record<string, unknown>;
  brand: Record<string, unknown>;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * QUO-08 (the page and the link): a sent quote gets a secret link, made, seen and turned off by whoever may edit its deal
 * or contact; only its SHA-256 is kept. public.quote_public(token) (service_role only) answers only what the customer's
 * page shows, never for a draft, a closed or expired quote, a deleted customer, a business without the flag or with its
 * public pages closed; and it counts views per link.
 */
describe("the customer's link to a quote (QUO-08)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const newContact = (u: U, orgId: string, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [orgId, name])).id);
  const newSentQuote = async (u: U, orgId: string, pipeline: { pipelineId: string; stageId: string }, contactName = "לקוח בדיקה") => {
    const contact = await newContact(u, orgId, contactName);
    return run(u, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          orgId,
          pipeline.pipelineId,
          pipeline.stageId,
          contact,
        ])
      ).id;
      const quote = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, notes, terms, deal_id) values ($1, 'הצעה ללקוח', 'הערה ללקוח', 'תשלום שוטף', $2) returning id", [
          orgId,
          deal,
        ])
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, kind, name, position) values ($1, $2, 'group', 'שלב א', 1)", [orgId, quote]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, name, description, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 'תיאור השורה', 2, 10000, 2)",
        [orgId, quote],
      );
      return { contact, deal, quote };
    });
  };
  const send = (u: U, orgId: string, quote: string) => run(u, (q) => q("select public.quote_send($1, $2)", [orgId, quote]));
  const create = (u: U, orgId: string, quote: string) => run(u, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [orgId, quote])).t);
  const revoke = (u: U, orgId: string, quote: string) => run(u, async (q) => (await one<{ r: boolean }>(q, "select public.quote_link_revoke($1, $2) as r", [orgId, quote])).r);
  const status = (u: U, orgId: string, quote: string) =>
    run(u, async (q) => (await one<{ s: { active: boolean; created_at: string | null } }>(q, "select public.quote_link_status($1, $2) as s", [orgId, quote])).s);
  const publicPage = (token: string) => asService(async (q) => (await one<{ p: Answer }>(q, "select public.quote_public($1) as p", [token])).p);
  const notFound = async (token: string) => expect((await pgError(publicPage(token))).code).toBe("P0002");
  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));

  beforeAll(async () => {
    owner = await createUser("ql-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    admin = await addMember(org, owner.id, "admin", "ql-admin");
    member = await addMember(org, owner.id, "member", "ql-member");
    other = await addMember(org, owner.id, "member", "ql-other");
    viewer = await addMember(org, owner.id, "viewer", "ql-viewer");
    outsider = await createUser("ql-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    for (const [u, orgId] of [
      [owner, org],
      [outsider, otherOrg],
    ] as const) {
      await run(u, (q) =>
        q(
          `insert into public.org_document_settings (organization_id, vat_status, legal_name, tax_id, address_line, city, phone, email)
           values ($1, 'licensed', 'השם הרשום בע"מ', '515555555', 'הרצל 1', 'תל אביב', '03-5555555', 'office@example.com')
           on conflict (organization_id) do update set vat_status = 'licensed', legal_name = excluded.legal_name, tax_id = excluded.tax_id,
             address_line = excluded.address_line, city = excluded.city, phone = excluded.phone, email = excluded.email`,
          [orgId],
        ),
      );
    }
  });

  it("only a sent quote gets a link, made by whoever may edit it; only its SHA-256 is kept", async () => {
    const { quote } = await newSentQuote(member, org, { pipelineId, stageId });
    // a draft has no link yet
    expect((await pgError(create(member, org, quote))).hint).toBe("quote:not_sent");
    await send(member, org, quote);
    // a colleague who cannot edit the deal, a viewer and another business get nothing, and learn nothing
    for (const u of [other, viewer]) expect((await pgError(create(u, org, quote))).code, u.email).toBe("42501");
    expect((await pgError(create(outsider, org, quote))).code).toBe("42501");
    expect((await pgError(create(outsider, otherOrg, quote))).code).toBe("42501");
    expect((await pgError(status(other, org, quote))).code).toBe("42501");
    expect((await pgError(revoke(viewer, org, quote))).code).toBe("42501");

    const token = await create(member, org, quote);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin((q) => q<Record<string, unknown>>("select * from app.quote_links where quote_id = $1", [quote]));
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).toBe(sha256(token));
    expect(JSON.stringify(stored.rows[0])).not.toContain(token);
    expect(await status(member, org, quote)).toMatchObject({ active: true });
    // an admin manages it too
    expect(await status(admin, org, quote)).toMatchObject({ active: true });
    // the audit log says a link was made, never which
    const audit = await asAdmin((q) => q<{ changes: unknown }>("select changes from public.audit_log where entity_id = $1 and action = 'quote_link'", [quote]));
    expect(audit.rows.map((r) => r.changes)).toEqual([{ link: "created" }]);
    expect(JSON.stringify(audit.rows)).not.toContain(token);
  });

  it("the page gets only what the customer sees: no ids, no products, no internal fields", async () => {
    const { quote } = await newSentQuote(member, org, { pipelineId, stageId }, "דנה הלקוחה");
    await send(member, org, quote);
    const token = await create(member, org, quote);
    const page = await publicPage(token);
    // QUO-12 adds `replaced`: the earlier version's number when an old link shows a newer version (null here)
    expect(Object.keys(page).sort()).toEqual(["brand", "built_with", "business", "customer", "design", "lines", "quote", "replaced", "schedule"]);
    expect(page.replaced).toBeNull();
    expect(Object.keys(page.quote).sort()).toEqual(
      [
        "currency",
        "discount_agorot",
        "discount_bp",
        "discount_total_agorot",
        "net_total_agorot",
        "no_vat_note",
        "no_vat_reason",
        "notes",
        "number",
        "prices_include_vat",
        "quote_date",
        "sent_at",
        "status",
        "subtotal_agorot",
        "terms",
        "title",
        "total_agorot",
        "valid_until",
        "vat_agorot",
        "vat_rate_bp",
      ].sort(),
    );
    for (const line of page.lines) {
      expect(Object.keys(line).sort()).toEqual(
        [
          "billing",
          "description",
          "discount_agorot",
          "discount_bp",
          "is_optional",
          "kind",
          "name",
          "optional_selected",
          "position",
          "quantity",
          "total_agorot",
          "unit_name",
          "unit_price_agorot",
          "vat_exempt",
        ].sort(),
      );
    }
    expect(Object.keys(page.customer).sort()).toEqual(["contact", "name"]);
    // nothing anywhere in the answer is an id: of the quote, its lines, the deal, the contact, a product or the business
    expect(JSON.stringify(page)).not.toMatch(UUID);
    expect(page.quote).toMatchObject({ title: "הצעה ללקוח", status: "sent", notes: "הערה ללקוח", terms: "תשלום שוטף", net_total_agorot: 20000, vat_agorot: 3600, total_agorot: 23600 });
    expect(page.quote.number).toEqual(expect.any(String));
    expect(page.customer).toEqual({ name: "דנה הלקוחה", contact: null });
    expect(page.lines.map((l) => [l.kind, l.name])).toEqual([
      ["group", "שלב א"],
      ["item", "עבודה"],
    ]);
    // QUO-05: no design row = the business details and the logo are shown; the documents use the registered name
    expect(page.business).toMatchObject({ name: 'השם הרשום בע"מ', tax_id: "515555555", city: "תל אביב", phone: "03-5555555" });
    expect(page.design).toMatchObject({ show_logo: true, show_business_details: true });

    // a design that hides the details and the logo leaves them out of the answer, not only off the screen
    await run(owner, (q) =>
      q("insert into public.quote_designs (organization_id, show_logo, show_business_details) values ($1, false, false) on conflict (organization_id) do update set show_logo = false, show_business_details = false", [org]),
    );
    // the branding trigger wants a real upload; the test sets the path past the triggers
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.organizations set logo_path = $2 where id = $1", [org, `${org}/logo`]);
    });
    const plain = await publicPage(token);
    expect(plain.business).toEqual({ name: 'השם הרשום בע"מ', tax_id: null, address_line: null, city: null, postal_code: null, phone: null, email: null });
    expect(plain.brand.logo).toBeNull();
    await run(owner, (q) => q("update public.quote_designs set show_logo = true, show_business_details = true where organization_id = $1", [org]));
    expect((await publicPage(token)).brand.logo).toBe(`${org}/logo`);
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.organizations set logo_path = null where id = $1", [org]);
    });
  });

  it("nobody but the server reads the page, and a token works only for its own quote", async () => {
    const { quote } = await newSentQuote(member, org, { pipelineId, stageId });
    await send(member, org, quote);
    const token = await create(member, org, quote);
    expect((await pgError(run(member, (q) => q("select public.quote_public($1)", [token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.quote_public($1)", [token])))).code).toBe("42501");
    expect(await run(owner, (q) => count(q, "select 1 from app.quote_links")).catch((e) => e.code)).toBe("42501");

    // another business's quote and link: each token shows its own quote only
    const theirPipe = await defaultPipeline(otherOrg);
    const theirs = await newSentQuote(outsider, otherOrg, { pipelineId: theirPipe.pipelineId, stageId: theirPipe.stages[0].id }, "לקוח של עסק אחר");
    await send(outsider, otherOrg, theirs.quote);
    const theirToken = await create(outsider, otherOrg, theirs.quote);
    expect((await publicPage(theirToken)).customer.name).toBe("לקוח של עסק אחר");
    expect((await publicPage(token)).customer.name).toBe("לקוח בדיקה");
    // a near miss, a wrong shape or nothing at all is not found
    await notFound(token.slice(0, 63) + (token.endsWith("A") ? "B" : "A"));
    await notFound("short");
    await notFound("");
  });

  it("a new link replaces the old one, and a link turned off stops at once", async () => {
    const { quote } = await newSentQuote(member, org, { pipelineId, stageId });
    await send(member, org, quote);
    const first = await create(member, org, quote);
    const second = await create(admin, org, quote);
    await notFound(first);
    expect((await publicPage(second)).quote.title).toBe("הצעה ללקוח");
    expect(await revoke(member, org, quote)).toBe(true);
    await notFound(second);
    expect(await status(member, org, quote)).toEqual({ active: false, created_at: null });
    expect(await revoke(member, org, quote)).toBe(false);
    const audit = await asAdmin((q) => q<{ changes: { link: string } }>("select changes from public.audit_log where entity_id = $1 and action = 'quote_link' order by id", [quote]));
    expect(audit.rows.map((r) => r.changes.link)).toEqual(["created", "created", "revoked"]);
  });

  it("not found for a cancelled or expired quote, a deleted customer, a business without quotes or with its pages closed", async () => {
    const { quote, contact, deal } = await newSentQuote(member, org, { pipelineId, stageId });
    await send(member, org, quote);
    const token = await create(member, org, quote);

    await asAdmin((q) => q("update public.quotes set status = 'cancelled' where id = $1", [quote]));
    await notFound(token);
    expect(await status(member, org, quote)).toMatchObject({ active: false });
    expect((await pgError(create(member, org, quote))).hint).toBe("quote:closed");
    await asAdmin((q) => q("update public.quotes set status = 'sent' where id = $1", [quote]));
    expect((await publicPage(token)).quote.status).toBe("sent");

    // valid until yesterday in the business's time zone
    // the dates of a sent quote are frozen for every writer; the test moves them past the triggers
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set quote_date = current_date - 30, valid_until = current_date - 1 where id = $1", [quote]);
    });
    await notFound(token);
    await asAdmin((q) => q("update public.quotes set valid_until = current_date + 30 where id = $1", [quote]));
    expect((await publicPage(token)).quote.status).toBe("sent");

    await setFeatures(org, { quotes: false });
    await notFound(token);
    // without the flag no link is made, and none is shown as managed
    expect((await pgError(create(member, org, quote))).hint).toBe("feature:quotes");
    expect((await pgError(status(member, org, quote))).hint).toBe("feature:quotes");
    await setFeatures(org, {});
    expect((await publicPage(token)).quote.status).toBe("sent");

    // a suspended business still shows its pages (app.org_public_pages_open); a cancelled one does not
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    expect((await publicPage(token)).quote.status).toBe("sent");
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    await notFound(token);
    await asAdmin((q) => q("update public.organizations set status = 'trial' where id = $1", [org]));
    expect((await publicPage(token)).quote.status).toBe("sent");

    // the customer purged for good: the kept quote has no page any more
    for (const [table, id] of [
      ["deals", deal],
      ["contacts", contact],
    ] as const) {
      await run(owner, (q) => q(`update public.${table} set deleted_at = now() where id = $1`, [id]));
      await run(owner, (q) => q(`delete from public.${table} where id = $1`, [id]));
    }
    expect(await asAdmin(async (q) => (await one<{ d: string | null }>(q, "select customer_deleted_at as d from public.quotes where id = $1", [quote])).d)).not.toBeNull();
    await notFound(token);
  });

  it("at most 120 views of a link in 10 minutes; a new link starts again", async () => {
    const { quote } = await newSentQuote(member, org, { pipelineId, stageId });
    await send(member, org, quote);
    const token = await create(member, org, quote);
    const answers = await asService(async (q) => {
      const out: unknown[] = [];
      for (let i = 0; i < 121; i += 1) out.push((await one<{ p: Answer }>(q, "select public.quote_public($1) as p", [token])).p.rate_limited ?? false);
      return out;
    });
    expect(answers.slice(0, 120).every((a) => a === false)).toBe(true);
    expect(answers[120]).toBe(true);
    // the window moves on after 10 minutes
    await asAdmin((q) => q("update app.quote_links set window_started_at = now() - interval '11 minutes' where quote_id = $1", [quote]));
    expect((await publicPage(token)).rate_limited).toBeUndefined();
    await asAdmin((q) => q("update app.quote_links set window_count = 500 where quote_id = $1", [quote]));
    const fresh = await create(member, org, quote);
    expect((await publicPage(fresh)).rate_limited).toBeUndefined();
  });

  it("a read-only business keeps its links working, and makes none", async () => {
    const { quote } = await newSentQuote(member, org, { pipelineId, stageId });
    await send(member, org, quote);
    const token = await create(member, org, quote);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await publicPage(token)).quote.status).toBe("sent");
      expect((await pgError(create(member, org, quote))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'trial' where id = $1", [org]));
    }
  });
});
