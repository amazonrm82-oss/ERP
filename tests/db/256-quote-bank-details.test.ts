import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Bank = { bank_name: string; bank_branch: string; bank_account: string; bank_account_name: string | null };

/**
 * TAX-02, the rest (owner, 13 October 2026, "פרטי בנק"): the business's bank details for a transfer are shown on the
 * documents it issues: a quote and an order confirmation. Settings stay owners/admins only (org_bank_details); a document
 * keeps app.document_bank_snapshot() taken when it is sent (a quote) or numbered (an order), never changed afterwards, and
 * whoever reads the document reads it there. The customer page (quote_public / order_public) answers `bank` only from the
 * stored snapshot and only while the design shows it (quote_designs.show_bank_details).
 */
describe("bank details on quotes and orders (TAX-02)", () => {
  let owner: U, admin: U, member: U, viewer: U, other: U, outsider: U;
  let org: string, otherOrg: string;
  let pipe: { pipelineId: string; stageId: string };
  let otherPipe: { pipelineId: string; stageId: string };

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setBank = (u: U, orgId: string, account: string, name: string) =>
    run(u, (q) =>
      q(
        `insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account, bank_account_name)
         values ($1, 'בנק הפועלים', '123', $2, $3)
         on conflict (organization_id) do update set bank_name = excluded.bank_name, bank_branch = excluded.bank_branch,
           bank_account = excluded.bank_account, bank_account_name = excluded.bank_account_name`,
        [orgId, account, name],
      ),
    );
  const newQuote = (u: U, orgId: string, p: { pipelineId: string; stageId: string }) =>
    run(u, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [orgId])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          orgId,
          p.pipelineId,
          p.stageId,
          contact,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [orgId, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [orgId, quote]);
      return quote;
    });
  const send = (u: U, orgId: string, quote: string) => run(u, (q) => q("select public.quote_send($1, $2)", [orgId, quote]));
  const stored = (quote: string) => asAdmin(async (q) => (await one<{ b: Bank | null }>(q, "select bank_details as b from public.quotes where id = $1", [quote])).b);
  const link = (u: U, orgId: string, quote: string) => run(u, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [orgId, quote])).t);
  const publicQuote = (token: string) =>
    asService(async (q) => (await one<{ p: Record<string, unknown> & { design: Record<string, unknown> } }>(q, "select public.quote_public($1) as p", [token])).p);
  const setDesign = (u: U, orgId: string, show: boolean) =>
    run(u, (q) =>
      q(
        "insert into public.quote_designs (organization_id, show_bank_details) values ($1, $2) on conflict (organization_id) do update set show_bank_details = excluded.show_bank_details",
        [orgId, show],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("qb-owner");
    org = await createOrg(owner.id, "עסק הבנק");
    admin = await addMember(org, owner.id, "admin", "qb-admin");
    member = await addMember(org, owner.id, "member", "qb-member");
    viewer = await addMember(org, owner.id, "viewer", "qb-viewer");
    other = await addMember(org, owner.id, "member", "qb-other");
    outsider = await createUser("qb-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    for (const [u, o] of [
      [owner, org],
      [outsider, otherOrg],
    ] as const) {
      await run(u, (q) =>
        q(
          `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
           on conflict (organization_id) do update set vat_status = 'licensed'`,
          [o],
        ),
      );
    }
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages[0].id };
    const op = await defaultPipeline(otherOrg);
    otherPipe = { pipelineId: op.pipelineId, stageId: op.stages[0].id };
    await setBank(owner, org, "12345678", "העסק שלנו");
    await setBank(outsider, otherOrg, "99999999", "העסק האחר");
  });

  it("a member and a viewer cannot read the settings, but see the snapshot on a quote they may read", async () => {
    const quote = await newQuote(member, org, pipe);
    // a draft has no snapshot yet
    expect(await stored(quote)).toBeNull();
    await send(member, org, quote);
    for (const u of [member, viewer]) {
      const settings = await run(u, (q) => q("select * from public.org_bank_details where organization_id = $1", [org]));
      expect(settings.rows, u.email).toHaveLength(0);
      const row = await run(u, async (q) => one<{ b: Bank | null }>(q, "select bank_details as b from public.quotes where id = $1", [quote]));
      expect(row?.b, u.email).toEqual({ bank_name: "בנק הפועלים", bank_branch: "123", bank_account: "12345678", bank_account_name: "העסק שלנו" });
    }
    // another business sees neither the quote nor its snapshot
    const theirs = await run(outsider, (q) => q("select bank_details from public.quotes where id = $1", [quote]));
    expect(theirs.rows).toHaveLength(0);
  });

  it("the snapshot is taken at send and never changes afterwards; a person cannot write it", async () => {
    const quote = await newQuote(member, org, pipe);
    // a person cannot put it on a draft (no column grant)
    expect((await pgError(run(member, (q) => q("update public.quotes set bank_details = '{}'::jsonb where id = $1", [quote])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("update public.quotes set bank_details = '{}'::jsonb where id = $1", [quote])))).code).toBe("42501");
    await send(member, org, quote);
    const first = await stored(quote);
    expect(first?.bank_account).toBe("12345678");

    await setBank(owner, org, "87654321", "שם חדש");
    expect(await stored(quote)).toEqual(first);
    // a server write (no grant needed) cannot change it either
    await asAdmin((q) => q("update public.quotes set bank_details = '{\"bank_account\": \"1\"}'::jsonb, title = 'שונה' where id = $1", [quote]));
    expect(await stored(quote)).toEqual(first);
    expect((await pgError(run(owner, (q) => q("update public.quotes set bank_details = null where id = $1", [quote])))).code).toBe("42501");

    // a new version takes a fresh snapshot when it is sent, not a copy
    const version = await run(member, async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, quote])).id);
    expect(await stored(version)).toBeNull();
    await send(member, org, version);
    expect((await stored(version))?.bank_account).toBe("87654321");
    // so does a duplicate
    const dup = await run(member, async (q) => (await one<{ r: { quote: string } }>(q, "select public.quote_duplicate($1, $2) as r", [org, quote])).r.quote);
    expect(await stored(dup)).toBeNull();
    await setBank(owner, org, "12345678", "העסק שלנו");
    await send(member, org, dup);
    expect((await stored(dup))?.bank_account).toBe("12345678");
    expect((await stored(version))?.bank_account).toBe("87654321");
  });

  it("no bank details in settings = no snapshot", async () => {
    const quote = await newQuote(outsider, otherOrg, otherPipe);
    await run(outsider, (q) => q("update public.org_bank_details set bank_account = null where organization_id = $1", [otherOrg]));
    await send(outsider, otherOrg, quote);
    expect(await stored(quote)).toBeNull();
    await setBank(outsider, otherOrg, "99999999", "העסק האחר");
    expect(await stored(quote)).toBeNull();
  });

  it("the customer page answers `bank` only from the stored snapshot and only while the design shows it", async () => {
    const quote = await newQuote(member, org, pipe);
    await send(member, org, quote);
    const token = await link(member, org, quote);
    const shown = await publicQuote(token);
    expect(shown.bank).toEqual({ bank_name: "בנק הפועלים", bank_branch: "123", bank_account: "12345678", bank_account_name: "העסק שלנו" });
    expect(shown.design.show_bank_details).toBe(true);
    // never the live settings, nor another business's
    await setBank(owner, org, "55555555", "חדש");
    const again = await publicQuote(token);
    expect((again.bank as Bank).bank_account).toBe("12345678");
    expect(JSON.stringify(again)).not.toContain("99999999");
    expect(JSON.stringify(again)).not.toContain("55555555");

    // a member cannot change the design; an owner hides the block and the answer leaves it out
    expect((await pgError(setDesign(member, org, false))).code).toBe("42501");
    await setDesign(owner, org, false);
    const hidden = await publicQuote(token);
    expect(hidden.bank).toBeNull();
    expect(hidden.design.show_bank_details).toBe(false);
    await setDesign(owner, org, true);

    // a quote with no snapshot answers null
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set bank_details = null where id = $1", [quote]);
    });
    expect((await publicQuote(token)).bank).toBeNull();

    // a declined quote's status page shows no bank details at all
    const declined = await newQuote(member, org, pipe);
    await send(member, org, declined);
    const declinedToken = await link(member, org, declined);
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set status = 'rejected' where id = $1", [declined]);
    });
    const page = await publicQuote(declinedToken);
    expect(page.status_page).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain("12345678");
    expect(JSON.stringify(page)).not.toContain("bank");
    // a revoked link answers not found
    await run(member, (q) => q("select public.quote_link_revoke($1, $2)", [org, declined]));
    expect((await pgError(publicQuote(declinedToken))).code).toBe("P0002");
  });

  it("an order takes the snapshot when numbered, never changes it, and its page follows the design", async () => {
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ orders: true })]));
    await setBank(owner, org, "12345678", "העסק שלנו");
    const order = await run(member, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוחה', $2) returning id", [org, member.id])).id;
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      return id;
    });
    const orderBank = () => asAdmin(async (q) => (await one<{ b: Bank | null }>(q, "select bank_details as b from public.orders where id = $1", [order])).b);
    expect(await orderBank()).toBeNull();
    expect((await pgError(run(member, (q) => q("update public.orders set bank_details = '{}'::jsonb where id = $1", [order])))).code).toBe("42501");
    await run(member, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    expect((await orderBank())?.bank_account).toBe("12345678");
    await setBank(owner, org, "11112222", "אחר");
    expect((await orderBank())?.bank_account).toBe("12345678");
    // the member and a viewer read it on the order; a colleague who may not read the order does not
    for (const u of [member, viewer]) {
      const r = await run(u, (q) => q<{ b: Bank }>("select bank_details as b from public.orders where id = $1", [order]));
      expect(r.rows[0]?.b?.bank_account, u.email).toBe("12345678");
    }
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const hidden0 = await run(other, (q) => q("select bank_details from public.orders where id = $1", [order]));
    expect(hidden0.rows).toHaveLength(0);
    // owners and admins keep reading the settings themselves
    const settings = await run(admin, (q) => q("select bank_account from public.org_bank_details where organization_id = $1", [org]));
    expect(settings.rows).toHaveLength(1);

    const token = await run(member, async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, order])).t);
    const page = await asService(async (q) => (await one<{ p: Record<string, unknown> & { design: Record<string, unknown> } }>(q, "select public.order_public($1, null) as p", [token])).p);
    expect((page.bank as Bank).bank_account).toBe("12345678");
    expect(page.design.show_bank_details).toBe(true);
    await setDesign(owner, org, false);
    const hidden = await asService(async (q) => (await one<{ p: Record<string, unknown> }>(q, "select public.order_public($1, null) as p", [token])).p);
    expect(hidden.bank).toBeNull();
    await setDesign(owner, org, true);
    await setBank(owner, org, "12345678", "העסק שלנו");
  });
});
