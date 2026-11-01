import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { kind: string; name: string; is_optional: boolean; optional_selected: boolean; total_agorot: number };
type PageQuote = { quote: { number: string; status: string; net_total_agorot: number; total_agorot: number }; lines: Line[] };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * QUO-08 rest (owner, 1 November 2026, answers (27) א and (28) א). (1) The customer ticks the optional lines they want on the
 * quote's page; the choice goes with the acceptance (public.quote_public_answer), is checked line by line and against the total
 * the page showed, is kept in the decision with its own fingerprint, and becomes the accepted quote's (its lines and totals),
 * so the deal step and every reader of an accepted quote read what was accepted. (2) The customer may send a question of
 * 1..500 characters (public.quote_public_question): rate limited, one system entry on the timeline that no person may touch,
 * a `quote` notice to the quote's recipients, and a privacy erasure empties the text.
 */
describe("the customer's page: optional lines and a question (QUO-08)", () => {
  let owner: U, member: U, outsider: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  // a sent quote: a heading, one item (500 ₪), optional A (100 ₪, not preselected), optional B (200 ₪, preselected)
  const sentQuote = (opts: { discountAgorot?: number; dealOnly?: boolean } = {}) =>
    asUser(member.id, async (q) => {
      const contact = opts.dealOnly
        ? null
        : (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stageId,
          contact,
          member.id,
        ])
      ).id;
      const quote = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'שיפוץ', $2, $3) returning id", [org, deal, contact])
      ).id;
      const line = async (position: number, kind: string, name: string, price: number, optional = false, selected = false) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.quote_lines (organization_id, quote_id, position, kind, name, unit_price_agorot, is_optional, optional_selected)
             values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
            [org, quote, position, kind, name, kind === "group" ? 0 : price, optional, selected],
          )
        ).id;
      const heading = await line(1, "group", "עבודות", 0);
      const item = await line(2, "item", "עבודה", 50000);
      const a = await line(3, "item", "תוספת א", 10000, true, false);
      const b = await line(4, "item", "תוספת ב", 20000, true, true);
      if (opts.discountAgorot) await q("update public.quotes set discount_agorot = $2 where id = $1", [quote, opts.discountAgorot]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return { quote, deal, contact, heading, item, a, b };
    });
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const page = (token: string) => asService(async (q) => (await one<{ p: PageQuote }>(q, "select public.quote_public($1) as p", [token])).p);
  const fingerprint = (token: string) =>
    asService(async (q) => (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint);
  const answer = (token: string, args: { fingerprint: string; decision?: string; keys?: number[] | null; total?: number | null }) =>
    asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_answer(p_token => $1, p_decision => $2, p_fingerprint => $3, p_signer_name => 'נועה לוי',
                      p_signature_kind => 'drawn', p_signature_image => $4, p_wording_version => 'draft-2026-10-18', p_agreed => true,
                      p_ip => '192.0.2.10', p_user_agent => 'Mozilla/5.0', p_optional_keys => $5::integer[], p_accepted_total_agorot => $6) as a`,
            [token, args.decision ?? "accepted", args.fingerprint, PNG, args.keys === undefined ? null : args.keys, args.total ?? null],
          )
        ).a,
    );
  const quoteRow = (quote: string) =>
    asAdmin((q) =>
      one<{ status: string; subtotal_agorot: string; net_total_agorot: string; vat_agorot: string; total_agorot: string; vat_rate_bp: number }>(
        q,
        "select status, subtotal_agorot, net_total_agorot, vat_agorot, total_agorot, vat_rate_bp from public.quotes where id = $1",
        [quote],
      ),
    );
  // the total with VAT of a set of net amounts at the quote's rate (one taxable line set, half up), as app.document_totals
  const withVat = (net: number, rateBp: number) => net + Math.floor((2 * net * rateBp + 10000) / 20000);

  beforeAll(async () => {
    owner = await createUser("qpo-owner");
    org = await createOrg(owner.id, "עסק הבחירות");
    member = await addMember(org, owner.id, "member", "qpo-member");
    outsider = await createUser("qpo-outsider");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, discounts: true })]));
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status, quote_accept_deal) values ($1, 'licensed', 'auto') on conflict (organization_id) do update set quote_accept_deal = 'auto'", [org]),
    );
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
  });

  it("the sent quote counts the rep's preselection, and the page lists every line in the order the keys name", async () => {
    const { quote } = await sentQuote();
    const token = await linkOf(quote);
    const shown = await page(token);
    expect(shown.lines.map((l) => [l.kind, l.is_optional, l.optional_selected])).toEqual([
      ["group", false, false],
      ["item", false, false],
      ["item", true, false],
      ["item", true, true],
    ]);
    const row = await quoteRow(quote);
    // item + preselected B
    expect(Number(row.net_total_agorot)).toBe(70000);
    expect(Number(row.total_agorot)).toBe(withVat(70000, row.vat_rate_bp));
  });

  it("accepting with a choice keeps it in the decision and makes it the accepted quote's, its deal's lines and amount", async () => {
    const ids = await sentQuote();
    const token = await linkOf(ids.quote);
    const fp = await fingerprint(token);
    const sent = await quoteRow(ids.quote);
    const total = withVat(60000, sent.vat_rate_bp);
    // the customer ticks A (place 3) and leaves B (place 4)
    expect(await answer(token, { fingerprint: fp, keys: [3], total })).toEqual({ status: "accepted" });

    const decision = await asAdmin((q) =>
      one<Record<string, unknown>>(
        q,
        `select content_sha256, optional_line_ids, choice_sha256, sent_net_total_agorot, sent_total_agorot, accepted_subtotal_agorot,
                accepted_net_total_agorot, accepted_total_agorot from public.quote_decisions where quote_id = $1`,
        [ids.quote],
      ),
    );
    expect(decision).toEqual({
      content_sha256: fp,
      optional_line_ids: [ids.a],
      choice_sha256: sha(`${fp}:${ids.a}`),
      sent_net_total_agorot: "70000",
      sent_total_agorot: sent.total_agorot,
      accepted_subtotal_agorot: "60000",
      accepted_net_total_agorot: "60000",
      accepted_total_agorot: String(total),
    });
    // the accepted quote holds what was accepted: its lines and its totals, at the rate it was sent with
    const accepted = await quoteRow(ids.quote);
    expect(accepted).toMatchObject({ status: "accepted", net_total_agorot: "60000", total_agorot: String(total), vat_rate_bp: sent.vat_rate_bp });
    const lines = await asAdmin(async (q) => (await q<{ id: string; s: boolean }>("select id, optional_selected as s from public.quote_lines where quote_id = $1 and is_optional", [ids.quote])).rows);
    expect(Object.fromEntries(lines.map((l) => [l.id, l.s]))).toEqual({ [ids.a]: true, [ids.b]: false });
    // QUO-13 (auto): the deal's lines are the accepted lines and its amount the accepted net, marked by the quote
    const deal = await asAdmin((q) => one<{ amount: string; mark: string | null }>(q, "select amount_agorot as amount, amount_quote_id as mark from public.deals where id = $1", [ids.deal]));
    expect(deal).toEqual({ amount: "60000", mark: ids.quote });
    const dealLines = await asAdmin(async (q) => (await q<{ name: string }>("select description as name from public.deal_lines where deal_id = $1 order by position, id", [ids.deal])).rows);
    expect(dealLines.map((l) => l.name)).toEqual(["עבודה", "תוספת א"]);
    // the page shows the accepted quote with the customer's choice
    const after = await page(token);
    expect(after.quote.net_total_agorot).toBe(60000);
    expect(after.lines.map((l) => l.optional_selected)).toEqual([false, false, true, false]);
  });

  // the page starts with every optional line unticked (owner, 1 November 2026); accepting that start is a choice of none, even
  // where the rep preselected a line, and the quote's figures follow it
  it("no optional line ticked (the page's start) is a choice too, also over the rep's preselection", async () => {
    const ids = await sentQuote();
    const token = await linkOf(ids.quote);
    const fp = await fingerprint(token);
    const rate = (await quoteRow(ids.quote)).vat_rate_bp;
    expect(await answer(token, { fingerprint: fp, keys: [], total: withVat(50000, rate) })).toEqual({ status: "accepted" });
    const d = await asAdmin((q) => one<{ ids: string[]; c: string }>(q, "select optional_line_ids as ids, choice_sha256 as c from public.quote_decisions where quote_id = $1", [ids.quote]));
    expect(d).toEqual({ ids: [], c: sha(`${fp}:`) });
    expect((await quoteRow(ids.quote)).net_total_agorot).toBe("50000");
    // the preselected B is no longer counted on the accepted quote
    expect(await asAdmin(async (q) => (await one<{ s: boolean }>(q, "select optional_selected as s from public.quote_lines where id = $1", [ids.b])).s)).toBe(false);
  });

  it("an unknown, repeated, heading or required line, a missing or wrong total decide nothing", async () => {
    const ids = await sentQuote();
    const token = await linkOf(ids.quote);
    const fp = await fingerprint(token);
    const rate = (await quoteRow(ids.quote)).vat_rate_bp;
    const good = withVat(60000, rate);
    for (const [keys, total, want] of [
      [[2], withVat(50000, rate), "invalid"], // a line that is not optional
      [[1], withVat(50000, rate), "invalid"], // the heading
      [[9], good, "invalid"], // no such line
      [[0], good, "invalid"],
      [[3, 3], good, "invalid"], // repeated
      [[3], null, "invalid"], // a choice without the total it showed
      [[3], good + 1, "changed"], // a total that is not the choice's
      [[3, 4], good, "changed"],
    ] as [number[], number | null, string][]) {
      expect(await answer(token, { fingerprint: fp, keys, total }), JSON.stringify(keys)).toEqual({ status: want });
    }
    // a total without a choice
    expect(await answer(token, { fingerprint: fp, keys: null, total: good })).toEqual({ status: "invalid" });
    // a null inside the keys
    const withNull = await asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_answer(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה לוי',
                      p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true,
                      p_optional_keys => array[3, null]::integer[], p_accepted_total_agorot => $3) as a`,
            [token, fp, good],
          )
        ).a,
    );
    expect(withNull).toEqual({ status: "invalid" });
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_decisions where quote_id = $1", [ids.quote]))).toBe(0);
    const row = await quoteRow(ids.quote);
    expect(row.status).toBe("sent");
    expect(row.net_total_agorot).toBe("70000");
    // and then the right one passes (the tries above filled the link's window of 10)
    await asAdmin((q) => q("update app.quote_links set decide_count = 0 where quote_id = $1", [ids.quote]));
    expect(await answer(token, { fingerprint: fp, keys: [3], total: good })).toEqual({ status: "accepted" });
  });

  it("QUO-09's entry point still accepts with the rep's preselection; a refusal keeps no choice", async () => {
    const first = await sentQuote();
    const token = await linkOf(first.quote);
    const fp = await fingerprint(token);
    const sent = await quoteRow(first.quote);
    const old = await asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה לוי',
                      p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
            [token, fp],
          )
        ).a,
    );
    expect(old).toEqual({ status: "accepted" });
    const d = await asAdmin((q) => one<{ ids: string[]; t: string }>(q, "select optional_line_ids as ids, accepted_total_agorot as t from public.quote_decisions where quote_id = $1", [first.quote]));
    expect(d).toEqual({ ids: [first.b], t: sent.total_agorot });
    expect((await quoteRow(first.quote)).total_agorot).toBe(sent.total_agorot);

    const second = await sentQuote();
    const token2 = await linkOf(second.quote);
    expect(await answer(token2, { fingerprint: await fingerprint(token2), decision: "rejected", keys: [3], total: 1 })).toEqual({ status: "rejected" });
    const r = await asAdmin((q) =>
      one<Record<string, unknown>>(q, "select optional_line_ids, choice_sha256, accepted_total_agorot from public.quote_decisions where quote_id = $1", [second.quote]),
    );
    expect(r).toEqual({ optional_line_ids: null, choice_sha256: null, accepted_total_agorot: null });
    expect((await quoteRow(second.quote)).net_total_agorot).toBe("70000");
  });

  it("a fixed document discount larger than the chosen lines is refused", async () => {
    const ids = await sentQuote({ discountAgorot: 55000 });
    const token = await linkOf(ids.quote);
    const fp = await fingerprint(token);
    expect(await answer(token, { fingerprint: fp, keys: [], total: 0 })).toEqual({ status: "invalid" });
    expect((await quoteRow(ids.quote)).status).toBe("sent");
  });

  it("a person cannot replay the server's choice: the lines and totals of a sent quote stay frozen for them", async () => {
    const ids = await sentQuote();
    // RLS writes drafts only; the setting is honoured only without a person
    const n = await asUser(member.id, async (q) => {
      await q("select set_config('app.quote_accept_choice', $1, true)", [ids.quote]);
      return (await q("update public.quote_lines set optional_selected = true where id = $1 returning 1", [ids.a])).rowCount;
    });
    expect(n).toBe(0);
    await asAdmin(async (q) => {
      // a server update without the setting keeps the sent totals
      await q("update public.quote_lines set optional_selected = true where id = $1", [ids.a]);
      expect((await one<{ n: string }>(q, "select net_total_agorot as n from public.quotes where id = $1", [ids.quote])).n).toBe("70000");
      await q("update public.quote_lines set optional_selected = false where id = $1", [ids.a]);
    });
  });

  it("the server's recompute holds only for the quote the setting names, and never after the decision", async () => {
    const ids = await sentQuote();
    const other = await sentQuote();
    const net = (quote: string) => asAdmin(async (q) => (await one<{ n: string }>(q, "select net_total_agorot as n from public.quotes where id = $1", [quote])).n);
    // as the server (auth.uid() is null): the setting names another quote, so this sent quote keeps its sent totals
    await asAdmin(async (q) => {
      expect((await one<{ u: string | null }>(q, "select auth.uid() as u")).u).toBeNull();
      await q("select set_config('app.quote_accept_choice', $1, true)", [other.quote]);
      await q("update public.quote_lines set optional_selected = true where id = $1", [ids.a]);
      expect((await one<{ n: string }>(q, "select net_total_agorot as n from public.quotes where id = $1", [ids.quote])).n).toBe("70000");
      await q("update public.quote_lines set optional_selected = false where id = $1", [ids.a]);
    });
    expect(await net(ids.quote)).toBe("70000");
    // an accepted quote keeps its accepted totals even while the setting names it
    const token = await linkOf(ids.quote);
    const rate = (await quoteRow(ids.quote)).vat_rate_bp;
    expect(await answer(token, { fingerprint: await fingerprint(token), keys: [], total: withVat(50000, rate) })).toEqual({ status: "accepted" });
    await asAdmin(async (q) => {
      await q("select set_config('app.quote_accept_choice', $1, true)", [ids.quote]);
      await q("update public.quote_lines set optional_selected = true where id = $1", [ids.a]);
      expect((await one<{ n: string }>(q, "select net_total_agorot as n from public.quotes where id = $1", [ids.quote])).n).toBe("50000");
      await q("update public.quote_lines set optional_selected = false where id = $1", [ids.a]);
    });
    expect(await net(ids.quote)).toBe("50000");
  });

  it("the version reader tells the page when the stored PDF is the quote as sent", async () => {
    const version = (token: string) => asService(async (q) => (await one<{ v: Record<string, unknown> }>(q, "select public.quote_public_version($1) as v", [token])).v);
    // the choice changed the total
    const changed = await sentQuote();
    const t1 = await linkOf(changed.quote);
    const rate = (await quoteRow(changed.quote)).vat_rate_bp;
    expect(Object.keys(await version(t1)).sort()).toEqual(["fingerprint", "number"]);
    await answer(t1, { fingerprint: await fingerprint(t1), keys: [3], total: withVat(60000, rate) });
    expect(await version(t1)).toMatchObject({ fingerprint: null, pdf_as_sent: true });
    // the rep's preselection accepted as it was
    const same = await sentQuote();
    const t2 = await linkOf(same.quote);
    await answer(t2, { fingerprint: await fingerprint(t2), keys: [4], total: withVat(70000, rate) });
    expect(await version(t2)).toEqual({ number: (await page(t2)).quote.number, fingerprint: null });
  });

  it("only the server may call the two functions", async () => {
    for (const fn of ["public.quote_public_answer(text,text,text,text,text,text,text,text,boolean,text,text,text,integer[],bigint)", "public.quote_public_question(text,text,text)"]) {
      const rights = await asAdmin((q) =>
        one<{ anon: boolean; auth: boolean; service: boolean }>(
          q,
          `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                  has_function_privilege('service_role', $1, 'execute') as service`,
          [fn],
        ),
      );
      expect(rights, fn).toEqual({ anon: false, auth: false, service: true });
    }
    expect((await pgError(asAnon((q) => q("select public.quote_public_question('x', null, 'שאלה')")))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.quote_public_question('x', null, 'שאלה')")))).code).toBe("42501");
  });

  describe("a question to the rep", () => {
    const ask = (token: string, text: string | null, hash: string | null = "sender-1") =>
      asService(async (q) => (await one<{ a: { status: string } }>(q, "select public.quote_public_question($1, $2, $3) as a", [token, hash, text])).a);
    const entries = (quote: string) =>
      asAdmin(
        async (q) =>
          (
            await q<{ type: string; body: string; deal_id: string | null; contact_id: string | null; created_by: string | null; kind: string }>(
              "select type, body, deal_id, contact_id, created_by, metadata->>'kind' as kind from public.activities where metadata->>'quote_id' = $1 and metadata->>'kind' = 'quote_question'",
              [quote],
            )
          ).rows,
      );
    const notices = (quote: string) =>
      asAdmin(
        async (q) =>
          (await q<{ user_id: string; type: string; title: string; body: string }>("select user_id, type, title, body from public.notifications where entity_id = $1 and title like 'שאלה%'", [quote]))
            .rows,
      );

    it("writes one system entry and tells the quote's owner; only the answer comes back", async () => {
      const ids = await sentQuote();
      const token = await linkOf(ids.quote);
      expect(await ask(token, "  אפשר להתחיל ביום ראשון?\r\nתודה  ")).toEqual({ status: "sent" });
      const number = (await page(token)).quote.number;
      expect(await entries(ids.quote)).toEqual([
        {
          type: "system",
          body: `שאלה מהלקוח על הצעת מחיר ${number}: אפשר להתחיל ביום ראשון?\nתודה`,
          deal_id: ids.deal,
          contact_id: ids.contact,
          created_by: null,
          kind: "quote_question",
        },
      ]);
      expect(await notices(ids.quote)).toEqual([
        { user_id: member.id, type: "quote", title: "שאלה על הצעת מחיר: שיפוץ", body: `הצעה ${number} · שאלה: אפשר להתחיל ביום ראשון?\nתודה` },
      ]);
      // the entry is history: a person may not change or delete it
      const entry = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.activities where metadata->>'quote_id' = $1 and metadata->>'kind' = 'quote_question'", [ids.quote])).id);
      expect((await pgError(asUser(owner.id, (q) => q("update public.activities set body = 'x' where id = $1", [entry])))).hint).toBe("activity:quote_entry");
      expect((await pgError(asUser(owner.id, (q) => q("delete from public.activities where id = $1", [entry])))).hint).toBe("activity:quote_entry");
      // nor write one
      expect(
        (
          await pgError(
            asUser(owner.id, (q) =>
              q("insert into public.activities (organization_id, type, deal_id, body, metadata) values ($1, 'note', $2, 'x', $3)", [org, ids.deal, JSON.stringify({ kind: "quote_question" })]),
            ),
          )
        ).hint,
      ).toBe("activity:quote_entry");
    });

    it("refuses an empty or too long text, and answers closed on a declined quote", async () => {
      const ids = await sentQuote();
      const token = await linkOf(ids.quote);
      expect(await ask(token, "   ")).toEqual({ status: "invalid" });
      expect(await ask(token, null)).toEqual({ status: "invalid" });
      expect(await ask(token, "א".repeat(501))).toEqual({ status: "invalid" });
      expect(await ask(token, "א".repeat(500))).toEqual({ status: "sent" });
      // an accepted quote still takes a question
      const rate = (await quoteRow(ids.quote)).vat_rate_bp;
      expect(await answer(token, { fingerprint: await fingerprint(token), keys: [], total: withVat(50000, rate) })).toEqual({ status: "accepted" });
      expect(await ask(token, "מתי מתחילים?")).toEqual({ status: "sent" });

      const declined = await sentQuote();
      const token2 = await linkOf(declined.quote);
      await answer(token2, { fingerprint: await fingerprint(token2), decision: "rejected" });
      expect(await ask(token2, "למה?")).toEqual({ status: "closed" });
      expect(await entries(declined.quote)).toEqual([]);
      // an unknown link is not found
      expect((await pgError(ask("A".repeat(64), "שלום"))).code).toBe("P0002");
      expect((await pgError(ask("short", "שלום"))).code).toBe("P0002");
    });

    it("answers closed on an expired or a cancelled quote", async () => {
      const expired = await sentQuote();
      const t1 = await linkOf(expired.quote);
      await asAdmin((q) => q("update public.quotes set status = 'expired' where id = $1", [expired.quote]));
      expect(await ask(t1, "עדיין בתוקף?")).toEqual({ status: "closed" });
      const cancelled = await sentQuote();
      const t2 = await linkOf(cancelled.quote);
      await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, cancelled.quote]));
      expect(await ask(t2, "למה בוטלה?")).toEqual({ status: "closed" });
      expect([...(await entries(expired.quote)), ...(await entries(cancelled.quote))]).toEqual([]);
    });

    it("a question through an older version's link lands on the version the page shows", async () => {
      const first = await sentQuote();
      const oldToken = await linkOf(first.quote);
      const newer = await asUser(member.id, async (q) => {
        const id = (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, first.quote])).id;
        await q("select public.quote_send($1, $2)", [org, id]);
        return id;
      });
      expect(await ask(oldToken, "מה השתנה?")).toEqual({ status: "sent" });
      expect(await entries(first.quote)).toEqual([]);
      expect(await entries(newer)).toHaveLength(1);
      expect((await notices(newer)).length).toBeGreaterThan(0);
    });

    it("cleans invisible and control characters, and refuses an empty or 21-line text", async () => {
      const ids = await sentQuote();
      const token = await linkOf(ids.quote);
      const zw = String.fromCodePoint(0x200b, 0x200d, 0xfeff);
      const bidi = String.fromCodePoint(0x202e, 0x2066, 0x200f);
      const c1 = String.fromCodePoint(0x85, 0x9f);
      expect(await ask(token, `${bidi}שא${zw}לה${c1}א\tב${bidi}`)).toEqual({ status: "sent" });
      const body = (await entries(ids.quote))[0].body;
      expect(body.endsWith(": שאלה  א ב")).toBe(true);
      expect(await ask(token, `${zw}${bidi}  ${zw}`)).toEqual({ status: "invalid" });
      expect(await ask(token, Array.from({ length: 21 }, (_, i) => `שורה ${i}`).join("\n"))).toEqual({ status: "invalid" });
      expect(await ask(token, Array.from({ length: 20 }, (_, i) => `שורה ${i}`).join("\n"))).toEqual({ status: "sent" });
    });

    it("5 per sender in 10 minutes, and 20 per link in 24 hours", async () => {
      const ids = await sentQuote();
      const token = await linkOf(ids.quote);
      for (let i = 0; i < 5; i++) expect(await ask(token, `שאלה ${i}`, "sender-a")).toEqual({ status: "sent" });
      expect(await ask(token, "עוד אחת", "sender-a")).toEqual({ status: "rate_limited" });
      // another sender still may
      expect(await ask(token, "שאלה אחרת", "sender-b")).toEqual({ status: "sent" });
      expect(await entries(ids.quote)).toHaveLength(6);
      // the hash itself is never kept
      expect(await asAdmin((q) => count(q, "select 1 from app.quote_question_counts where quote_id = $1 and window_start is not null", [ids.quote]))).toBeGreaterThan(0);
      // the link's own cap: question 21 within a day is refused, whoever sends it
      await asAdmin((q) => q("update app.quote_links set question_window_started_at = now(), question_count = 20 where quote_id = $1", [ids.quote]));
      expect(await ask(token, "שאלה", "sender-c")).toEqual({ status: "rate_limited" });
      await asAdmin((q) => q("update app.quote_links set question_window_started_at = now() - interval '25 hours' where quote_id = $1", [ids.quote]));
      expect(await ask(token, "שאלה", "sender-c")).toEqual({ status: "sent" });
    });

    it("a privacy erasure of the customer empties the question in the entry and the notice", async () => {
      const ids = await sentQuote();
      const token = await linkOf(ids.quote);
      await ask(token, "נועה כאן, אפשר הנחה?");
      const other = await sentQuote();
      const token2 = await linkOf(other.quote);
      await ask(token2, "שאלה של לקוח אחר");
      const number = (await page(token)).quote.number;

      await asUser(owner.id, async (q) => {
        await q("update public.contacts set deleted_at = now() where id = $1", [ids.contact]);
        await q("delete from public.contacts where id = $1", [ids.contact]);
      });
      await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, ids.contact]));

      expect((await entries(ids.quote)).map((e) => e.body)).toEqual([`שאלה מהלקוח על הצעת מחיר ${number} (הטקסט נמחק)`]);
      expect(await notices(ids.quote)).toEqual([{ user_id: member.id, type: "quote", title: "שאלה על הצעת מחיר: הצעת מחיר", body: `הצעה ${number}` }]);
      // the entry's audit history is erased too
      const audits = await asAdmin(async (q) =>
        (
          await q<{ changes: unknown }>(
            "select a.changes from public.audit_log a join public.activities ac on ac.id = a.entity_id where a.entity_type = 'activities' and ac.metadata->>'quote_id' = $1 and ac.metadata->>'kind' = 'quote_question'",
            [ids.quote],
          )
        ).rows,
      );
      for (const a of audits) expect(JSON.stringify(a.changes)).not.toContain("הנחה");
      // another customer's question stays
      expect((await entries(other.quote))[0].body).toContain("שאלה של לקוח אחר");
    });

    it("a quote of a deal with no contact: erasing the deal empties its question", async () => {
      const ids = await sentQuote({ dealOnly: true });
      const token = await linkOf(ids.quote);
      await ask(token, "נועה שואלת על המחיר");
      const number = (await page(token)).quote.number;
      expect((await entries(ids.quote))[0]).toMatchObject({ deal_id: ids.deal, contact_id: null });
      await asUser(owner.id, async (q) => {
        await q("update public.deals set deleted_at = now() where id = $1", [ids.deal]);
        await q("delete from public.deals where id = $1", [ids.deal]);
      });
      await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, ids.deal]));
      // the entry went with the deal (it was the deal's alone); the notice keeps no text
      for (const e of await entries(ids.quote)) expect(e.body).not.toContain("נועה");
      expect(await notices(ids.quote)).toEqual([{ user_id: member.id, type: "quote", title: "שאלה על הצעת מחיר: הצעת מחיר", body: `הצעה ${number}` }]);
    });
  });
});
