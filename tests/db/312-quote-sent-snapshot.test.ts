import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type State = {
  vat_rate_bp: number | null;
  subtotal_agorot: number;
  discount_total_agorot: number;
  net_total_agorot: number;
  vat_agorot: number;
  total_agorot: number;
  optional_lines: { id: string; selected: boolean }[];
};

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Owner's answer (175) ג, 9 November 2026 (migration 021190): a quote keeps its state as sent (rate, the five totals and each
 * optional line's selection) in app.quote_sent_states, taken once when it leaves draft, frozen for every writer, read by no
 * client except through public.quote_sent_state (people who may have the quote's PDF made). Versions and duplicates get their
 * own when sent; a quote without one (sent before 021190) answers null, so the app keeps 021187's rule.
 */
describe("a quote's state as sent (owner (175) ג)", () => {
  let owner: U;
  let viewer: U;
  let outsider: U;
  let org: string;
  let outsiderOrg: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const stateRow = (quote: string) =>
    asAdmin(async (q) => (await q<State & { keys: string[] }>(
      `select vat_rate_bp, subtotal_agorot::int, discount_total_agorot::int, net_total_agorot::int, vat_agorot::int, total_agorot::int,
              optional_lines, (select array_agg(k order by k) from jsonb_object_keys(to_jsonb(s)) k) as keys
         from app.quote_sent_states s where quote_id = $1`, [quote])).rows[0] ?? null);
  const stateFor = (user: string, quote: string) =>
    asUser(user, async (q) => (await one<{ s: State | null }>(q, "select public.quote_sent_state($1, $2) as s", [org, quote])).s);
  const hasFor = (user: string, quote: string) =>
    asUser(user, async (q) => (await one<{ b: boolean }>(q, "select public.quote_has_sent_state($1, $2) as b", [org, quote])).b);
  const totals = (quote: string) =>
    asAdmin(async (q) => (await one<{ subtotal: number; total: number }>(q, "select subtotal_agorot::int as subtotal, total_agorot::int as total from public.quotes where id = $1", [quote])));
  const contact = (first: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, first, owner.id])).id);
  const draft = (customer: string) =>
    run(async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, customer])).id;
      await q(
        `insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot, quantity, position)
         values ($1, $2, 'עבודה', 10000, 1, 0)`,
        [org, id],
      );
      await q(
        `insert into public.quote_lines (organization_id, quote_id, name, description, unit_price_agorot, quantity, position, is_optional, optional_selected)
         values ($1, $2, 'תוספת', 'הערה חופשית', 5000, 1, 1, true, false)`,
        [org, id],
      );
      return id;
    });
  const send = (quote: string) => run((q) => q("select public.quote_send($1, $2)", [org, quote]));
  const optionalLine = (quote: string) =>
    asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.quote_lines where quote_id = $1 and is_optional", [quote])).id);
  const accept = async (quote: string) => {
    const token = await run(async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
    const fp = await asService(async (q) => (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint);
    const line = await optionalLine(quote);
    const chosen = await asAdmin(
      async (q) =>
        (await one<{ t: number }>(
          q,
          "select (app.quote_counted_totals(q, q.vat_rate_bp, array[$2::uuid]) ->> 'total_agorot')::int as t from public.quotes q where q.id = $1",
          [quote, line],
        )).t,
    );
    const answer = await asService(
      async (q) =>
        (await one<{ a: { status: string } }>(
          q,
          `select public.quote_public_answer(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'רחל כהן',
                    p_signature_kind => 'drawn', p_signature_image => $3, p_wording_version => 'draft-2026-10-18', p_agreed => true,
                    p_ip => '192.0.2.10', p_user_agent => 'Mozilla/5.0', p_optional_keys => array[2], p_accepted_total_agorot => $4::bigint) as a`,
          [token, fp, PNG, chosen],
        )).a,
    );
    expect(answer.status).toBe("accepted");
    return token;
  };

  beforeAll(async () => {
    owner = await createUser("sent-owner");
    org = await createOrg(owner.id, "סטודיו הנשלחות");
    viewer = await addMember(org, owner.id, "viewer", "sent-viewer");
    outsider = await createUser("sent-outsider");
    outsiderOrg = await createOrg(outsider.id, "עסק אחר");
    for (const o of [org, outsiderOrg]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": true}'::jsonb where organization_id = $1", [o]));
      await asAdmin((q) =>
        q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [o]),
      );
    }
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
  });

  it("is taken once when the quote is sent and stays as sent after the customer's choice changed the totals", async () => {
    const customer = await contact("רחל");
    const q1 = await draft(customer);
    expect(await stateRow(q1)).toBeNull();
    await send(q1);
    const sent = await totals(q1);
    const line = await optionalLine(q1);
    const taken = await stateRow(q1);
    expect(taken).toMatchObject({ subtotal_agorot: 10000, total_agorot: sent.total, optional_lines: [{ id: line, selected: false }] });
    expect(taken.vat_rate_bp).toBe(1800);
    // nothing but ids, flags and amounts: no text, so erasure has nothing to clear in it
    expect(taken.keys).toEqual(
      ["discount_total_agorot", "net_total_agorot", "optional_lines", "organization_id", "quote_id", "subtotal_agorot", "taken_at", "total_agorot", "vat_agorot", "vat_rate_bp"],
    );

    await accept(q1);
    const after = await totals(q1);
    expect(after.subtotal).toBe(15000);
    expect(after.total).not.toBe(sent.total);
    expect(await stateRow(q1)).toMatchObject({ subtotal_agorot: 10000, total_agorot: sent.total, optional_lines: [{ id: line, selected: false }] });
    // the editor reads it; the answer is the sent state
    expect(await stateFor(owner.id, q1)).toMatchObject({ subtotal_agorot: 10000, total_agorot: sent.total, optional_lines: [{ id: line, selected: false }] });
    expect(await hasFor(owner.id, q1)).toBe(true);
  });

  it("is frozen for every writer and read by no client directly", async () => {
    const q1 = await draft(await contact("דנה"));
    await send(q1);
    const refused = await pgError(asAdmin((q) => q("update app.quote_sent_states set total_agorot = 1 where quote_id = $1", [q1])));
    expect(refused.hint).toBe("quote_sent_state:frozen");
    for (const as of [(fn: (q: Query) => Promise<unknown>) => asUser(owner.id, fn), asService]) {
      expect((await pgError(as((q) => q("select * from app.quote_sent_states")))).code).toBe("42501");
      expect((await pgError(as((q) => q("insert into app.quote_sent_states (organization_id, quote_id, subtotal_agorot, discount_total_agorot, net_total_agorot, vat_agorot, total_agorot) values ($1, $2, 0, 0, 0, 0, 0)", [org, q1])))).code).toBe("42501");
    }
    // the quote's own columns carry nothing new: the state is not on public.quotes
    expect(await asAdmin((q) => count(q, "select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name like '%sent_state%'"))).toBe(0);
    // a viewer reads the quote but may not have its PDF made: no amounts, only whether it has one
    expect(await stateFor(viewer.id, q1)).toBeNull();
    expect(await hasFor(viewer.id, q1)).toBe(true);
    // another business learns nothing, also through the app helpers
    expect(await stateFor(outsider.id, q1)).toBeNull();
    expect(await hasFor(outsider.id, q1)).toBe(false);
    expect(await asUser(outsider.id, async (q) => (await one<{ s: unknown }>(q, "select app.quote_sent_state_of($1, $2) as s", [org, q1])).s)).toBeNull();
    expect(await asUser(outsider.id, async (q) => (await one<{ b: boolean }>(q, "select app.quote_sent_state_exists($1, $2) as b", [org, q1])).b)).toBe(false);
    // review L3: only in a writable business with the quotes key (the PDF paths' rule)
    expect(await stateFor(owner.id, q1)).not.toBeNull();
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    expect(await stateFor(owner.id, q1)).toBeNull();
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"quotes\": false}'::jsonb where organization_id = $1", [org]));
    expect(await stateFor(owner.id, q1)).toBeNull();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"quotes\": true}'::jsonb where organization_id = $1", [org]));
    expect(await stateFor(owner.id, q1)).not.toBeNull();
    // review L1: no insert trigger (quotes_check makes every new quote a draft)
    expect(await asAdmin((q) => count(q, "select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname like 'quotes_sent_state%'"))).toBe(1);
    // anon may call neither
    expect(
      (await pgError(asAnon((q) => q("select public.quote_sent_state($1, $2)", [org, q1])))).code,
    ).toBe("42501");
  });

  it("a draft has none; a version and a duplicate get their own only when they are sent", async () => {
    const q1 = await draft(await contact("יואב"));
    await send(q1);
    const version = await run(async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, q1])).id);
    const duplicate = await run(async (q) => {
      const r = await one<{ d: unknown }>(q, "select public.quote_duplicate($1, $2) as d", [org, q1]);
      return typeof r.d === "string" ? r.d : ((r.d as { id?: string; quote_id?: string }).id ?? (r.d as { quote_id: string }).quote_id);
    });
    expect(await stateRow(version)).toBeNull();
    expect(await stateRow(duplicate)).toBeNull();
    expect(await stateFor(owner.id, version)).toBeNull();
    // the version's own lines (a changed price), taken when it is sent
    await run((q) => q("update public.quote_lines set unit_price_agorot = 20000 where quote_id = $1 and not is_optional", [version]));
    await send(version);
    expect((await stateRow(version))?.subtotal_agorot).toBe(20000);
    expect((await stateRow(q1))?.subtotal_agorot).toBe(10000);
  });

  it("survives the customer's erasure without holding anything personal", async () => {
    const customer = await contact("מיכל");
    const q1 = await draft(customer);
    await send(q1);
    const before = await stateRow(q1);
    await asAdmin((q) => q("delete from public.contacts where id = $1", [customer]));
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, customer]));
    const after = await stateRow(q1);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("מיכל");
    expect(JSON.stringify(after)).not.toContain("הערה חופשית");
  });

  it("a quote without one (sent before 021190) answers null, so the app keeps 021187's rule", async () => {
    const q1 = await draft(await contact("עדי"));
    await send(q1);
    // as a quote sent before the migration: no row
    await asAdmin((q) => q("delete from app.quote_sent_states where quote_id = $1", [q1]));
    expect(await stateFor(owner.id, q1)).toBeNull();
    expect(await hasFor(owner.id, q1)).toBe(false);
    // accepting it later takes nothing (the snapshot is the sending moment only)
    await accept(q1);
    expect(await stateRow(q1)).toBeNull();
  });
});
