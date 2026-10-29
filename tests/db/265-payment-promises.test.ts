import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reminderHeld } from "../../src/features/collection/promise";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * COL-03: a payment promise on an open debt document (one per document): the promised date and a collection note. Written by
 * BAL-01's recorders in a writable business with the `collection` key; the date from today up to 366 days ahead; the
 * document fixed. The rule COL-04 reads: reminders are held up to and including the promised date.
 */
describe("payment promises (COL-03)", () => {
  let owner: U, member: U, manager: U;
  let org: string;
  let contact: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, collection: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  // calendar days of the business (Asia/Jerusalem), as the SQL counts them; a UTC date is a day behind
  // between midnight in Israel and midnight UTC
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
  const doc = (type = "tax_invoice", amount = 1000) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, contact, type, `PP-${++n}`, day(-40), amount],
        )
      ).id,
    );
  const promise = (u: U, document: string, date: string, note: string | null = null) =>
    run(u, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, document_id, promised_date, note) values ($1, $2, $3, $4) returning id", [org, document, date, note])).id,
    );

  beforeAll(async () => {
    owner = await createUser("pp-owner");
    org = await createOrg(owner.id, "עסק ההבטחות");
    member = await addMember(org, owner.id, "member", "pp-member");
    manager = await addMember(org, owner.id, "manager", "pp-manager");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    contact = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'מבטיח') returning id", [org])).id);
  });

  it("goes on an active debt document only, once, with a date from today up to a year ahead", async () => {
    const receipt = await doc("receipt");
    expect(await pgError(promise(owner, receipt, day(3)))).toMatchObject({ hint: "payment_promise:document" });
    const invoice = await doc();
    expect(await pgError(promise(owner, invoice, day(-1)))).toMatchObject({ hint: "payment_promise:date" });
    expect(await pgError(promise(owner, invoice, day(367)))).toMatchObject({ hint: "payment_promise:date" });
    const id = await promise(owner, invoice, day(0), "  יעביר העברה בנקאית  ");
    const row = await run(owner, (q) => one<{ note: string; created_by: string; updated_by: string }>(q, "select note, created_by, updated_by from public.payment_promises where id = $1", [id]));
    expect(row).toEqual({ note: "יעביר העברה בנקאית", created_by: owner.id, updated_by: owner.id });
    // one per document
    expect(await pgError(promise(owner, invoice, day(5)))).toMatchObject({ code: "23505" });
    // a cancelled document takes none
    const cancelled = await doc();
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    expect(await pgError(promise(owner, cancelled, day(3)))).toMatchObject({ hint: "payment_promise:document" });
    // a positive opening balance takes one; a credit does not
    const debt = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, null, 500, $3) as id", [org, contact, day(-10)])).id);
    await promise(owner, debt, day(10));
  });

  it("an empty note is no note; the document never moves; an unchanged past date may stay", async () => {
    const invoice = await doc();
    const id = await promise(owner, invoice, day(2), "   ");
    expect(await run(owner, async (q) => (await one<{ note: string | null }>(q, "select note from public.payment_promises where id = $1", [id])).note)).toBeNull();
    const other = await doc();
    expect(await pgError(asAdmin((q) => q("update public.payment_promises set document_id = $2 where id = $1", [id, other])))).toMatchObject({ hint: "payment_promise:fixed" });
    // the date passed (moved by the server): changing only the note is fine, a new past date is not
    await asAdmin((q) => q("update public.payment_promises set promised_date = (now() at time zone 'Asia/Jerusalem')::date - 3 where id = $1", [id]));
    await run(owner, (q) => q("update public.payment_promises set note = 'לא ענה' where id = $1", [id]));
    expect(await pgError(run(owner, (q) => q("update public.payment_promises set promised_date = $2 where id = $1", [id, day(-2)])))).toMatchObject({ hint: "payment_promise:date" });
  });

  it("is audited, every change", async () => {
    const invoice = await doc();
    const id = await promise(owner, invoice, day(4), "ראשונה");
    await run(owner, (q) => q("update public.payment_promises set promised_date = $2, note = 'שנייה' where id = $1", [id, day(6)]));
    await run(owner, (q) => q("delete from public.payment_promises where id = $1", [id]));
    const actions = await asAdmin(
      async (q) => (await q<{ action: string }>("select action from public.audit_log where entity_type = 'payment_promises' and entity_id = $1 order by id", [id])).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["insert", "update", "delete"]);
  });

  it("writers: recorders of payments in a business with the collection key", async () => {
    const invoice = await doc();
    expect((await pgError(promise(member, invoice, day(2)))).code).toBe("42501");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, collection: false })]));
    try {
      expect((await pgError(promise(owner, invoice, day(2)))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(promise(owner, invoice, day(2)))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a document the writer cannot read is refused by RLS alone, active or cancelled alike", async () => {
    const active = await doc();
    const cancelled = await doc();
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // the manager manages no team, so the owner's contact and its documents are hidden
      for (const d of [active, cancelled]) {
        const e = await pgError(promise(manager, d, day(2)));
        expect(e.code, d).toBe("42501");
        expect(e.hint ?? null, d).toBeNull();
      }
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // readable again: the cancelled one is now judged by the rule
    expect(await pgError(promise(manager, cancelled, day(2)))).toMatchObject({ hint: "payment_promise:document" });
  });

  it("a promise may be removed without the collection key (a note after a downgrade), not recorded or changed", async () => {
    const invoice = await doc();
    const id = await promise(owner, invoice, day(5), "הערה");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, collection: false })]));
    try {
      expect(await run(owner, async (q) => (await q("update public.payment_promises set note = 'x' where id = $1", [id])).rowCount)).toBe(0);
      expect(await run(owner, async (q) => (await q("delete from public.payment_promises where id = $1", [id])).rowCount)).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
  });

  it("the rule COL-04 reads: held up to and including the promised date, the same in SQL and TS", async () => {
    const cases: Array<[string | null, string]> = [
      ["2026-11-10", "2026-11-09"],
      ["2026-11-10", "2026-11-10"],
      ["2026-11-10", "2026-11-11"],
      [null, "2026-11-10"],
    ];
    for (const [promised, onDay] of cases) {
      const sql = await asAdmin(async (q) => (await one<{ h: boolean }>(q, "select app.collection_reminder_held($1::date, $2::date) as h", [promised, onDay])).h);
      expect(sql, `${promised} ${onDay}`).toBe(reminderHeld(promised, onDay));
    }
    const invoice = await doc();
    await promise(owner, invoice, day(0));
    const held = await asAdmin(async (q) => (await one<{ d: string | null }>(q, "select app.collection_held_until($1, $2)::text as d", [org, invoice])).d);
    expect(held).not.toBeNull();
    await asAdmin((q) => q("update public.payment_promises set promised_date = promised_date - 1 where document_id = $1", [invoice]));
    expect(await asAdmin(async (q) => (await one<{ d: string | null }>(q, "select app.collection_held_until($1, $2)::text as d", [org, invoice])).d)).toBeNull();
    const fns = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; authed: boolean; service: boolean }>(
            `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as authed,
                    has_function_privilege('service_role', p.oid, 'execute') as service
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname in ('collection_reminder_held', 'collection_held_until') order by 1`,
          )
        ).rows,
    );
    expect(fns).toEqual([
      { name: "collection_held_until", authed: false, service: false },
      { name: "collection_reminder_held", authed: false, service: false },
    ]);
  });

  it("the collection screen shows each document's promise", async () => {
    const invoice = await doc("tax_invoice", 2500);
    await promise(owner, invoice, day(9), "אחרי המשכורת");
    const r = await run(owner, async (q) => (await one<{ r: { documents: Array<{ id: string; promised_date: string | null; promise_note: string | null }> } }>(q, "select public.collection_documents($1) as r", [org])).r);
    expect(r.documents.find((d) => d.id === invoice)).toMatchObject({ promised_date: day(9), promise_note: "אחרי המשכורת" });
  });

  // ---- owner's answers of 28 October 2026: (1) ג a promise on the whole customer, (2) a notice when it was not kept ----

  const companyDoc = (company: string, amount = 1000) =>
    run(owner, async (q) => {
      const c = await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'עובדת', $2) returning id", [org, company]);
      return (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, $5) returning id",
          [org, c.id, `PP-${++n}`, day(-40), amount],
        )
      ).id;
    });
  const newCompany = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, $2) returning id", [org, name])).id);
  const customerPromise = (u: U, on: { company?: string; contact?: string }, date: string, note: string | null = null) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, company_id, contact_id, promised_date, note) values ($1, $2, $3, $4, $5) returning id", [
          org,
          on.company ?? null,
          on.contact ?? null,
          date,
          note,
        ])
      ).id,
    );
  const covered = (promise: string) =>
    asAdmin(async (q) => (await q<{ d: string }>("select document_id as d from public.payment_promise_documents where promise_id = $1 order by 1", [promise])).rows.map((r) => r.d));
  const effective = (document: string) => asAdmin(async (q) => (await one<{ p: string | null }>(q, "select app.document_promise($1, $2) as p", [org, document])).p);

  it("a customer promise covers only the documents open when it was made; the document's own promise wins", async () => {
    const co = await newCompany("חברת ההבטחה");
    const open1 = await companyDoc(co, 1000);
    const open2 = await companyDoc(co, 2000);
    const paidDoc = await companyDoc(co, 500);
    await run(owner, async (q) => {
      const c = await one<{ contact_id: string }>(q, "select contact_id from public.accounting_documents where id = $1", [paidDoc]);
      const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 500, $3, 'cash') returning id", [org, c.contact_id, day(-1)]);
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 500)", [org, p.id, paidDoc]);
    });
    const cust = await customerPromise(owner, { company: co }, day(10), "ישלמו הכול בסוף החודש");
    expect(await covered(cust)).toEqual([open1, open2].sort());
    // a document recorded later is not covered
    const later = await companyDoc(co, 700);
    expect(await covered(cust)).not.toContain(later);
    expect(await effective(later)).toBeNull();
    expect(await effective(open1)).toBe(cust);
    // the document's own promise wins over the customer's
    const own = await promise(owner, open2, day(3));
    expect(await effective(open2)).toBe(own);
    const held = await asAdmin(async (q) => (await one<{ d: string }>(q, "select app.collection_held_until($1, $2)::text as d", [org, open1])).d);
    expect(held).toBe(day(10));
    // the screen marks each row's promise and its kind
    const r = await run(owner, async (q) => (await one<{ r: { documents: Array<{ id: string; promise_kind: string | null; promised_date: string | null }> } }>(q, "select public.collection_documents($1, null, false, null, 'company', $2) as r", [org, co])).r);
    const byId = new Map(r.documents.map((d) => [d.id, d]));
    expect(byId.get(open1)).toMatchObject({ promise_kind: "customer", promised_date: day(10) });
    expect(byId.get(open2)).toMatchObject({ promise_kind: "document", promised_date: day(3) });
    expect(byId.get(later)).toMatchObject({ promise_kind: null });
    // one per customer; changing it keeps the covered set; nobody writes the set
    expect(await pgError(customerPromise(owner, { company: co }, day(5)))).toMatchObject({ code: "23505" });
    await run(owner, (q) => q("update public.payment_promises set promised_date = $2 where id = $1", [cust, day(12)]));
    expect(await covered(cust)).toEqual([open1, open2].sort());
    expect((await pgError(run(owner, (q) => q("insert into public.payment_promise_documents (organization_id, promise_id, document_id) values ($1, $2, $3)", [org, cust, later])))).code).toBe("42501");
    expect(await pgError(asAdmin((q) => q("update public.payment_promises set company_id = null, contact_id = $2 where id = $1", [cust, contact])))).toMatchObject({ hint: "payment_promise:fixed" });
  });

  it("a customer promise: a contact of a company is refused, a customer with nothing open is refused", async () => {
    const co = await newCompany("חברה ריקה");
    const employee = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'עובד', $2) returning id", [org, co])).id);
    expect(await pgError(customerPromise(owner, { contact: employee }, day(3)))).toMatchObject({ hint: "payment_promise:customer" });
    expect(await pgError(customerPromise(owner, { company: co }, day(3)))).toMatchObject({ hint: "payment_promise:nothing_open" });
    // a contact without a company: its own documents
    const alone = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לבד') returning id", [org])).id);
    const d = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'proforma', $3, $4, 900) returning id", [org, alone, `PP-${++n}`, day(-3)])).id,
    );
    const p = await customerPromise(owner, { contact: alone }, day(4));
    expect(await covered(p)).toEqual([d]);
  });

  it("a customer the writer cannot read is refused by RLS alone", async () => {
    const co = await newCompany("חברה נסתרת");
    await companyDoc(co);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const e = await pgError(customerPromise(manager, { company: co }, day(2)));
      expect(e.code).toBe("42501");
      expect(e.hint ?? null).toBeNull();
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a promise not kept: one notice to the rep the day after, once; a kept one sends nothing", async () => {
    // a zone where it is now between 08:00 and 23:59, so the job's 08:00 rule passes whenever the test runs
    const zone = await asAdmin(async (q) =>
      (
        await one<{ z: string }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).z,
    );
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    try {
      const broken = await doc();
      const kept = await doc("tax_invoice", 400);
      const brokenPromise = await promise(owner, broken, day(2));
      const keptPromise = await promise(owner, kept, day(2));
      await run(owner, async (q) => {
        const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 400, $3, 'cash') returning id", [org, contact, day(-1)]);
        await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 400)", [org, p.id, kept]);
      });
      // the promised day passed (the server moves it: a person may not set a past date)
      await asAdmin((q) => q("update public.payment_promises set promised_date = (now() at time zone $2)::date - 1 where id = any($1)", [[brokenPromise, keptPromise], zone]));
      const numbers = await asAdmin(async (q) => (await q<{ b: string }>("select 'חשבונית מס ' || number as b from public.accounting_documents where id = any($1)", [[broken, kept]])).rows.map((r) => r.b));
      const notices = () =>
        asAdmin(async (q) =>
          (
            await q<{ user_id: string; title: string; body: string; type: string }>(
              "select user_id, title, body, type from public.notifications where organization_id = $1 and title = 'ההבטחה לא קוימה' and body = any($2)",
              [org, numbers],
            )
          ).rows,
        );
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      const first = await notices();
      expect(first).toEqual([{ user_id: owner.id, title: "ההבטחה לא קוימה", body: expect.stringMatching(/^חשבונית מס PP-/), type: "payment" }]);
      // judged once: a second run sends nothing more
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      expect(await notices()).toHaveLength(1);
      const judged = await asAdmin(async (q) => (await q<{ promise_id: string; kept: boolean }>("select promise_id, kept from app.payment_promise_judged where promise_id = any($1) order by kept", [[brokenPromise, keptPromise]])).rows);
      expect(judged).toEqual([
        { promise_id: brokenPromise, kept: false },
        { promise_id: keptPromise, kept: true },
      ]);
      // no amounts and no names in the notice
      expect(first[0].body).not.toMatch(/₪|מבטיח/);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("a customer promise not kept: one notice to the company's owner", async () => {
    const zone = await asAdmin(async (q) =>
      (
        await one<{ z: string }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).z,
    );
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    try {
      const co = await run(member, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברת הנציג') returning id", [org])).id);
      await companyDoc(co, 1200);
      const p = await customerPromise(owner, { company: co }, day(2));
      await asAdmin((q) => q("update public.payment_promises set promised_date = (now() at time zone $2)::date - 1 where id = $1", [p, zone]));
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      const rows = await asAdmin(async (q) =>
        (await q<{ user_id: string; body: string; entity_type: string; entity_id: string }>("select user_id, body, entity_type, entity_id from public.notifications where organization_id = $1 and title = 'ההבטחה לא קוימה' and entity_id = $2", [org, co])).rows,
      );
      expect(rows).toEqual([{ user_id: member.id, body: "הבטחת תשלום על החובות של הלקוח", entity_type: "company", entity_id: co }]);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  // ---- re-review of 28 October 2026 ----

  const awakeZone = () =>
    asAdmin(async (q) =>
      (
        await one<{ z: string }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).z,
    );
  const withAwakeZone = async (fn: (zone: string) => Promise<void>) => {
    const zone = await awakeZone();
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    try {
      await fn(zone);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  };
  const pastDue = (ids: string[], zone: string) =>
    asAdmin((q) => q("update public.payment_promises set promised_date = (now() at time zone $2)::date - 1 where id = any($1)", [ids, zone]));
  const judged = (id: string) =>
    asAdmin(async (q) => (await q<{ kept: boolean | null; failures: number }>("select kept, failures from app.payment_promise_judged where promise_id = $1", [id])).rows[0]);
  const pipeline = () =>
    asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );

  it("a merge moves a duplicate's customer promise, whoever merges; the kept record's own promise stays", async () => {
    // a team manager merges the team's records too (a person who does not record payments cannot merge at all: merging needs
    // can_edit_record and can_delete_record, owners, admins and managers only; the marker does not depend on who merges)
    const teamLead = await addMember(org, owner.id, "manager", "pp-team-lead");
    const team = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'צוות גבייה') returning id", [org])).id);
    await asAdmin((q) => q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, team, teamLead.id]));
    const person = (name: string) =>
      run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, team_id) values ($1, $2, $3) returning id", [org, name, team])).id);
    const debtOn = (c: string) =>
      run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 1000) returning id", [org, c, `PP-${++n}`, day(-5)])).id,
      );
    const promiseOf = (on: { contact?: string; company?: string }) =>
      asAdmin(async (q) =>
        (await q<{ id: string }>("select id from public.payment_promises where organization_id = $1 and (contact_id = $2 or company_id = $3)", [org, on.contact ?? null, on.company ?? null])).rows.map((r) => r.id),
      );
    for (const merger of [owner, teamLead]) {
      // the kept contact has no promise: the duplicate's moves to it
      const keep = await person("שמור");
      const dup = await person("כפול");
      await debtOn(dup);
      const moved = await customerPromise(owner, { contact: dup }, day(6), "יעביר");
      await run(merger, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
      expect(await promiseOf({ contact: keep }), merger.email).toEqual([moved]);
      expect(await covered(moved)).toHaveLength(1);
      // the kept contact has its own: it stays, the duplicate's goes with the duplicate
      const keep2 = await person("שמור 2");
      const dup2 = await person("כפול 2");
      await debtOn(keep2);
      await debtOn(dup2);
      const kept = await customerPromise(owner, { contact: keep2 }, day(4));
      await customerPromise(owner, { contact: dup2 }, day(8));
      await run(merger, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep2, dup2]));
      expect(await promiseOf({ contact: keep2 }), merger.email).toEqual([kept]);
    }
    // companies (merged by the owner; a team lead does not manage these)
    const coKeep = await newCompany("חברה שנשמרת");
    const coDup = await newCompany("חברה כפולה");
    await companyDoc(coDup);
    const coPromise = await customerPromise(owner, { company: coDup }, day(5));
    await run(owner, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}')", [org, coKeep, coDup]));
    expect(await promiseOf({ company: coKeep })).toEqual([coPromise]);
    const coKeep2 = await newCompany("חברה שנשמרת 2");
    const coDup2 = await newCompany("חברה כפולה 2");
    await companyDoc(coKeep2);
    await companyDoc(coDup2);
    const coOwn = await customerPromise(owner, { company: coKeep2 }, day(5));
    await customerPromise(owner, { company: coDup2 }, day(7));
    await run(owner, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}')", [org, coKeep2, coDup2]));
    expect(await promiseOf({ company: coKeep2 })).toEqual([coOwn]);
    // the marker moves only the customer: anything else under it is refused
    expect(
      await pgError(
        asAdmin(async (q) => {
          await q("select set_config('app.payment_promise_merge', $1, true)", [org]);
          await q("update public.payment_promises set note = 'x' where id = $1", [coOwn]);
        }),
      ),
    ).toMatchObject({ hint: "payment_promise:fixed" });
  });

  it("a customer promise is judged only over the documents it still speaks for; a billed proforma by its invoice", async () => {
    await withAwakeZone(async (zone) => {
      // the covered document with its own (later) promise does not break the customer promise
      const co = await newCompany("חברה עם הבטחה כפולה");
      const d1 = await companyDoc(co, 1000);
      const cust = await customerPromise(owner, { company: co }, day(3));
      await promise(owner, d1, day(30));
      await pastDue([cust], zone);
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      expect(await judged(cust)).toMatchObject({ kept: true });

      // a proforma billed by an active tax invoice: kept when the invoice is paid, broken while it is not
      const proformaPaid = await doc("proforma", 1000);
      const proformaOpen = await doc("proforma", 1000);
      const bill = (proforma: string) =>
        run(owner, async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, proforma_id) values ($1, $2, 'tax_invoice', $3, $4, 1000, $5) returning id",
              [org, contact, `PP-${++n}`, day(-1), proforma],
            )
          ).id,
        );
      const paidInvoice = await bill(proformaPaid);
      await bill(proformaOpen);
      await run(owner, async (q) => {
        const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 1000, $3, 'cash') returning id", [org, contact, day(-1)]);
        await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 1000)", [org, p.id, paidInvoice]);
      });
      // promises made before the proformas were billed (the database refuses a promise on a billed proforma? no: it stays active)
      const pPaid = await asAdmin(async (q) =>
        (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date) returning id", [org, proformaPaid])).id,
      );
      const pOpen = await asAdmin(async (q) =>
        (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date) returning id", [org, proformaOpen])).id,
      );
      await pastDue([pPaid, pOpen], zone);
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      expect(await judged(pPaid)).toMatchObject({ kept: true });
      expect(await judged(pOpen)).toMatchObject({ kept: false });
    });
  });

  it("a failing promise is recorded and retried after the fresh ones; after 3 failures it is skipped", async () => {
    await withAwakeZone(async (zone) => {
      const d = await doc();
      const p = await promise(owner, d, day(2));
      await pastDue([p], zone);
      // make this one promise fail inside the job (its notice insert), in a transaction that is rolled back afterwards
      let seen: unknown = null;
      const rolledBack = await pgError(
        asAdmin(async (q) => {
          await q(`create function pg_temp.fail_notice() returns trigger language plpgsql as $f$ begin raise exception 'boom'; end $f$`);
          await q("create trigger zz_fail_notice before insert on public.notifications for each row execute function pg_temp.fail_notice()");
          await q("select app.send_promise_breaks()");
          seen = (await q<{ kept: boolean | null; failures: number }>("select kept, failures from app.payment_promise_judged where promise_id = $1", [p])).rows[0];
          // roll the trigger (and this attempt) back
          await q("select 1/0");
        }),
      );
      expect(rolledBack.code).toBe("22012");
      expect(seen).toMatchObject({ kept: null, failures: 1 });
      expect(await judged(p)).toBeUndefined();
      // three failures recorded: skipped, never judged again
      await asAdmin((q) =>
        q("insert into app.payment_promise_judged (promise_id, promised_date, failures, last_attempt_at) select id, promised_date, 3, now() from public.payment_promises where id = $1", [p]),
      );
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      expect(await judged(p)).toMatchObject({ kept: null, failures: 3 });
    });
  });

  it("a contact's customer promise leaves out documents on a deal that has a company", async () => {
    const pipe = await pipeline();
    const person = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'עצמאית') returning id", [org])).id);
    const co = await newCompany("החברה של העסקה");
    const deal = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [org, pipe.p, pipe.s, person, co])).id,
    );
    const mine = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 500) returning id", [org, person, `PP-${++n}`, day(-2)])).id,
    );
    await run(owner, (q) =>
      q("insert into public.accounting_documents (organization_id, contact_id, deal_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, $5, 700)", [org, person, deal, `PP-${++n}`, day(-2)]),
    );
    const p = await customerPromise(owner, { contact: person }, day(5));
    expect(await covered(p)).toEqual([mine]);
  });

  // ---- owner's answers of 29 October 2026: (5) א, (6) ב, (7) א ----

  it("(6) ב: a customer promise covers every open document, also those the recorder cannot read; the recorder sees a count only", async () => {
    const co = await run(manager, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברה בחלקה נסתרת') returning id", [org])).id);
    // two documents on the owner's contacts (hidden from the manager under 'own'), one on the manager's own contact
    const hidden1 = await companyDoc(co, 1000);
    const hidden2 = await companyDoc(co, 2000);
    const mine = await run(manager, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'של המנהל', $2) returning id", [org, co])).id);
    const seen = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 300) returning id", [org, mine, `PP-${++n}`, day(-3)])).id,
    );
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const readable = await run(manager, async (q) => (await q<{ id: string }>("select id from public.accounting_documents where id = any($1)", [[hidden1, hidden2, seen]])).rows.map((r) => r.id));
      expect(readable).toEqual([seen]);
      const p = await customerPromise(manager, { company: co }, day(6));
      expect(await covered(p)).toEqual([hidden1, hidden2, seen].sort());
      // the manager reads the count, never the hidden rows
      const coverage = await run(manager, async (q) => (await one<{ c: unknown }>(q, "select public.payment_promise_coverage($1, $2) as c", [org, [p]])).c);
      expect(coverage).toEqual([{ promise_id: p, documents: 3 }]);
      const rows = await run(manager, async (q) => (await q<{ d: string }>("select document_id as d from public.payment_promise_documents where promise_id = $1", [p])).rows.map((r) => r.d));
      expect(rows).toEqual([seen]);
      // a member who does not record payments gets nothing; neither does anyone for a promise they cannot read
      expect(await run(member, async (q) => (await one<{ c: unknown }>(q, "select public.payment_promise_coverage($1, $2) as c", [org, [p]])).c)).toEqual([]);
      const other = await newCompany("חברה של הבעלים");
      await companyDoc(other, 400);
      const theirs = await customerPromise(owner, { company: other }, day(6));
      expect(await run(manager, async (q) => (await one<{ c: unknown }>(q, "select public.payment_promise_coverage($1, $2) as c", [org, [theirs]])).c)).toEqual([]);
      expect(await run(owner, async (q) => (await one<{ c: unknown }>(q, "select public.payment_promise_coverage($1, $2) as c", [org, [theirs, p]])).c)).toEqual(
        [{ promise_id: theirs, documents: 1 }, { promise_id: p, documents: 3 }].sort((a, b) => a.promise_id.localeCompare(b.promise_id)),
      );
      // a person cannot reach the definer helpers directly
      expect((await pgError(run(manager, (q) => q("select app.payment_promise_cover($1, $2, $3)", [org, p, [hidden1]])))).code).toBe("42501");
      expect((await pgError(run(manager, (q) => q("select app.customer_open_documents($1, null, $2)", [org, co])))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("(5) א: a customer promise not kept goes to the owner, else the recorder, else owners and admins; a document promise keeps its rule", async () => {
    await withAwakeZone(async (zone) => {
      const notices = (entity: string) =>
        asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and title = 'ההבטחה לא קוימה' and entity_id = $2 order by user_id", [org, entity])).rows.map((r) => r.user_id));
      // no owner on the company: the manager who recorded the promise
      const co1 = await newCompany("חברה בלי אחראי");
      await asAdmin((q) => q("update public.companies set owner_id = null where id = $1", [co1]));
      await companyDoc(co1, 900);
      const p1 = await customerPromise(manager, { company: co1 }, day(2));
      // an owner who is no longer active is not usable: again the recorder
      const gone = await addMember(org, owner.id, "member", "pp-gone-owner");
      const alone = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח של מי שעזב') returning id", [org])).id);
      await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [alone, gone.id]));
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, gone.id]));
      await run(owner, (q) => q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 800)", [org, alone, `PP-${++n}`, day(-3)]));
      const p2 = await customerPromise(manager, { contact: alone }, day(2));
      // neither usable (the recorder left): every active owner and admin
      const leaver = await addMember(org, owner.id, "manager", "pp-leaver");
      const co3 = await newCompany("חברה שהרושם עזב");
      await asAdmin((q) => q("update public.companies set owner_id = null where id = $1", [co3]));
      await companyDoc(co3, 700);
      const p3 = await customerPromise(leaver, { company: co3 }, day(2));
      await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
      await pastDue([p1, p2, p3], zone);
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      expect(await notices(co1)).toEqual([manager.id]);
      expect(await notices(alone)).toEqual([manager.id]);
      const admins = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.memberships where organization_id = $1 and status = 'active' and role in ('owner', 'admin') order by user_id", [org])).rows.map((r) => r.user_id));
      expect(await notices(co3)).toEqual(admins);
      // a document promise never goes to its recorder: no owner on its record = owners and admins
      const orphan = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'בלי אחראי') returning id", [org])).id);
      await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [orphan]));
      const d = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 600) returning id", [org, orphan, `PP-${++n}`, day(-3)])).id,
      );
      const p4 = await promise(manager, d, day(2));
      await pastDue([p4], zone);
      await asAdmin((q) => q("select app.send_promise_breaks()"));
      expect(await notices(orphan)).toEqual(admins);
    });
  });

  it("(7) א: two customer promises covering one document (the contact moved to a company): the newest wins", async () => {
    const person = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'עוברת לחברה') returning id", [org])).id);
    const d = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 500) returning id", [org, person, `PP-${++n}`, day(-3)])).id,
    );
    const first = await customerPromise(owner, { contact: person }, day(20));
    expect(await effective(d)).toBe(first);
    const co = await newCompany("החברה החדשה שלה");
    await run(owner, (q) => q("update public.contacts set company_id = $2 where id = $1", [person, co]));
    const second = await customerPromise(owner, { company: co }, day(4));
    expect(await covered(second)).toEqual([d]);
    expect(await effective(d)).toBe(second);
  });
});
