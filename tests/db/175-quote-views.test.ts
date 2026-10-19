import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Views = { first_viewed_at: Date; last_viewed_at: Date; view_count: number };

/**
 * QUO-10 (owner, 18 October 2026, answer 17): opening the customer's page counts a view (first, last, how many); the
 * first view of a sent quote marks it viewed, once, and sends `quote_viewed` to the quote's owner, which a person can mute.
 */
describe("quote views (QUO-10)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const sentQuote = async (u: U, title = "הצעה ללקוח") => {
    const quote = await asUser(u.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'רונית') returning id", [org])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          contact,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, $2, $3) returning id", [org, title, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const token = await asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
    return { quote, token };
  };
  const open = (token: string) => asService(async (q) => (await one<{ p: { quote?: { status: string }; rate_limited?: boolean } }>(q, "select public.quote_public($1) as p", [token])).p);
  const statusOf = (quote: string) => asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.quotes where id = $1", [quote])).status);
  const viewsOf = (quote: string) => asAdmin(async (q) => (await q<Views>("select first_viewed_at, last_viewed_at, view_count from public.quote_views where quote_id = $1", [quote])).rows[0]);
  const noticesOf = (user: U, quote: string) =>
    asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'quote_viewed' and entity_type = 'quote' and entity_id = $2", [user.id, quote]));
  const auditOf = (quote: string) => asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1", [quote]));

  beforeAll(async () => {
    owner = await createUser("qv-owner");
    org = await createOrg(owner.id, "עסק הצפיות");
    member = await addMember(org, owner.id, "member", "qv-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("the first view marks the quote viewed and tells its owner once; later views only count", async () => {
    const { quote, token } = await sentQuote(member);
    expect(await viewsOf(quote)).toBeUndefined();
    const auditBefore = await auditOf(quote);

    const first = await open(token);
    expect(first.quote?.status).toBe("viewed");
    expect(await statusOf(quote)).toBe("viewed");
    const afterFirst = await viewsOf(quote);
    expect(afterFirst.view_count).toBe(1);
    expect(afterFirst.first_viewed_at.getTime()).toBe(afterFirst.last_viewed_at.getTime());
    expect(await noticesOf(member, quote)).toBe(1);
    // the owner of the quote, not the business owner
    expect(await noticesOf(owner, quote)).toBe(0);
    const notice = await asAdmin(async (q) =>
      one<{ title: string; body: string | null }>(q, "select title, body from public.notifications where user_id = $1 and entity_id = $2", [member.id, quote]),
    );
    expect(notice.title).toMatch(/^הלקוח פתח את הצעת המחיר /);
    expect(notice.body).toBe("הצעה ללקוח");

    await open(token);
    await open(token);
    const later = await viewsOf(quote);
    expect(later.view_count).toBe(3);
    expect(later.first_viewed_at.getTime()).toBe(afterFirst.first_viewed_at.getTime());
    expect(later.last_viewed_at.getTime()).toBeGreaterThanOrEqual(afterFirst.last_viewed_at.getTime());
    expect(await noticesOf(member, quote)).toBe(1);
    // one audit entry for the status change; the counted views write none
    expect(await auditOf(quote)).toBe(auditBefore + 1);
  });

  it("the notice carries no personal data: the quote's number and title, never the customer's name", async () => {
    const { quote, token } = await sentQuote(member, "הצעת מחיר לשיפוץ");
    const customer = await asAdmin(async (q) => (await one<{ c: string }>(q, "select customer_name as c from public.quotes where id = $1", [quote])).c);
    expect(customer).toBe("רונית");
    await open(token);
    const notice = await asAdmin(async (q) =>
      one<{ title: string; body: string | null }>(q, "select title, body from public.notifications where user_id = $1 and entity_id = $2", [member.id, quote]),
    );
    const number = await asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.quotes where id = $1", [quote])).n);
    expect(notice.title).toBe(`הלקוח פתח את הצעת המחיר ${number}`);
    expect(notice.body).toBe("הצעת מחיר לשיפוץ");
    expect(`${notice.title} ${notice.body ?? ""}`).not.toContain(customer);
  });

  it("a person who muted quote_viewed gets nothing; the quote is still marked viewed", async () => {
    await asUser(member.id, (q) => q("select public.set_notification_settings($1::text[], $2::text[])", ["{quote_viewed}", "{}"]));
    const { quote, token } = await sentQuote(member, "הצעה שקטה");
    await open(token);
    expect(await statusOf(quote)).toBe("viewed");
    expect(await noticesOf(member, quote)).toBe(0);
    await asUser(member.id, (q) => q("select public.set_notification_settings($1::text[], $2::text[])", ["{}", "{}"]));
  });

  it("a view over the page's limit is not counted", async () => {
    const { quote, token } = await sentQuote(member, "הצעה עמוסה");
    await open(token);
    await asAdmin((q) => q("update app.quote_links set window_started_at = now(), window_count = 120 where quote_id = $1", [quote]));
    expect((await open(token)).rate_limited).toBe(true);
    expect((await viewsOf(quote)).view_count).toBe(1);
  });

  it("an owner who left the business is not told, and the quote is still marked viewed", async () => {
    const leaver = await addMember(org, owner.id, "member", "qv-leaver");
    const { quote, token } = await sentQuote(leaver, "הצעה של מי שעזב");
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    await open(token);
    expect(await statusOf(quote)).toBe("viewed");
    expect(await noticesOf(leaver, quote)).toBe(0);
  });

  it("the counting function is not callable from the API, and quote_views take no client writes", async () => {
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ a: boolean; s: boolean; ins: boolean }>(
            `select has_function_privilege('authenticated', 'app.quote_mark_viewed(public.quotes)', 'execute') as a,
                    has_function_privilege('service_role', 'app.quote_mark_viewed(public.quotes)', 'execute') as s,
                    has_table_privilege('authenticated', 'public.quote_views', 'insert') as ins`,
          )
        ).rows[0],
    );
    expect(grants).toEqual({ a: false, s: false, ins: false });
    expect((await pgError(asUser(member.id, (q) => q("select app.quote_mark_viewed(null::public.quotes)")))).code).toBe("42501");
  });
});
