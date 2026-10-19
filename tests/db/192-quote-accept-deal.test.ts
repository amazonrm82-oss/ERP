import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Mode = "auto" | "ask" | "none";

/**
 * QUO-13 part one: when the customer accepts a quote, the business's setting (org_document_settings.quote_accept_deal,
 * default 'ask') says what happens to the quote's deal. auto: the deal's lines become the quote's (selected options only,
 * priced as on the quote) and the deal moves to its pipeline's first won stage through the ordinary triggers; ask: the
 * notice asks, and a person does it from the quote page (public.quote_lines_to_deal, then the won window); none: nothing.
 * Never a closed, binned or other deal; never an addendum; and the decision itself never fails because of this step.
 */
describe("an accepted quote and its deal (QUO-13 part one)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  let pipelineId: string, openStage: string, wonStage: string, lostStage: string;
  let product: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setMode = (mode: Mode) =>
    asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status, quote_accept_deal) values ($1, 'licensed', $2) on conflict (organization_id) do update set quote_accept_deal = $2", [
        org,
        mode,
      ]),
    );
  const setBusinessVat = (inclusive: boolean) =>
    asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = $2 where organization_id = $1", [org, inclusive]));

  // a deal with one old line, and a sent quote on it with a heading, a line, a chosen option and an option left out
  const sentQuote = async (opts: { noDeal?: boolean } = {}) =>
    asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה', $2) returning id", [org, member.id])).id;
      const deal = opts.noDeal
        ? null
        : (
            await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'שיפוץ', $2, $3, $4, $5) returning id", [
              org,
              pipelineId,
              openStage,
              contact,
              member.id,
            ])
          ).id;
      if (deal) await q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot) values ($1, $2, 'שורה ישנה', 99900)", [org, deal]);
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'שיפוץ מטבח', $2, $3) returning id", [org, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, kind, name) values ($1, $2, 1, 'group', 'עבודות')", [org, quote]);
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, description, unit_price_agorot, quantity, discount_bp) values ($1, $2, 2, 'עבודה', 'שני ימים', 50000, 2, 1000)", [
        org,
        quote,
      ]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, is_optional, optional_selected) values ($1, $2, 3, $3, 'ארון', 10000, true, true)",
        [org, quote, product],
      );
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, is_optional, optional_selected) values ($1, $2, 4, 'מדף', 7000, true, false)", [
        org,
        quote,
      ]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t;
      return { quote, deal, contact, token };
    });
  const accept = (token: string) =>
    asService(async (q) => {
      const fp = (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint;
      return (
        await one<{ a: { status: string } }>(
          q,
          `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה כהן',
                    p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
          [token, fp],
        )
      ).a;
    });
  const deal = (id: string) =>
    asAdmin((q) =>
      one<{ stage_id: string; status: string; closed_at: string | null; amount_agorot: string | null; amount_source: string | null }>(
        q,
        "select stage_id, status, closed_at, amount_agorot::text, amount_source from public.deals where id = $1",
        [id],
      ),
    );
  const dealLines = (id: string) =>
    asAdmin(async (q) =>
      (
        await q<{ description: string; quantity: string; unit_price_agorot: string; discount_bp: number | null; product_id: string | null; price_includes_vat: boolean; total_agorot: string }>(
          "select description, quantity::text, unit_price_agorot::text, discount_bp, product_id, price_includes_vat, total_agorot::text from public.deal_lines where deal_id = $1 order by position, id",
          [id],
        )
      ).rows,
    );
  const win = (quote: string, u: U = member, closedAt = "now()", amount: number | null = null, columns: unknown = null) =>
    asUser(u.id, async (q) =>
      (
        await one<{ r: { deal: string; lines: string } }>(
          q,
          `select public.quote_win_deal(p_org => $1, p_quote => $2, p_stage => $3, p_amount_agorot => $4, p_closed_at => ${closedAt},
                                        p_columns => $5::jsonb) as r`,
          [org, quote, wonStage, amount, columns === null ? null : JSON.stringify(columns)],
        )
      ).r,
    );
  const notice = (quote: string) =>
    asAdmin(async (q) => (await q<{ user_id: string; body: string | null }>("select user_id, body from public.notifications where entity_id = $1 and type = 'quote'", [quote])).rows);
  const stageEntries = (dealId: string) =>
    asAdmin(async (q) => (await q<{ to: string }>("select metadata->>'to_stage_id' as to from public.activities where deal_id = $1 and type = 'stage_change'", [dealId])).rows.map((r) => r.to));
  const quoteLinesNow = [
    { description: "עבודה – שני ימים", quantity: "2", unit_price_agorot: "50000", discount_bp: 1000, product_id: null, price_includes_vat: false, total_agorot: "90000" },
    { description: "ארון", quantity: "1", unit_price_agorot: "10000", discount_bp: null, price_includes_vat: false, total_agorot: "10000" },
  ];

  beforeAll(async () => {
    owner = await createUser("qad-owner");
    org = await createOrg(owner.id, "עסק הזכיות");
    admin = await addMember(org, owner.id, "admin", "qad-admin");
    member = await addMember(org, owner.id, "member", "qad-member");
    viewer = await addMember(org, owner.id, "viewer", "qad-viewer");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    lostStage = pipe.stages.find((s) => s.kind === "lost")!.id;
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, products: true, discounts: true, price_lists: true })]),
    );
    await setMode("ask");
    product = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat, billing) values ($1, 'ארון', 10000, 'taxable', false, 'one_time') returning id",
          [org],
        )
      ).id,
    );
  });

  it("the setting: 'ask' by default, owners and admins choose, three values only", async () => {
    const fresh = await createUser("qad-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש");
    await asUser(fresh.id, (q) => q("insert into public.org_document_settings (organization_id) values ($1)", [freshOrg]));
    expect(await asAdmin(async (q) => (await one<{ m: string }>(q, "select quote_accept_deal as m from public.org_document_settings where organization_id = $1", [freshOrg])).m)).toBe("ask");

    await asUser(admin.id, (q) => q("update public.org_document_settings set quote_accept_deal = 'none' where organization_id = $1", [org]));
    const n = await asUser(member.id, async (q) => (await q("update public.org_document_settings set quote_accept_deal = 'auto' where organization_id = $1 returning 1", [org])).rowCount);
    expect(n).toBe(0);
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_document_settings set quote_accept_deal = 'always' where organization_id = $1", [org])))).code).toBe("23514");
    // audited like the rest of the table
    expect(
      await asAdmin(async (q) =>
        (await one<{ c: number }>(q, "select count(*)::int as c from public.audit_log where organization_id = $1 and entity_type = 'org_document_settings' and changes ? 'quote_accept_deal'", [org])).c,
      ),
    ).toBeGreaterThan(0);
    await setMode("ask");
  });

  it("auto: the deal's lines become the quote's and the deal moves to won through the usual triggers", async () => {
    await setMode("auto");
    const a = await sentQuote();
    expect(await accept(a.token)).toEqual({ status: "accepted" });

    const d = await deal(a.deal!);
    expect(d).toMatchObject({ stage_id: wonStage, status: "won", amount_agorot: "100000", amount_source: "lines" });
    expect(d.closed_at).not.toBeNull();
    // the heading and the option the customer did not choose are left out; the rest priced as on the quote
    expect(await dealLines(a.deal!)).toMatchObject(quoteLinesNow);
    expect(await stageEntries(a.deal!)).toEqual([wonStage]);
    expect(await notice(a.quote)).toEqual([{ user_id: member.id, body: expect.stringMatching(/^הצעה .+ · העסקה עברה לזכייה והשורות עודכנו לפי ההצעה\.$/) }]);
  });

  it("auto: a deal lines rule that refuses keeps the old lines; the deal still moves and the notice says so", async () => {
    await setMode("auto");
    const a = await sentQuote();
    // the business moves to prices with VAT after the quote was priced without: an emptied deal takes the business's mode
    await setBusinessVat(true);
    try {
      expect(await accept(a.token)).toEqual({ status: "accepted" });
    } finally {
      await setBusinessVat(false);
    }
    expect(await deal(a.deal!)).toMatchObject({ stage_id: wonStage, status: "won" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(a.quote))[0].body).toMatch(/העסקה עברה לזכייה, אבל השורות לא עודכנו/);
  });

  it("auto: never a closed, binned or missing deal, and never for an addendum", async () => {
    await setMode("auto");
    const lost = await sentQuote();
    await asUser(member.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [lost.deal, lostStage]));
    const binned = await sentQuote();
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [binned.deal]));
    const contactOnly = await sentQuote({ noDeal: true });

    for (const x of [lost, contactOnly]) expect(await accept(x.token)).toEqual({ status: "accepted" });
    expect(await deal(lost.deal!)).toMatchObject({ stage_id: lostStage, status: "lost" });
    expect((await dealLines(lost.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(lost.quote))[0].body).toMatch(/^הצעה [^·]+$/);
    expect((await notice(contactOnly.quote))[0].body).toMatch(/^הצעה [^·]+$/);
    expect(await accept(binned.token)).toEqual({ status: "accepted" });
    expect(await deal(binned.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(binned.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(binned.quote))[0].body).toMatch(/^הצעה [^·]+$/);

    // an addendum adds to work already accepted: its lines never replace the deal's
    await setMode("ask");
    const original = await sentQuote();
    await accept(original.token);
    await setMode("auto");
    const addendum = await asUser(member.id, async (q) => {
      const id = (await one<{ a: string }>(q, "select public.quote_new_addendum($1, $2) as a", [org, original.quote])).a;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'מדף נוסף', 20000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return { id, token: (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, id])).t };
    });
    expect(await accept(addendum.token)).toEqual({ status: "accepted" });
    expect(await deal(original.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(original.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
  });

  it("auto: a failing move rolls the lines back and is said in the notice; the decision stands", async () => {
    await setMode("auto");
    const a = await sentQuote();
    await asAdmin(async (q) => {
      await q("create schema if not exists qa_test_tmp");
      await q(`create or replace function qa_test_tmp.refuse_move() returns trigger language plpgsql as $f$
               begin if new.stage_id is distinct from old.stage_id then raise exception 'refused for the test'; end if; return new; end $f$`);
      await q("create trigger zz_qa_refuse_move before update on public.deals for each row when (new.id = '" + a.deal + "') execute function qa_test_tmp.refuse_move()");
    });
    try {
      expect(await accept(a.token)).toEqual({ status: "accepted" });
    } finally {
      await asAdmin(async (q) => {
        await q("drop trigger zz_qa_refuse_move on public.deals");
        await q("drop schema qa_test_tmp cascade");
      });
    }
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [a.quote])).s)).toBe("accepted");
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(a.quote))[0].body).toMatch(/העסקה לא הועברה לזכייה והשורות לא עודכנו/);
  });

  it("auto, before 020480 is pasted: the deal still moves and the notice says the lines were not updated", async () => {
    await setMode("auto");
    const a = await sentQuote();
    await asAdmin((q) => q("alter function app.quote_deal_lines_replace(public.quotes, uuid) rename to quote_deal_lines_replace_qa_gone"));
    try {
      expect(await accept(a.token)).toEqual({ status: "accepted" });
    } finally {
      await asAdmin((q) => q("alter function app.quote_deal_lines_replace_qa_gone(public.quotes, uuid) rename to quote_deal_lines_replace"));
    }
    expect(await deal(a.deal!)).toMatchObject({ stage_id: wonStage, status: "won" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(a.quote))[0].body).toMatch(/העסקה עברה לזכייה, אבל השורות לא עודכנו/);
  });

  it("auto: a pipeline with no won stage moves nothing and says so", async () => {
    await setMode("auto");
    const a = await sentQuote();
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.stages set kind = 'open' where id = $1", [wonStage]);
    });
    try {
      expect(await accept(a.token)).toEqual({ status: "accepted" });
    } finally {
      await asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.stages set kind = 'won' where id = $1", [wonStage]);
      });
    }
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await notice(a.quote))[0].body).toMatch(/אין שלב זכייה/);
  });

  it("ask: the notice asks; the won window replaces the lines and wins the deal in one save", async () => {
    await setMode("ask");
    const a = await sentQuote();
    expect(await accept(a.token)).toEqual({ status: "accepted" });
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(a.quote))[0].body).toMatch(/^הצעה .+ · להעביר את העסקה לזכייה ולעדכן את השורות\?$/);

    // who may not edit the deal cannot
    expect((await pgError(win(a.quote, viewer))).code).toBe("42501");
    expect((await pgError(asUser(viewer.id, (q) => q("select public.quote_lines_to_deal($1, $2)", [org, a.quote])))).code).toBe("42501");
    // the won window's save: the lines and the move in one transaction; an empty amount follows the new lines
    expect(await win(a.quote)).toEqual({ deal: a.deal, lines: "updated" });
    expect(await deal(a.deal!)).toMatchObject({ stage_id: wonStage, status: "won", amount_agorot: "100000", amount_source: "lines" });
    expect(await dealLines(a.deal!)).toMatchObject(quoteLinesNow);
    expect(await stageEntries(a.deal!)).toEqual([wonStage]);
    // a closed deal is never touched again
    expect((await pgError(win(a.quote))).hint).toBe("quote_deal:closed");
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_lines_to_deal($1, $2)", [org, a.quote])))).hint).toBe("quote_deal:closed");
  });

  it("ask: a save the deal refuses changes nothing, the old lines included (one transaction)", async () => {
    await setMode("ask");
    const a = await sentQuote();
    await accept(a.token);
    // a close date more than a day ahead is refused for a person's write (DEAL-04)
    expect((await pgError(win(a.quote, member, "now() + interval '3 days'"))).hint).toBe("deal:closed_at");
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    // a typed amount is kept, as in any won window
    expect(await win(a.quote, member, "now()", 123400)).toEqual({ deal: a.deal, lines: "updated" });
    expect(await deal(a.deal!)).toMatchObject({ status: "won", amount_agorot: "123400" });
  });

  it("ask: the window's required close date and contact (DEAL-05) are saved in the same update; nothing else may be sent", async () => {
    await setMode("ask");
    const a = await sentQuote();
    await accept(a.token);
    const other = await asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, member.id])).id,
    );
    // refused before anything: another column, or not an object
    for (const bad of [
      { amount_agorot: 5 },
      { owner_id: viewer.id },
      { expected_close_date: "2030-01-01", stage_id: openStage },
      ["contact_id"],
      // the close date is a real calendar day written YYYY-MM-DD, nothing else
      { expected_close_date: null },
      { expected_close_date: "today" },
      { expected_close_date: "infinity" },
      { expected_close_date: "2026-02-30" },
      { expected_close_date: "2026-1-5" },
      { expected_close_date: "2026-01-05 10:00" },
      { expected_close_date: 20260105 },
    ]) {
      const e = await pgError(win(a.quote, member, "now()", null, bad));
      expect(e, JSON.stringify(bad)).toMatchObject({ code: "22023", hint: "quote_win:columns" });
    }
    // a contact the foreign key refuses rolls the lines back with the move
    expect((await pgError(win(a.quote, member, "now()", null, { contact_id: "00000000-0000-4000-8000-000000000000" }))).code).toBe("23503");
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);

    expect(await win(a.quote, member, "now()", null, { expected_close_date: "2026-11-30", contact_id: other })).toEqual({ deal: a.deal, lines: "updated" });
    const row = await asAdmin((q) =>
      one<{ status: string; expected_close_date: string; contact_id: string }>(q, "select status, expected_close_date::text, contact_id from public.deals where id = $1", [a.deal]),
    );
    expect(row).toEqual({ status: "won", expected_close_date: "2026-11-30", contact_id: other });
    expect(await dealLines(a.deal!)).toMatchObject(quoteLinesNow);
  });

  it("ask: without columns the deal's close date and contact stay as they were", async () => {
    await setMode("ask");
    const a = await sentQuote();
    await accept(a.token);
    await asUser(member.id, (q) => q("update public.deals set expected_close_date = '2026-12-15' where id = $1", [a.deal]));
    expect(await win(a.quote)).toEqual({ deal: a.deal, lines: "updated" });
    const row = await asAdmin((q) =>
      one<{ expected_close_date: string; contact_id: string }>(q, "select expected_close_date::text, contact_id from public.deals where id = $1", [a.deal]),
    );
    expect(row).toEqual({ expected_close_date: "2026-12-15", contact_id: a.contact });
  });

  it("ask: a deal lines rule that refuses keeps the old lines; the deal is still won and the answer names the rule", async () => {
    await setMode("ask");
    const a = await sentQuote();
    await accept(a.token);
    await setBusinessVat(true);
    try {
      expect(await win(a.quote)).toEqual({ deal: a.deal, lines: "deal_lines:vat_mode" });
    } finally {
      await setBusinessVat(false);
    }
    expect(await deal(a.deal!)).toMatchObject({ stage_id: wonStage, status: "won" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
  });

  it("ask: refused for a quote that is not accepted, for a contact quote and an addendum; a person's product rules apply", async () => {
    await setMode("ask");
    const sent = await sentQuote();
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_lines_to_deal($1, $2)", [org, sent.quote])))).hint).toBe("quote_deal:not_accepted");
    const contactOnly = await sentQuote({ noDeal: true });
    await accept(contactOnly.token);
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_lines_to_deal($1, $2)", [org, contactOnly.quote])))).hint).toBe("quote_deal:no_deal");

    // the product was archived after the quote: a person cannot put it on a deal; the old lines stay
    const a = await sentQuote();
    await accept(a.token);
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [product]));
    try {
      expect((await pgError(asUser(member.id, (q) => q("select public.quote_lines_to_deal($1, $2)", [org, a.quote])))).hint).toBe("deal_lines:product");
      expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    } finally {
      await asUser(owner.id, (q) => q("update public.products set archived_at = null where id = $1", [product]));
    }
  });

  it("none: nothing happens to the deal", async () => {
    await setMode("none");
    const a = await sentQuote();
    expect(await accept(a.token)).toEqual({ status: "accepted" });
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    expect((await notice(a.quote))[0].body).toMatch(/^הצעה [^·]+$/);
    await setMode("ask");
  });

  it("a declined quote never touches the deal, whatever the setting", async () => {
    await setMode("auto");
    const a = await sentQuote();
    const answer = await asService(async (q) => {
      const fp = (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [a.token])).v.fingerprint;
      return (await one<{ a: { status: string } }>(q, "select public.quote_public_decide(p_token => $1, p_decision => 'rejected', p_fingerprint => $2) as a", [a.token, fp])).a;
    });
    expect(answer).toEqual({ status: "rejected" });
    expect(await deal(a.deal!)).toMatchObject({ stage_id: openStage, status: "open" });
    expect((await dealLines(a.deal!)).map((l) => l.description)).toEqual(["שורה ישנה"]);
    await setMode("ask");
  });

  it("the deal step is the server's own; the person's entry point is for signed-in people only", async () => {
    for (const fn of ["app.quote_accept_deal(public.quotes)", "app.quote_deal_lines_replace(public.quotes, uuid)"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn])).c), `${fn} ${role}`).toBe(false);
      }
    }
    for (const [role, allowed] of [
      ["anon", false],
      ["authenticated", true],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_lines_to_deal(uuid, uuid)', 'execute') as c", [role])).c)).toBe(allowed);
      expect(
        await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, 'public.quote_win_deal(uuid, uuid, uuid, bigint, timestamptz, jsonb, jsonb)', 'execute') as c", [role])).c),
      ).toBe(allowed);
    }
  });
});
