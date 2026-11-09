import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PKG-06 (owner's answers of 9 November 2026, (149) א, (150) ג, (151) ג): a punch card line of a quote or an order names
 * its service recipient; the document and the money stay on the payer, the card opens on the recipient. A recipient is the
 * payer's CON-06 relation or an employee of the paying company; it is frozen with the document and copied by a version, a
 * duplicate and an order from a quote. The customer's card messages go to the recipient and the payer, or the payer only.
 */
describe("payer and service recipient (PKG-06)", () => {
  let owner: U, member: U, stranger: U;
  let org: string, otherOrg: string;
  let product: string, service: string, typeId: string, relationType: string;
  let zone: string;
  const FEATURES = { products: true, payments: true, punch_cards: true, orders: true, quotes: true, documents: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (name: string, fields: { company?: string | null; phone?: string | null; email?: string | null } = {}) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.contacts (organization_id, first_name, owner_id, company_id, phone, email) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, name, owner.id, fields.company ?? null, fields.phone ?? null, fields.email ?? null],
        )
      ).id,
    );
  const relate = (a: string, b: string) =>
    run(owner, (q) => q("insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [org, a, b, relationType]));
  const quote = (payer: string | null, company: string | null = null) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id, company_id) values ($1, 'הצעה', $2, $3) returning id", [org, payer, company])).id,
    );
  const order = (payer: string | null, company: string | null = null) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id, company_id) values ($1, $2, $3) returning id", [org, payer, company])).id);
  const line = (kind: "quote" | "order", doc: string, recipient: string | null, opts: { product?: string; position?: number; quantity?: number } = {}) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.${kind}_lines (organization_id, ${kind}_id, name, product_id, unit_price_agorot, quantity, position, recipient_contact_id)
           values ($1, $2, 'כרטיסייה', $3, 40000, $4, $5, $6) returning id`,
          [org, doc, opts.product ?? product, opts.quantity ?? 1, opts.position ?? 0, recipient],
        )
      ).id,
    );
  const recipientOf = (kind: "quote" | "order", lineId: string) =>
    asAdmin(async (q) => (await one<{ r: string | null }>(q, `select recipient_contact_id as r from public.${kind}_lines where id = $1`, [lineId])).r);
  const setRecipient = (u: U, kind: "quote" | "order", lineId: string, recipient: string | null) =>
    run(u, (q) => q(`update public.${kind}_lines set recipient_contact_id = $2 where id = $1`, [lineId, recipient]));

  beforeAll(async () => {
    owner = await createUser("pr-owner");
    org = await createOrg(owner.id, "סטודיו המקבלים");
    member = await addMember(org, owner.id, "member", "pr-member");
    stranger = await createUser("pr-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    zone = await asAdmin(async (q) =>
      (
        await one<{ z: string }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).z,
    );
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    typeId = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id = $1 order by position, created_at, id limit 1", [org])).id);
    relationType = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.contact_relation_types where organization_id = $1 and key = 'parent'", [org])).id);
    product = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
           values ($1, 'כרטיסיית חוג', 'punch_card', 40000, 10, 3, 'months', $2) returning id`,
          [org, [typeId]],
        )
      ).id,
    );
    service = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, kind, price_agorot) values ($1, 'שיעור', 'service', 10000) returning id", [org])).id,
    );
  });

  it("(150) a recipient is the payer's relation (either way) or an employee of the paying company; anyone else is refused", async () => {
    const parent = await contact("הורה");
    const child = await contact("ילד");
    const child2 = await contact("ילדה");
    const stranger1 = await contact("זר");
    await relate(parent, child);
    // the relation written the other way counts too
    await relate(child2, parent);
    const q1 = await quote(parent);
    const l1 = await line("quote", q1, child);
    expect(await recipientOf("quote", l1)).toBe(child);
    await setRecipient(owner, "quote", l1, child2);
    expect(await recipientOf("quote", l1)).toBe(child2);
    // the payer itself is fine (= no separate recipient)
    await setRecipient(owner, "quote", l1, parent);
    expect(await pgError(setRecipient(owner, "quote", l1, stranger1))).toMatchObject({ hint: "punch_recipient:not_linked" });
    // a contact of another business is not available
    const foreign = await asUser(stranger.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'שלהם', $2) returning id", [otherOrg, stranger.id])).id,
    );
    expect(await pgError(setRecipient(owner, "quote", l1, foreign))).toMatchObject({ hint: "punch_recipient:contact" });
    // only a punch card line has one
    expect(await pgError(line("quote", q1, child, { product: service, position: 1 }))).toMatchObject({ hint: "punch_recipient:line" });
    // a company pays: its employees (primary company or a CON-05 link) may receive
    const company = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה משלמת') returning id", [org])).id);
    const worker = await contact("עובד", { company });
    const linked = await contact("עובד בקישור");
    await run(owner, (q) => q("insert into public.contact_companies (organization_id, contact_id, company_id) values ($1, $2, $3)", [org, linked, company]));
    const o1 = await order(null, company);
    const ol = await line("order", o1, worker);
    await setRecipient(owner, "order", ol, linked);
    expect(await pgError(setRecipient(owner, "order", ol, child))).toMatchObject({ hint: "punch_recipient:not_linked" });
    // the options the line offers: the payer first, its relations, nobody else; a stranger is refused
    const options = await run(owner, async (q) => (await q<{ contact_id: string; how: string }>("select contact_id, how from public.punch_card_recipient_options($1, 'quote', $2)", [org, q1])).rows);
    expect(options[0]).toEqual({ contact_id: parent, how: "payer" });
    expect(options.map((o) => o.contact_id).sort()).toEqual([parent, child, child2].sort());
    const companyOptions = await run(owner, async (q) => (await q<{ contact_id: string; how: string }>("select contact_id, how from public.punch_card_recipient_options($1, 'order', $2)", [org, o1])).rows);
    expect(companyOptions.map((o) => o.contact_id).sort()).toEqual([worker, linked].sort());
    expect(companyOptions.every((o) => o.how === "employee")).toBe(true);
    expect((await pgError(run(stranger, (q) => q("select * from public.punch_card_recipient_options($1, 'quote', $2)", [org, q1])))).code).toBe("42501");
    // a draft whose customer changes keeps only recipients linked to the new payer
    await setRecipient(owner, "quote", l1, child);
    await run(owner, (q) => q("update public.quotes set contact_id = $2 where id = $1", [q1, stranger1]));
    expect(await recipientOf("quote", l1)).toBeNull();
  });

  it("frozen once the document leaves draft; copied by a version, a duplicate and an order from the quote", async () => {
    const parent = await contact("אמא");
    const child = await contact("בן");
    await relate(parent, child);
    const q1 = await quote(parent);
    const l1 = await line("quote", q1, child);
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, q1]));
    // a person's update of a sent quote's line is filtered by RLS; every other writer is refused
    await setRecipient(owner, "quote", l1, null);
    expect(await recipientOf("quote", l1)).toBe(child);
    expect(await pgError(asAdmin((q) => q("update public.quote_lines set recipient_contact_id = null where id = $1", [l1])))).toMatchObject({ hint: "quote:frozen" });
    // a version keeps it
    const version = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, q1])).id);
    expect(await asAdmin(async (q) => (await one<{ r: string | null }>(q, "select recipient_contact_id as r from public.quote_lines where quote_id = $1", [version])).r)).toBe(child);
    // a duplicate keeps it
    const dup = await run(owner, async (q) => (await one<{ r: { quote: string } }>(q, "select public.quote_duplicate($1, $2) as r", [org, q1])).r.quote);
    expect(await asAdmin(async (q) => (await one<{ r: string | null }>(q, "select recipient_contact_id as r from public.quote_lines where quote_id = $1", [dup])).r)).toBe(child);
    // an order made from the accepted quote keeps it, and the numbered order's line is frozen too
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [q1]));
    const orderId = await run(owner, async (q) => (await one<{ r: string }>(q, "select public.order_from_quote($1, $2) as r", [org, q1])).r);
    const ol = await asAdmin(async (q) => (await one<{ id: string; r: string | null }>(q, "select id, recipient_contact_id as r from public.order_lines where order_id = $1", [orderId])));
    expect(ol.r).toBe(child);
    await setRecipient(owner, "order", ol.id, parent);
    expect(await recipientOf("order", ol.id)).toBe(child);
    expect(await pgError(asAdmin((q) => q("update public.order_lines set recipient_contact_id = $2 where id = $1", [ol.id, parent])))).toMatchObject({ hint: "order:frozen" });
  });

  it("(149) the cards open on each line's recipient, the payer kept on the card; the entry is on each holder", async () => {
    const parent = await contact("אבא משלם");
    const kidA = await contact("ילד א");
    const kidB = await contact("ילד ב");
    await relate(parent, kidA);
    await relate(parent, kidB);
    const o1 = await order(parent);
    await line("order", o1, kidA, { position: 0 });
    await line("order", o1, kidB, { position: 1 });
    await line("order", o1, null, { position: 2 });
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1]));
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 200000, current_date, 'cash')", [org, parent, o1]),
    );
    const cards = await asAdmin(async (q) =>
      (await q<{ contact_id: string; payer_contact_id: string | null }>("select contact_id, payer_contact_id from public.punch_cards where order_line_id in (select id from public.order_lines where order_id = $1) order by contact_id", [o1])).rows,
    );
    expect(cards).toEqual(
      expect.arrayContaining([
        { contact_id: kidA, payer_contact_id: parent },
        { contact_id: kidB, payer_contact_id: parent },
        { contact_id: parent, payer_contact_id: null },
      ]),
    );
    expect(cards.length).toBe(3);
    const entries = (c: string) => asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'punch_card_opened'", [c]));
    expect(await entries(kidA)).toBe(1);
    expect(await entries(kidB)).toBe(1);
    expect(await entries(parent)).toBe(1);
    // the document and the money stay on the payer
    expect(await asAdmin(async (q) => (await one<{ c: string }>(q, "select contact_id as c from public.orders where id = $1", [o1])).c)).toBe(parent);
    // a recipient on a line, or a card paid, is real work (sample data, import undo)
    const worked = (c: string) =>
      asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now(), null) as w", [org, c])).w);
    const lonely = await contact("רק מקבל");
    await relate(parent, lonely);
    expect(await worked(lonely)).toBe(false);
    const q2 = await quote(parent);
    await line("quote", q2, lonely);
    expect(await worked(lonely)).toBe(true);
    expect(await asAdmin(async (q) => (await one<{ u: boolean }>(q, "select app.sample_untouched($1, 'contact', $2, app.sample_row($1, 'contact', $2)) as u", [org, lonely])).u)).toBe(false);
  });

  describe("(151) the customer's messages", () => {
    const runAlerts = () => asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[org]]));
    const jobsFor = (c: string) => asAdmin((q) => count(q, "select 1 from app.jobs where organization_id = $1 and payload ->> 'contact_id' = $2", [org, c]));
    const setMessages = (to: "both" | "payer") =>
      run(owner, async (q) => {
        const updated = await q("update public.punch_card_alert_settings set customer_messages = true, notices_to = $2 where organization_id = $1", [org, to]);
        if (updated.rowCount === 0) await q("insert into public.punch_card_alert_settings (organization_id, customer_messages, notices_to) values ($1, true, $2)", [org, to]);
      });
    // a card of the holder, paid by the payer, whose last day is near (5 days, activated 30 days ago)
    const nearCard = async (holder: string, payer: string) => {
      const id = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, holder, product])).id);
      await asAdmin((q) =>
        q("update public.punch_cards set payer_contact_id = $2, activated_at = now() - interval '30 days', expires_on = (now() at time zone $3)::date + 5 where id = $1", [id, payer, zone]),
      );
      return id;
    };

    beforeAll(async () => {
      // the job's first look at the business seeds its templates and baselines what exists
      await runAlerts();
    });

    it("by default to the recipient and to the payer", async () => {
      await setMessages("both");
      const payer = await contact("משלמת", { phone: "0501111111" });
      const holder = await contact("משתתפת", { phone: "0502222222" });
      await nearCard(holder, payer);
      await runAlerts();
      expect(await jobsFor(holder)).toBe(1);
      expect(await jobsFor(payer)).toBe(1);
    });

    it("the business's choice 'payer only'", async () => {
      await setMessages("payer");
      const payer = await contact("משלם בלבד", { phone: "0503333333" });
      const holder = await contact("ילד בלי הודעות", { phone: "0504444444" });
      await nearCard(holder, payer);
      await runAlerts();
      expect(await jobsFor(holder)).toBe(0);
      expect(await jobsFor(payer)).toBe(1);
    });

    it("a recipient with no channel: the payer only; no payer: the holder as before", async () => {
      await setMessages("both");
      const payer = await contact("משלם 2", { phone: "0505555555" });
      const holder = await contact("ילד בלי טלפון");
      await nearCard(holder, payer);
      const alone = await contact("לבד", { phone: "0506666666" });
      const own = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, alone, product])).id);
      await asAdmin((q) => q("update public.punch_cards set activated_at = now() - interval '30 days', expires_on = (now() at time zone $2)::date + 5 where id = $1", [own, zone]));
      await runAlerts();
      expect(await jobsFor(holder)).toBe(0);
      expect(await jobsFor(payer)).toBe(1);
      expect(await jobsFor(alone)).toBe(1);
    });

    it("'payer only' on a card a company paid for, with no payer contact: no message at all (review finding 3)", async () => {
      await setMessages("payer");
      const company = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה ששילמה') returning id", [org])).id);
      const holder = await contact("עובדת", { phone: "0507777777", company });
      const id = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, holder, product])).id);
      await asAdmin((q) =>
        q("update public.punch_cards set payer_company_id = $2, activated_at = now() - interval '30 days', expires_on = (now() at time zone $3)::date + 5 where id = $1", [id, company, zone]),
      );
      await runAlerts();
      expect(await jobsFor(holder)).toBe(0);
      await setMessages("both");
    });
  });

  it("(review finding 1) the link is judged again when the quote is sent and the order numbered; a sent draft's options are refused", async () => {
    const parent = await contact("הורה בודק");
    const child = await contact("ילד בודק");
    await relate(parent, child);
    const q1 = await quote(parent);
    await line("quote", q1, child);
    const o1 = await order(parent);
    await line("order", o1, child);
    // the relation is removed after the lines were saved
    await run(owner, (q) => q("delete from public.contact_relations where organization_id = $1 and contact_id = $2 and related_contact_id = $3", [org, parent, child]));
    expect(await pgError(run(owner, (q) => q("select public.quote_send($1, $2)", [org, q1])))).toMatchObject({ hint: "punch_recipient:not_linked" });
    expect(await pgError(run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1])))).toMatchObject({ hint: "punch_recipient:not_linked" });
    // linked again: both go
    await relate(child, parent);
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, q1]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1]));
    // the options are for a draft only
    expect((await pgError(run(owner, (q) => q("select * from public.punch_card_recipient_options($1, 'quote', $2)", [org, q1])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("select * from public.punch_card_recipient_options($1, 'order', $2)", [org, o1])))).code).toBe("42501");
  });

  it("(review finding 2) a recipient in the bin waits: no card on the payer, and the retry opens it on the recipient after a restore", async () => {
    const parent = await contact("משלם ממתין");
    const kid = await contact("ילד בסל");
    await relate(parent, kid);
    const o1 = await order(parent);
    await line("order", o1, kid);
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1]));
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [kid]));
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 100000, current_date, 'cash')", [org, parent, o1]),
    );
    const cards = () => asAdmin((q) => count(q, "select 1 from public.punch_cards where order_line_id in (select id from public.order_lines where order_id = $1)", [o1]));
    expect(await cards()).toBe(0);
    const waiting = () => asAdmin((q) => count(q, "select 1 from app.punch_card_retries where organization_id = $1 and order_id = $2 and done_at is null and given_up_at is null", [org, o1]));
    expect(await waiting()).toBe(1);
    const due = () => asAdmin((q) => q("update app.punch_card_retries set next_try_at = now() - interval '1 second' where organization_id = $1 and order_id = $2", [org, o1]));
    const retry = () => asAdmin((q) => q("select app.retry_punch_card_openings(50, 500)"));
    // still in the bin: the row keeps waiting, nothing opens
    await due();
    await retry();
    expect(await cards()).toBe(0);
    expect(await waiting()).toBe(1);
    // restored: the retry opens the card on the recipient, the payer kept on it
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [kid]));
    await due();
    await retry();
    expect(await waiting()).toBe(0);
    expect(
      await asAdmin(async (q) =>
        (await q<{ contact_id: string; payer_contact_id: string }>("select contact_id, payer_contact_id from public.punch_cards where order_line_id in (select id from public.order_lines where order_id = $1)", [o1])).rows,
      ),
    ).toEqual([{ contact_id: kid, payer_contact_id: parent }]);
  });

  it("(re-review MEDIUM) a retry opens the payer's card while the recipient line keeps waiting, and the recipient's after a restore", async () => {
    const parent = await contact("משלם בניסיון חוזר");
    const kid = await contact("ילדה בסל");
    await relate(parent, kid);
    const o1 = await order(parent);
    await line("order", o1, null, { position: 0 });
    await line("order", o1, kid, { position: 1 });
    // LOW 1: a recipient in the bin refuses the numbering as the contact's problem, not the link's
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [kid]));
    expect(await pgError(run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1])))).toMatchObject({ hint: "punch_recipient:contact" });
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [kid]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1]));
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [kid]));
    // the first opening did not run (the plan key off at payment time stands in for a failed first try, e.g. 55P03): a
    // retry row waits for the payment
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
    const payment = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 200000, current_date, 'cash') returning id",
          [org, parent, o1],
        )
      ).id,
    );
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) =>
      q("insert into app.punch_card_retries (organization_id, kind, payment_id, order_id, source, last_sqlstate, next_try_at) values ($1, 'open', $2, $3, 'link', '55P03', now() - interval '1 second')", [
        org,
        payment,
        o1,
      ]),
    );
    const holders = () =>
      asAdmin(async (q) =>
        (await q<{ contact_id: string }>("select contact_id from public.punch_cards where order_line_id in (select id from public.order_lines where order_id = $1) order by created_at, id", [o1])).rows.map(
          (r) => r.contact_id,
        ),
      );
    const row = () =>
      asAdmin(async (q) =>
        one<{ attempts: number; done: boolean; given_up: boolean; sqlstate: string | null; due_in_minutes: number }>(
          q,
          `select attempts, done_at is not null as done, given_up_at is not null as given_up, last_sqlstate as sqlstate,
                  round(extract(epoch from next_try_at - now()) / 60)::integer as due_in_minutes
             from app.punch_card_retries where organization_id = $1 and order_id = $2`,
          [org, o1],
        ),
      );
    const retry = () => asAdmin((q) => q("select app.retry_punch_card_openings(50, 500)"));
    await retry();
    // the payer's own card opened and stays; the row keeps waiting for the recipient, with the usual backoff
    expect(await holders()).toEqual([parent]);
    expect(await row()).toEqual({ attempts: 1, done: false, given_up: false, sqlstate: "55000", due_in_minutes: 15 });
    expect(await asAdmin((q) => count(q, "select 1 from app.punch_card_retries where organization_id = $1 and payment_id = $2", [org, payment]))).toBe(1);
    // restored: the next try opens the recipient's card and ends the row
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [kid]));
    await asAdmin((q) => q("update app.punch_card_retries set next_try_at = now() - interval '1 second' where organization_id = $1 and order_id = $2", [org, o1]));
    await retry();
    expect((await holders()).sort()).toEqual([parent, kid].sort());
    expect(await row()).toMatchObject({ attempts: 2, done: true, given_up: false, sqlstate: null });
    // third review: the row counts every card its tries opened (the payer's on the first, the recipient's on the second),
    // and its end is no "ended without a card"
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select opened as n from app.punch_card_retries where organization_id = $1 and order_id = $2", [org, o1])).n)).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'הניסיון החוזר לפתוח כרטיסייה הסתיים' and entity_id = $2", [org, parent]))).toBe(0);
  });

  it("(third review) a waiting try's cards count: a last try that opens nothing sends no 'ended without a card'", async () => {
    const parent = await contact("משלם ספירה");
    const kid = await contact("ילד ספירה");
    await relate(parent, kid);
    const o1 = await order(parent);
    await line("order", o1, null, { position: 0 });
    const kidLine = await line("order", o1, kid, { position: 1 });
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1]));
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [kid]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
    const payment = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 200000, current_date, 'cash') returning id",
          [org, parent, o1],
        )
      ).id,
    );
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) =>
      q("insert into app.punch_card_retries (organization_id, kind, payment_id, order_id, source, last_sqlstate, next_try_at) values ($1, 'open', $2, $3, 'link', '55P03', now() - interval '1 second')", [
        org,
        payment,
        o1,
      ]),
    );
    const retry = () => asAdmin((q) => q("select app.retry_punch_card_openings(50, 500)"));
    await retry();
    // the recipient's line is opened meanwhile by hand (on the restored recipient), so the last try opens nothing
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [kid]));
    await asAdmin((q) =>
      q(
        `insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, status, payment_id, activated_at, price_agorot, order_line_id, unit_no)
         select organization_id, $2, product_id, 'כרטיסייה', 10, 'active', $3, now(), 0, id, 1 from public.order_lines where id = $1`,
        [kidLine, kid, payment],
      ),
    );
    await asAdmin((q) => q("update app.punch_card_retries set next_try_at = now() - interval '1 second' where organization_id = $1 and order_id = $2", [org, o1]));
    await retry();
    const end = await asAdmin(async (q) =>
      one<{ done: boolean; opened: number; sqlstate: string | null }>(
        q,
        "select done_at is not null as done, opened, last_sqlstate as sqlstate from app.punch_card_retries where organization_id = $1 and order_id = $2",
        [org, o1],
      ),
    );
    expect(end).toEqual({ done: true, opened: 1, sqlstate: null });
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'הניסיון החוזר לפתוח כרטיסייה הסתיים' and entity_id = $2", [org, parent]))).toBe(0);
  });

  it("(review finding 6) a company merge moves the cards the duplicate company paid for; a paying company is real work", async () => {
    const keep = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה נשמרת') returning id", [org])).id);
    const dup = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה כפולה') returning id", [org])).id);
    const holder = await contact("עובד ממוזג");
    const id = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, holder, product])).id);
    await asAdmin((q) => q("update public.punch_cards set payer_company_id = $2 where id = $1", [id, dup]));
    expect(await asAdmin(async (q) => (await one<{ u: boolean }>(q, "select app.sample_untouched($1, 'company', $2, app.sample_row($1, 'company', $2)) as u", [org, dup])).u)).toBe(false);
    await run(owner, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await asAdmin(async (q) => (await one<{ p: string | null }>(q, "select payer_company_id as p from public.punch_cards where id = $1", [id])).p)).toBe(keep);
  });

  it("a merge moves the duplicate's recipient lines and paid cards; a purge empties them, and the erasure takes the id from the log", async () => {
    const parent = await contact("סבתא");
    const keep = await contact("נכד");
    const dup = await contact("נכד כפול");
    await relate(parent, dup);
    const q1 = await quote(parent);
    const l1 = await line("quote", q1, dup);
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, q1]));
    const paid = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, parent, product])).id);
    await asAdmin((q) => q("update public.punch_cards set payer_contact_id = $2 where id = $1", [paid, dup]));
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await recipientOf("quote", l1)).toBe(keep);
    expect(await asAdmin(async (q) => (await one<{ p: string | null }>(q, "select payer_contact_id as p from public.punch_cards where id = $1", [paid])).p)).toBe(keep);
    // an order numbered with a recipient: purging the recipient (as a person) empties the line, the order stays as numbered
    const kid = await contact("נכדה");
    await relate(parent, kid);
    const o1 = await order(parent);
    const ol = await line("order", o1, kid);
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, o1]));
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [kid]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [kid]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1", [kid]))).toBe(0);
    expect(await recipientOf("order", ol)).toBeNull();
    // the erasure: the kept grandchild's id leaves the line's log (purge, then erase)
    await asAdmin((q) => q("delete from public.contacts where id = $1", [keep]));
    expect(await recipientOf("quote", l1)).toBeNull();
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, keep]));
    const left = JSON.stringify(
      await asAdmin(async (q) => (await q("select changes from public.audit_log where organization_id = $1 and entity_type in ('quote_lines', 'order_lines', 'punch_cards')", [org])).rows),
    );
    expect(left).not.toContain(keep);
    // a member who may not edit the draft is refused by RLS, never told about the rule
    const q2 = await quote(parent);
    const l2 = await line("quote", q2, null);
    await setRecipient(member, "quote", l2, parent);
    expect(await recipientOf("quote", l2)).toBeNull();
  });
});
