import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTION_CUSTOMER_WORDING_VERSION, DEFAULT_COLLECTION_CUSTOMER_TEMPLATES } from "../../src/features/message-templates/templates";

import { Client } from "pg";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, TEST_DB_URL, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Job = { id: string; payload: Record<string, unknown>; status: string; last_error: string | null };

/**
 * COL-07 (lead's choices until the owner answers): with org_document_settings.collection_customer_reminder on (off by
 * default), every COL-04 stage of a debt document also queues ONE `collection` service message to the customer: SMS to the
 * contact's own phone while the business holds `sms`, else email to its own email; templates marked
 * notice_kind 'collection_reminder' seeded once per channel; a waiting message is cancelled once the debt is settled or the
 * switch is turned off. The rep's task is made as before.
 */
describe("collection reminders to the customer (COL-07)", () => {
  let owner: U, member: U;
  let org: string;
  let zone: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, collection: true, sms: false };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  /**
   * the COL-04 job; second review 1: a message is queued only when a worker asked for message jobs in the last day, so the job
   * runs with message.send seen now, and the shared row is put back in the same transaction (other test files see nothing)
   */
  const job = (o = org, worker = true) =>
    asAdmin(async (q) => {
      const before = (await one<{ t: string | null }>(q, "select last_claimed_at::text as t from app.job_kind_seen where kind = 'message.send'")).t;
      if (worker) await q("update app.job_kind_seen set last_claimed_at = now() where kind = 'message.send'");
      else await q("update app.job_kind_seen set last_claimed_at = null where kind = 'message.send'");
      // third review 3: no finally. When the job raises, the transaction rolls back (the row's change with it), and a restore
      // in an aborted transaction would only throw "current transaction is aborted" and hide the job's own error
      const n = (await one<{ n: number }>(q, "select app.send_collection_reminders($1::uuid[]) as n", [[o]])).n;
      await q("update app.job_kind_seen set last_claimed_at = $1::timestamptz where kind = 'message.send'", [before]);
      return n;
    });
  const features = (o: string, extra: Record<string, boolean> = {}) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify({ ...FEATURES, ...extra })]));
  const setSwitch = (o: string, on: boolean, u: U = owner) =>
    run(u, async (q) => {
      const done = await q("update public.org_document_settings set collection_customer_reminder = $2 where organization_id = $1 returning id", [o, on]);
      if (done.rowCount === 0) await q("insert into public.org_document_settings (organization_id, collection_customer_reminder) values ($1, $2)", [o, on]);
    });
  const setStages = (o: string, stages: number[], u: U = owner) =>
    run(u, (q) => q("update public.org_document_settings set collection_customer_stages = $2::smallint[] where organization_id = $1", [o, stages]));
  const contactWith = (o: string, phone: string | null, email: string | null, u: U = owner) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.contacts (organization_id, first_name, owner_id, phone, email) values ($1, 'לקוח', $2, $3, $4) returning id",
          [o, u.id, phone, email],
        )
      ).id,
    );
  /** an invoice on a contact (or a deal), due k days from the business's today */
  const doc = async (k: number, links: { contact?: string; deal?: string }, o = org, u: U = owner) => {
    const id = await run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.accounting_documents (organization_id, contact_id, deal_id, doc_type, number, doc_date, amount_agorot)
           values ($1, $2, $3, 'tax_invoice', $4, current_date - 40, 1000) returning id`,
          [o, links.contact ?? null, links.deal ?? null, `CC-${++n}`],
        )
      ).id,
    );
    await setDue(id, k);
    return id;
  };
  const setDue = (id: string, k: number) =>
    asAdmin((q) => q("update public.accounting_documents set due_date = (now() at time zone $2)::date + $3::integer where id = $1", [id, zone, k]));
  const jobs = (document: string) =>
    asAdmin(async (q) =>
      (await q<Job>("select id, payload, status, last_error from app.jobs where payload ->> 'collection_document_id' = $1 order by created_at, id", [document])).rows,
    );
  const outcomes = (document: string) =>
    asAdmin(async (q) =>
      (
        await q<{ offset_days: number; customer_outcome: string | null; has_task: boolean }>(
          "select offset_days, customer_outcome, task_id is not null as has_task from app.collection_reminders_sent where document_id = $1 order by offset_days",
          [document],
        )
      ).rows,
    );
  const tasks = (document: string) =>
    asAdmin((q) => count(q, "select 1 from public.tasks where collection_document_id = $1 and deleted_at is null", [document]));
  /** the start of the business day k days from today, in ms */
  const dayStart = (k: number) =>
    asAdmin(async (q) =>
      Number(
        (await one<{ t: string }>(q, "select (extract(epoch from (((now() at time zone $1)::date + $2::integer)::timestamp at time zone $1)) * 1000)::bigint::text as t", [zone, k])).t,
      ),
    );
  const cancelCount = (o: string, reason: string) =>
    asAdmin(async (q) =>
      Number((await one<{ n: number }>(q, "select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = $2", [o, reason])).n),
    );

  const pickZone = () =>
    asAdmin(async (q) =>
      (
        await one<{ z: string }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).z,
    );
  const prepare = async (o: string, u: U) => {
    await features(o);
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [o, zone]));
    // no rest days: the day-to-day schedule (COL-04's own tests cover rest days)
    await run(u, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
         values ($1, '{}', false, false, '{}')
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}'`,
        [o],
      ),
    );
  };

  beforeAll(async () => {
    owner = await createUser("cc-owner");
    org = await createOrg(owner.id, "עסק התזכורות ללקוח");
    member = await addMember(org, owner.id, "member", "cc-member");
    zone = await pickZone();
    await prepare(org, owner);
  });

  it("is off by default: the rep's task is made, nothing is queued for the customer and no template is added", async () => {
    expect(
      await asAdmin(async (q) =>
        (await one<{ d: string }>(q, "select column_default as d from information_schema.columns where table_schema = 'public' and table_name = 'org_document_settings' and column_name = 'collection_customer_reminder'")).d,
      ),
    ).toBe("false");
    const contact = await contactWith(org, "0501234567", "debtor@example.com");
    const invoice = await doc(0, { contact });
    await job();
    expect(await tasks(invoice)).toBe(1);
    expect(await jobs(invoice)).toEqual([]);
    expect(await outcomes(invoice)).toEqual([{ offset_days: 0, customer_outcome: null, has_task: true }]);
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind = 'collection_reminder'", [org]))).toBe(0);
    // switching on later never sends a stage already recorded
    await setSwitch(org, true);
    await job();
    expect(await jobs(invoice)).toEqual([]);
    await setSwitch(org, false);
  });

  it("only owners and admins switch it", async () => {
    await setSwitch(org, false);
    expect(await run(member, async (q) => (await q("update public.org_document_settings set collection_customer_reminder = true where organization_id = $1 returning id", [org])).rowCount)).toBe(0);
    expect(await asAdmin(async (q) => (await one<{ on: boolean }>(q, "select collection_customer_reminder as on from public.org_document_settings where organization_id = $1", [org])).on)).toBe(false);
  });

  it("(256) ג by default the due date, +7 and +14 go to the customer, not -3; the business chooses", async () => {
    await setSwitch(org, true);
    expect(
      await asAdmin(async (q) => (await one<{ s: number[] }>(q, "select collection_customer_stages as s from public.org_document_settings where organization_id = $1", [org])).s),
    ).toEqual([0, 7, 14]);
    const contact = await contactWith(org, null, "stages@example.com");
    const early = await doc(3, { contact });
    await job();
    expect(await jobs(early)).toEqual([]);
    // (258) ב: no message queued, so the rep's task is made
    expect(await outcomes(early)).toEqual([{ offset_days: -3, customer_outcome: "stage_off", has_task: true }]);
    // only COL-04's offsets, owners and admins
    expect(await run(member, async (q) => (await q("update public.org_document_settings set collection_customer_stages = '{0}' where organization_id = $1 returning id", [org])).rowCount)).toBe(0);
    await expect(setStages(org, [1])).rejects.toThrow(/collection_customer_stages_check/);
    await setStages(org, [7]);
    const due = await doc(0, { contact });
    await job();
    expect((await outcomes(due))[0].customer_outcome).toBe("stage_off");
    await setStages(org, [-3, 0, 7, 14]);
  });

  it("each stage queues one email to a contact while the business has no `sms`; the templates are seeded once per channel", async () => {
    await setSwitch(org, true);
    await setStages(org, [-3, 0, 7, 14]);
    const contact = await contactWith(org, "0501234568", "pay@example.com");
    const invoice = await doc(3, { contact });
    await job();
    await job();
    // (258) ב: a stage that queued its message makes no task
    expect(await outcomes(invoice)).toEqual([{ offset_days: -3, customer_outcome: "queued", has_task: false }]);
    expect(await tasks(invoice)).toBe(0);
    const [first, ...rest] = await jobs(invoice);
    expect(rest).toEqual([]);
    expect(first.status).toBe("queued");
    const templates = await asAdmin(async (q) =>
      (
        await q<{ id: string; name: string; channel: string; message_type: string; subject: string | null; body: string; wording_version: string }>(
          "select id, name, channel, message_type, subject, body, wording_version from public.message_templates where organization_id = $1 and notice_kind = 'collection_reminder' order by channel desc",
          [org],
        )
      ).rows,
    );
    expect(templates.map(({ name, channel, message_type, subject, body, wording_version }) => ({ name, channel, messageType: message_type, subject, body, wording_version }))).toEqual(
      DEFAULT_COLLECTION_CUSTOMER_TEMPLATES.map((d) => ({ ...d, wording_version: COLLECTION_CUSTOMER_WORDING_VERSION })).map((d) => ({ name: d.name, channel: d.channel, messageType: d.messageType, subject: d.subject, body: d.body, wording_version: d.wording_version })),
    );
    const email = templates.find((t) => t.channel === "email")!;
    const { event_at: firstUntil, ...firstRest } = first.payload as { event_at: string };
    expect(firstRest).toEqual({
      channel: "email",
      message_type: "collection",
      template_id: email.id,
      contact_id: contact,
      collection_document_id: invoice,
    });
    // review 1: the -3 stage is valid until the next stage's day (the due date, a working day here) begins
    expect(Date.parse(firstUntil)).toBe(await dayStart(3));
    // the service rule passes the seeded templates
    for (const t of templates) {
      expect(await asAdmin(async (q) => (await one<{ p: string | null }>(q, "select app.message_template_sendable($1, $2) as p", [org, t.id])).p)).toBeNull();
    }
    // the next stage (the due date) queues one more, once
    await setDue(invoice, 0);
    await job();
    await job();
    const both = await jobs(invoice);
    expect(both).toHaveLength(2);
    // review 1: the earlier stage still waiting is superseded, so stages never arrive together
    expect(both[0]).toMatchObject({ status: "refused", last_error: "refused:superseded" });
    expect(both[1].status).toBe("queued");
    expect((await outcomes(invoice)).map((r) => r.customer_outcome)).toEqual(["superseded", "queued"]);
    // the due-date stage lasts until the +7 stage's day
    expect(Date.parse(both[1].payload.event_at as string)).toBe(await dayStart(7));
    // the last stage (+14) lasts 7 days from its own day
    await setDue(invoice, -14);
    await job();
    const three = await jobs(invoice);
    expect(three).toHaveLength(3);
    expect(three[1]).toMatchObject({ status: "refused", last_error: "refused:superseded" });
    expect(Date.parse(three[2].payload.event_at as string)).toBe(await dayStart(7));
    // (258) ב: the last stage always makes the rep's task too
    expect((await outcomes(invoice)).find((r) => r.offset_days === 14)).toEqual({ offset_days: 14, customer_outcome: "queued", has_task: true });
    expect(await tasks(invoice)).toBe(1);
    // a deleted template is not brought back
    await run(owner, (q) => q("delete from public.message_templates where id = $1", [email.id]));
    await asAdmin((q) => q("select app.seed_collection_reminder_templates($1)", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind = 'collection_reminder' and channel = 'email'", [org]))).toBe(0);
    // no email template now: the stage makes only the task
    const other = await doc(0, { contact });
    await job();
    expect(await jobs(other)).toEqual([]);
    expect(await outcomes(other)).toEqual([{ offset_days: 0, customer_outcome: "no_template", has_task: true }]);
    // a template the business switched off is not used either; the tests below get the seeded email template back
    await asAdmin((q) =>
      q(
        "insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, is_active) values ($1, $2, 'email', 'collection', $3, $4, 'collection_reminder', false)",
        [org, email.name, email.subject, email.body],
      ),
    );
    const off = await doc(0, { contact });
    await job();
    expect((await outcomes(off))[0].customer_outcome).toBe("no_template");
    await asAdmin((q) => q("update public.message_templates set is_active = true where organization_id = $1 and notice_kind = 'collection_reminder' and channel = 'email'", [org]));
  });

  describe("the channel", () => {
    let o: string;
    let boss: U;
    beforeAll(async () => {
      boss = await createUser("cc-boss");
      o = await createOrg(boss.id, "עסק הערוצים");
      await addMember(o, boss.id, "member", "cc-x");
      await prepare(o, boss);
      await setSwitch(o, true, boss);
    });

    it("(c): SMS to the contact's own phone with `sms`, else email; no address = no message", async () => {
      const both = await contactWith(o, "0521111111", "both@example.com", boss);
      const phoneOnly = await contactWith(o, "0522222222", null, boss);
      const nothing = await contactWith(o, null, null, boss);
      // without sms: email
      const d1 = await doc(0, { contact: both }, o, boss);
      const d2 = await doc(0, { contact: phoneOnly }, o, boss);
      const d3 = await doc(0, { contact: nothing }, o, boss);
      await job(o);
      expect((await jobs(d1))[0].payload.channel).toBe("email");
      expect(await jobs(d2)).toEqual([]);
      expect((await outcomes(d2))[0]).toEqual({ offset_days: 0, customer_outcome: "no_address", has_task: true });
      expect((await outcomes(d3))[0].customer_outcome).toBe("no_address");
      // with sms: SMS to the phone; an email-only contact still gets email
      await features(o, { sms: true });
      const emailOnly = await contactWith(o, null, "mail@example.com", boss);
      const d4 = await doc(0, { contact: both }, o, boss);
      const d5 = await doc(0, { contact: phoneOnly }, o, boss);
      const d6 = await doc(0, { contact: emailOnly }, o, boss);
      await job(o);
      const sms = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.message_templates where organization_id = $1 and notice_kind = 'collection_reminder' and channel = 'sms'", [o])).id);
      expect((await jobs(d4))[0].payload).toMatchObject({ channel: "sms", template_id: sms, contact_id: both });
      expect((await jobs(d5))[0].payload.channel).toBe("sms");
      expect((await jobs(d6))[0].payload.channel).toBe("email");
      await features(o);
    });

    it("(257) ד: the contact's preferred channel first, when it is SMS or email and usable", async () => {
      await features(o, { sms: true });
      try {
        const prefers = async (channel: string, phone: string | null, email: string | null) => {
          const c = await contactWith(o, phone, email, boss);
          await run(boss, (q) => q("update public.contacts set preferred_channel = $2 where id = $1", [c, channel]));
          const d = await doc(0, { contact: c }, o, boss);
          await job(o);
          return (await jobs(d))[0]?.payload.channel ?? null;
        };
        // email preferred over the SMS default
        expect(await prefers("email", "0523333333", "pref@example.com")).toBe("email");
        // SMS preferred
        expect(await prefers("sms", "0524444444", "pref2@example.com")).toBe("sms");
        // email preferred but no email: SMS
        expect(await prefers("email", "0525555555", null)).toBe("sms");
        // WhatsApp or phone preferred: the default order
        expect(await prefers("whatsapp", "0526666666", "pref3@example.com")).toBe("sms");
        expect(await prefers("phone", null, "pref4@example.com")).toBe("email");
      } finally {
        await features(o);
      }
      // SMS preferred without the plan's `sms`: email
      const c = await contactWith(o, "0527777777", "pref5@example.com", boss);
      await run(boss, (q) => q("update public.contacts set preferred_channel = 'sms' where id = $1", [c]));
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      expect((await jobs(d))[0].payload.channel).toBe("email");
    });

    it("a deal's document goes to the deal's contact; a deal without a contact has no person", async () => {
      const person = await contactWith(o, null, "deal@example.com", boss);
      const makeDeal = (contact: string | null) =>
        run(boss, async (q) =>
          (
            await one<{ id: string }>(
              q,
              `insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id)
               select $1, 'עסקה', p.id, (select s.id from public.stages s where s.pipeline_id = p.id order by s.position, s.id limit 1), $2
                 from public.pipelines p where p.organization_id = $1 and p.deleted_at is null order by p.position, p.id limit 1
               returning id`,
              [o, contact],
            )
          ).id,
        );
      const onDeal = await doc(0, { deal: await makeDeal(person) }, o, boss);
      const noPerson = await doc(0, { deal: await makeDeal(null) }, o, boss);
      await job(o);
      expect((await jobs(onDeal))[0].payload).toMatchObject({ channel: "email", contact_id: person, collection_document_id: onDeal });
      expect(await jobs(noPerson)).toEqual([]);
      expect((await outcomes(noPerson))[0]).toEqual({ offset_days: 0, customer_outcome: "no_customer", has_task: true });
    });
  });

  it("a paid, held or cancelled document gets nothing; a debt settled after queuing cancels the waiting message", async () => {
    await setSwitch(org, true);
    const contact = await contactWith(org, null, "settle@example.com");
    const paid = await doc(0, { contact });
    const held = await doc(0, { contact });
    const cancelled = await doc(0, { contact });
    await run(owner, async (q) => {
      const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 1000, current_date, 'cash') returning id", [org, contact]);
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 1000)", [org, p.id, paid]);
      await q("insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, (now() at time zone $3)::date + 2)", [org, held, zone]);
      await q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]);
    });
    await job();
    for (const d of [paid, held, cancelled]) expect(await jobs(d)).toEqual([]);

    // queued, then settled three ways
    const a = await doc(0, { contact });
    const b = await doc(0, { contact });
    const c = await doc(0, { contact });
    const untouched = await doc(0, { contact });
    await job();
    for (const d of [a, b, c, untouched]) expect((await jobs(d))[0].status).toBe("queued");
    const before = await cancelCount(org, "debt_settled");
    await run(owner, async (q) => {
      const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 1000, current_date, 'cash') returning id", [org, contact]);
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 1000)", [org, p.id, a]);
      await q("insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, (now() at time zone $3)::date + 2)", [org, b, zone]);
      await q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [c]);
    });
    await job();
    for (const d of [a, b, c]) expect((await jobs(d))[0]).toMatchObject({ status: "refused", last_error: "refused:debt_settled" });
    expect((await jobs(untouched))[0].status).toBe("queued");
    expect(await cancelCount(org, "debt_settled")).toBe(before + 3);
    expect((await outcomes(a))[0].customer_outcome).toBe("cancelled");
  });

  describe("review 3 and 4: the sweep", () => {
    let o: string;
    let boss: U;
    const sweep = (limit?: number) =>
      asAdmin(async (q) => {
        if (limit) await q("select set_config('app.collection_reminder_limit', $1, true)", [String(limit)]);
        return Number((await one<{ n: number }>(q, "select app.cancel_settled_collection_messages($1::uuid[]) as n", [[o]])).n);
      });
    const makeDeal = (contact: string | null) =>
      run(boss, async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id)
             select $1, 'עסקה', p.id, (select s.id from public.stages s where s.pipeline_id = p.id order by s.position, s.id limit 1), $2
               from public.pipelines p where p.organization_id = $1 and p.deleted_at is null order by p.position, p.id limit 1
             returning id`,
            [o, contact],
          )
        ).id,
      );
    beforeAll(async () => {
      boss = await createUser("cc-sweep");
      o = await createOrg(boss.id, "עסק הסריקה");
      await addMember(o, boss.id, "member", "cc-z");
      await prepare(o, boss);
      await setSwitch(o, true, boss);
    });

    it("cancels when the deal's contact changed or went to the bin (customer_changed)", async () => {
      const first = await contactWith(o, null, "first@example.com", boss);
      const second = await contactWith(o, null, "second@example.com", boss);
      const binned = await contactWith(o, null, "binned@example.com", boss);
      const changedDeal = await makeDeal(first);
      const binnedDeal = await makeDeal(binned);
      const changed = await doc(0, { deal: changedDeal }, o, boss);
      const gone = await doc(0, { deal: binnedDeal }, o, boss);
      await job(o);
      expect((await jobs(changed))[0].status).toBe("queued");
      expect((await jobs(gone))[0].status).toBe("queued");
      await run(boss, async (q) => {
        await q("update public.deals set contact_id = $2 where id = $1", [changedDeal, second]);
        await q("update public.contacts set deleted_at = now() where id = $1", [binned]);
      });
      await sweep();
      expect((await jobs(changed))[0]).toMatchObject({ status: "refused", last_error: "refused:customer_changed" });
      expect((await jobs(gone))[0]).toMatchObject({ status: "refused", last_error: "refused:customer_changed" });
    });

    it("cancels when the business lost a key (business_off)", async () => {
      const contact = await contactWith(o, null, "keys@example.com", boss);
      const d = await doc(0, { contact }, o, boss);
      await job(o);
      expect((await jobs(d))[0].status).toBe("queued");
      await features(o, { collection: false });
      try {
        await sweep();
      } finally {
        await features(o);
      }
      expect((await jobs(d))[0]).toMatchObject({ status: "refused", last_error: "refused:business_off" });
    });

    it("moves a finished job's row to its final outcome, and judges at most the cap a run, the longest unchecked first", async () => {
      const contact = await contactWith(o, null, "final@example.com", boss);
      const sent = await doc(0, { contact }, o, boss);
      const dead = await doc(0, { contact }, o, boss);
      const waiting = await doc(0, { contact }, o, boss);
      await job(o);
      await asAdmin(async (q) => {
        await q("update app.jobs set status = 'done', finished_at = now() where id = $1", [(await jobs(sent))[0].id]);
        await q("update app.jobs set status = 'dead', finished_at = now() where id = $1", [(await jobs(dead))[0].id]);
      });
      // judge everything once, so all rows of the business have a check time
      await sweep();
      expect((await outcomes(sent))[0].customer_outcome).toBe("sent");
      expect((await outcomes(dead))[0].customer_outcome).toBe("dead");
      expect((await outcomes(waiting))[0].customer_outcome).toBe("queued");
      expect(
        await asAdmin((q) => count(q, "select 1 from app.collection_reminders_sent where organization_id = $1 and customer_outcome = 'queued'", [o])),
      ).toBe(1);
      // the cap: two waiting rows, one judged a run; the next run takes the other
      const second = await doc(0, { contact }, o, boss);
      await job(o);
      const checked = () =>
        asAdmin(async (q) =>
          (
            await q<{ document_id: string; t: string | null }>(
              "select document_id, customer_checked_at::text as t from app.collection_reminders_sent where organization_id = $1 and customer_outcome = 'queued'",
              [o],
            )
          ).rows,
        );
      expect((await checked()).find((r) => r.document_id === second)?.t ?? null).toBeNull();
      const before = (await checked()).find((r) => r.document_id === waiting)!.t;
      await sweep(1);
      const after = await checked();
      expect(after.find((r) => r.document_id === second)!.t).not.toBeNull();
      expect(after.find((r) => r.document_id === waiting)!.t).toBe(before);
    });
  });

  it("switching off cancels the business's waiting messages; switching on does not queue them again", async () => {
    await setSwitch(org, true);
    const contact = await contactWith(org, null, "off@example.com");
    const d = await doc(0, { contact });
    await job();
    expect((await jobs(d))[0].status).toBe("queued");
    const before = await cancelCount(org, "reminder_off");
    await setSwitch(org, false);
    expect((await jobs(d))[0]).toMatchObject({ status: "refused", last_error: "refused:reminder_off" });
    expect(await cancelCount(org, "reminder_off")).toBeGreaterThan(before);
    await setSwitch(org, true);
    await job();
    expect(await jobs(d)).toHaveLength(1);
    // review 2: removing the settings row also switches it off, and cancels
    const later = await doc(0, { contact });
    await job();
    expect((await jobs(later))[0].status).toBe("queued");
    const removed = await run(owner, async (q) => (await q("delete from public.org_document_settings where organization_id = $1 returning id", [org])).rowCount);
    if (removed === 0) await asAdmin((q) => q("delete from public.org_document_settings where organization_id = $1", [org]));
    expect((await jobs(later))[0]).toMatchObject({ status: "refused", last_error: "refused:reminder_off" });
    expect((await outcomes(later))[0].customer_outcome).toBe("cancelled");
    await setSwitch(org, false);
  });

  it("past the 50-template cap nothing is seeded: the stage makes only the task, and the seeding is not tried again", async () => {
    const boss = await createUser("cc-full");
    const o = await createOrg(boss.id, "עסק מלא בתבניות");
    await addMember(o, boss.id, "member", "cc-y");
    await prepare(o, boss);
    await run(boss, async (q) => {
      const have = await count(q, "select 1 from public.message_templates where organization_id = $1", [o]);
      for (let i = have; i < 50; i++) {
        await q("insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, $2, 'sms', 'marketing', 'שלום {שם פרטי}')", [o, `תבנית ${i}`]);
      }
    });
    await setSwitch(o, true, boss);
    const contact = await contactWith(o, null, "full@example.com", boss);
    const d = await doc(0, { contact }, o, boss);
    await job(o);
    expect(await tasks(d)).toBe(1);
    expect(await jobs(d)).toEqual([]);
    expect((await outcomes(d))[0].customer_outcome).toBe("no_template");
    expect(await asAdmin((q) => count(q, "select 1 from app.collection_template_seeds where organization_id = $1", [o]))).toBe(2);
  });

  describe("second review: queued means expected to go out; the sweep's expiry, stages and locks", () => {
    let o: string;
    let boss: U;
    const PAUSED_LINE = "השליחה ללקוחות עצורה";
    const sweep = () => asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.cancel_settled_collection_messages($1::uuid[]) as n", [[o]])).n));
    const taskOf = (document: string) =>
      asAdmin(async (q) =>
        (await q<{ description: string | null }>("select description from public.tasks where collection_document_id = $1 and deleted_at is null", [document])).rows,
      );
    beforeAll(async () => {
      boss = await createUser("cc-second");
      o = await createOrg(boss.id, "עסק הסקירה השנייה");
      await addMember(o, boss.id, "member", "cc-w");
      await prepare(o, boss);
      await setSwitch(o, true, boss);
    });

    it("(1) no worker in the last day: nothing queued, outcome no_provider, the rep's task is made", async () => {
      const c = await contactWith(o, null, "noprov@example.com", boss);
      const d = await doc(0, { contact: c }, o, boss);
      await job(o, false);
      expect(await jobs(d)).toEqual([]);
      expect(await outcomes(d)).toEqual([{ offset_days: 0, customer_outcome: "no_provider", has_task: true }]);
    });

    it("(1) customer sending paused: nothing queued, outcome paused, the task carries the paused line", async () => {
      await run(boss, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [o]));
      try {
        const c = await contactWith(o, null, "paused@example.com", boss);
        const d = await doc(0, { contact: c }, o, boss);
        await job(o);
        expect(await jobs(d)).toEqual([]);
        expect(await outcomes(d)).toEqual([{ offset_days: 0, customer_outcome: "paused", has_task: true }]);
        expect((await taskOf(d))[0].description).toBe(PAUSED_LINE);
      } finally {
        await run(boss, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [o]));
      }
    });

    it("(1) a service-blocked address is not sent to: the next channel, else outcome blocked with the task", async () => {
      const c = await contactWith(o, null, "blocked@example.com", boss);
      await run(boss, (q) => q("select public.consent_blocklist_add($1, 'all', $2, 'person_request')", [o, ["blocked@example.com"]]));
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      expect(await jobs(d)).toEqual([]);
      expect(await outcomes(d)).toEqual([{ offset_days: 0, customer_outcome: "blocked", has_task: true }]);
      // the email is blocked, the phone is not: with sms the message goes by SMS even though email is preferred
      await features(o, { sms: true });
      try {
        const both = await contactWith(o, "0528888888", "blocked2@example.com", boss);
        await run(boss, (q) => q("update public.contacts set preferred_channel = 'email' where id = $1", [both]));
        await run(boss, (q) => q("select public.consent_blocklist_add($1, 'email', $2, 'person_request')", [o, ["blocked2@example.com"]]));
        const d2 = await doc(0, { contact: both }, o, boss);
        await job(o);
        expect((await jobs(d2))[0].payload.channel).toBe("sms");
      } finally {
        await features(o);
      }
    });

    it("lead's choice (question 284): a preferred channel without an active template falls to the next channel", async () => {
      await features(o, { sms: true });
      const smsTemplate = await asAdmin(
        async (q) =>
          (await one<{ id: string }>(q, "select id from public.message_templates where organization_id = $1 and notice_kind = 'collection_reminder' and channel = 'sms'", [o])).id,
      );
      await asAdmin((q) => q("update public.message_templates set is_active = false where id = $1", [smsTemplate]));
      try {
        const c = await contactWith(o, "0529999999", "fallback@example.com", boss);
        await run(boss, (q) => q("update public.contacts set preferred_channel = 'sms' where id = $1", [c]));
        const d = await doc(0, { contact: c }, o, boss);
        await job(o);
        expect((await jobs(d))[0].payload.channel).toBe("email");
      } finally {
        await asAdmin((q) => q("update public.message_templates set is_active = true where id = $1", [smsTemplate]));
        await features(o);
      }
    });

    it("(2) the sweep first cancels a waiting job whose event_at passed (refused:expired)", async () => {
      const c = await contactWith(o, null, "expired@example.com", boss);
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      const [queued] = await jobs(d);
      expect(queued.status).toBe("queued");
      // its debt is also settled: the expiry is judged first
      await run(boss, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [d]));
      await asAdmin((q) => q("update app.jobs set payload = jsonb_set(payload, '{event_at}', to_jsonb('2020-01-01T00:00:00Z'::text)) where id = $1", [queued.id]));
      await sweep();
      expect((await jobs(d))[0]).toMatchObject({ status: "refused", last_error: "refused:expired" });
      expect((await outcomes(d))[0].customer_outcome).toBe("cancelled");
    });

    it("(5) the sweep cancels a waiting job whose stage is no longer chosen (refused:stage_off)", async () => {
      const c = await contactWith(o, null, "stageoff@example.com", boss);
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      expect((await jobs(d))[0].status).toBe("queued");
      await setStages(o, [7, 14], boss);
      try {
        await sweep();
      } finally {
        await setStages(o, [0, 7, 14], boss);
      }
      expect((await jobs(d))[0]).toMatchObject({ status: "refused", last_error: "refused:stage_off" });
    });

    it("(3) a stage row another transaction holds is skipped, not waited for", async () => {
      const c = await contactWith(o, null, "locked@example.com", boss);
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      await run(boss, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [d]));
      const holder = new Client({ connectionString: TEST_DB_URL });
      await holder.connect();
      try {
        await holder.query("begin");
        await holder.query("select 1 from app.collection_reminders_sent where document_id = $1 for update", [d]);
        const started = Date.now();
        await sweep();
        expect(Date.now() - started).toBeLessThan(3000);
        expect((await jobs(d))[0].status).toBe("queued");
      } finally {
        await holder.query("rollback");
        await holder.end();
      }
      await sweep();
      expect((await jobs(d))[0]).toMatchObject({ status: "refused", last_error: "refused:debt_settled" });
    });
  });

  describe("third review: a message that never went out gets the stage's task; SMS only with room", () => {
    let o: string;
    let boss: U;
    const sweep = () => asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.cancel_settled_collection_messages($1::uuid[]) as n", [[o]])).n));
    const stageTask = (document: string) =>
      asAdmin(async (q) =>
        (
          await q<{ title: string; status: string }>(
            "select title, status::text as status from public.tasks where collection_document_id = $1 and deleted_at is null order by created_at",
            [document],
          )
        ).rows,
      );
    const setJob = (id: string, status: string, error: string | null) =>
      asAdmin((q) => q("update app.jobs set status = $2, last_error = $3, lease_id = null, locked_until = null, finished_at = now() where id = $1", [id, status, error]));
    const smsUsed = (used: number) =>
      asAdmin((q) =>
        q(
          `insert into app.sms_quota_months (organization_id, month, used)
           values ($1, date_trunc('month', (now() at time zone $2)::date)::date, $3)
           on conflict (organization_id, month) do update set used = excluded.used`,
          [o, zone, used],
        ),
      );
    beforeAll(async () => {
      boss = await createUser("cc-third");
      o = await createOrg(boss.id, "עסק הסקירה השלישית");
      await addMember(o, boss.id, "member", "cc-v");
      await prepare(o, boss);
      await setSwitch(o, true, boss);
    });

    it("(a) SMS is chosen only while the month's quota has room: else email, else outcome quota with the task", async () => {
      await features(o, { sms: true });
      await asAdmin((q) => q(`update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_sms_per_month": 2}'::jsonb where organization_id = $1`, [o]));
      try {
        // room: SMS
        await smsUsed(1);
        const room = await contactWith(o, "0531111111", "room@example.com", boss);
        const d1 = await doc(0, { contact: room }, o, boss);
        await job(o);
        expect((await jobs(d1))[0].payload.channel).toBe("sms");
        // used up: email; a phone only: quota, and the rep's task
        await smsUsed(2);
        const both = await contactWith(o, "0532222222", "full@example.com", boss);
        const phoneOnly = await contactWith(o, "0533333333", null, boss);
        const d2 = await doc(0, { contact: both }, o, boss);
        const d3 = await doc(0, { contact: phoneOnly }, o, boss);
        await job(o);
        expect((await jobs(d2))[0].payload.channel).toBe("email");
        expect(await jobs(d3)).toEqual([]);
        expect(await outcomes(d3)).toEqual([{ offset_days: 0, customer_outcome: "quota", has_task: true }]);
        // the plan's SMS off: email, a phone only has no address the plan reaches
        await features(o, { sms: false });
        const d4 = await doc(0, { contact: both }, o, boss);
        const d5 = await doc(0, { contact: phoneOnly }, o, boss);
        await job(o);
        expect((await jobs(d4))[0].payload.channel).toBe("email");
        expect((await outcomes(d5))[0]).toEqual({ offset_days: 0, customer_outcome: "no_address", has_task: true });
      } finally {
        await smsUsed(0);
        await features(o);
      }
    });

    it("(b) a message that ended dead or was refused by the queue gets the stage's task in the sweep, once", async () => {
      const c = await contactWith(o, null, "dead@example.com", boss);
      const dead = await doc(0, { contact: c }, o, boss);
      const refused = await doc(0, { contact: c }, o, boss);
      await job(o);
      expect(await stageTask(dead)).toEqual([]);
      await setJob((await jobs(dead))[0].id, "dead", "provider:error");
      await setJob((await jobs(refused))[0].id, "refused", "refused:service_blocked");
      await sweep();
      for (const d of [dead, refused]) {
        const [task, ...more] = await stageTask(d);
        expect(more).toEqual([]);
        expect(task).toMatchObject({ status: "open" });
        expect(task.title).toMatch(/· היום מועד התשלום$/);
        expect((await outcomes(d))[0].has_task).toBe(true);
      }
      expect((await outcomes(dead))[0].customer_outcome).toBe("dead");
      expect((await outcomes(refused))[0].customer_outcome).toBe("cancelled");
      // once: the next run and the next sweep make nothing more
      await job(o);
      await sweep();
      expect(await stageTask(dead)).toHaveLength(1);
    });

    it("final review 1: a stage-0 job claimed, then stage 7 handled, then the stage-0 job dies: no task change, no new task", async () => {
      const c = await contactWith(o, null, "later@example.com", boss);
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      const [zero] = await jobs(d);
      // the worker claims it
      await asAdmin((q) => q("update app.jobs set status = 'running', lease_id = gen_random_uuid(), locked_until = now() + interval '5 minutes' where id = $1", [zero.id]));
      await sweep();
      expect((await outcomes(d))[0]).toEqual({ offset_days: 0, customer_outcome: "queued", has_task: false });
      // the +7 stage of the same due date is handled meanwhile (here: its row, as the job leaves it with a task)
      const tasksBefore = await stageTask(d);
      await asAdmin((q) =>
        q(
          `insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, done_at, customer_outcome)
           select organization_id, document_id, due_date, 7, now(), 'sent' from app.collection_reminders_sent
            where document_id = $1 and offset_days = 0`,
          [d],
        ),
      );
      await setJob(zero.id, "dead", "provider:error");
      await sweep();
      expect(await stageTask(d)).toEqual(tasksBefore);
      expect((await outcomes(d)).find((r) => r.offset_days === 0)).toEqual({ offset_days: 0, customer_outcome: "dead", has_task: false });
    });

    it("final review 2: a backstop that raises is counted and tried again; after 3 failures the row ends failed", async () => {
      const c = await contactWith(o, null, "boom@example.com", boss);
      const d = await doc(0, { contact: c }, o, boss);
      await job(o);
      const [queued] = await jobs(d);
      await setJob(queued.id, "dead", "provider:error");
      const row = () =>
        asAdmin(async (q) =>
          (
            await one<{ outcome: string; failures: number; task: string | null }>(
              q,
              "select customer_outcome as outcome, customer_task_failures as failures, task_id as task from app.collection_reminders_sent where document_id = $1",
              [d],
            )
          ),
        );
      // every task insert for this document fails, inside one transaction (the trigger is gone again when it commits)
      const states = await asAdmin(async (q) => {
        await q(
          `create function public.zz_test_tasks_boom() returns trigger language plpgsql as $f$
           begin
             if new.collection_document_id = '${d}'::uuid then raise exception 'boom'; end if;
             return new;
           end $f$`,
        );
        await q("create trigger zz_test_tasks_boom before insert on public.tasks for each row execute function public.zz_test_tasks_boom()");
        const seen: { outcome: string; failures: number }[] = [];
        for (let i = 0; i < 4; i++) {
          await q("select app.cancel_settled_collection_messages($1::uuid[])", [[o]]);
          seen.push(
            (
              await one<{ outcome: string; failures: number }>(
                q,
                "select customer_outcome as outcome, customer_task_failures as failures from app.collection_reminders_sent where document_id = $1",
                [d],
              )
            ),
          );
        }
        await q("drop trigger zz_test_tasks_boom on public.tasks");
        await q("drop function public.zz_test_tasks_boom()");
        return seen;
      });
      expect(states).toEqual([
        { outcome: "queued", failures: 1 },
        { outcome: "queued", failures: 2 },
        { outcome: "failed", failures: 3 },
        { outcome: "failed", failures: 3 },
      ]);
      // given up: no task, and later sweeps leave it
      await sweep();
      expect(await row()).toEqual({ outcome: "failed", failures: 3, task: null });
      expect(await stageTask(d)).toEqual([]);
    });

    it("(b) a message held past its time (cancelled by the sweep as expired) gets the stage's task; a paid one does not", async () => {
      const c = await contactWith(o, null, "late@example.com", boss);
      const live = await doc(0, { contact: c }, o, boss);
      const paid = await doc(0, { contact: c }, o, boss);
      await job(o);
      await asAdmin(async (q) => {
        for (const d of [live, paid]) {
          const id = (await one<{ id: string }>(q, "select id from app.jobs where payload ->> 'collection_document_id' = $1", [d])).id;
          await q("update app.jobs set payload = jsonb_set(payload, '{event_at}', to_jsonb('2020-01-01T00:00:00Z'::text)) where id = $1", [id]);
        }
      });
      await run(boss, async (q) => {
        const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 1000, current_date, 'cash') returning id", [o, c]);
        await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 1000)", [o, p.id, paid]);
      });
      await sweep();
      expect((await jobs(live))[0]).toMatchObject({ status: "refused", last_error: "refused:expired" });
      expect(await stageTask(live)).toHaveLength(1);
      expect((await jobs(paid))[0]).toMatchObject({ status: "refused", last_error: "refused:expired" });
      expect(await stageTask(paid)).toEqual([]);
    });

    it("(b) no task when the message was superseded, or cancelled as reminder_off, stage_off, customer_changed or business_off", async () => {
      const c = await contactWith(o, null, "notask@example.com", boss);
      // superseded: the -3 stage's message is replaced by the due date's
      await setStages(o, [-3, 0, 7, 14], boss);
      const sup = await doc(3, { contact: c }, o, boss);
      await job(o);
      await setDue(sup, 0);
      await job(o);
      await sweep();
      expect((await jobs(sup))[0]).toMatchObject({ status: "refused", last_error: "refused:superseded" });
      expect(await stageTask(sup)).toEqual([]);
      await setStages(o, [0, 7, 14], boss);

      // stage_off
      const off = await doc(0, { contact: c }, o, boss);
      await job(o);
      await setStages(o, [7, 14], boss);
      await sweep();
      await setStages(o, [0, 7, 14], boss);
      expect((await jobs(off))[0].last_error).toBe("refused:stage_off");
      expect(await stageTask(off)).toEqual([]);

      // customer_changed
      const other = await contactWith(o, null, "other@example.com", boss);
      const deal = await run(boss, async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id)
             select $1, 'עסקה', p.id, (select s.id from public.stages s where s.pipeline_id = p.id order by s.position, s.id limit 1), $2
               from public.pipelines p where p.organization_id = $1 and p.deleted_at is null order by p.position, p.id limit 1
             returning id`,
            [o, c],
          )
        ).id,
      );
      const moved = await doc(0, { deal }, o, boss);
      await job(o);
      await run(boss, (q) => q("update public.deals set contact_id = $2 where id = $1", [deal, other]));
      await sweep();
      expect((await jobs(moved))[0].last_error).toBe("refused:customer_changed");
      expect(await stageTask(moved)).toEqual([]);

      // business_off
      const keys = await doc(0, { contact: c }, o, boss);
      await job(o);
      await features(o, { collection: false });
      try {
        await sweep();
      } finally {
        await features(o);
      }
      expect((await jobs(keys))[0].last_error).toBe("refused:business_off");
      expect(await stageTask(keys)).toEqual([]);

      // reminder_off (the switch's own trigger cancels)
      const sw = await doc(0, { contact: c }, o, boss);
      await job(o);
      await setSwitch(o, false, boss);
      await sweep();
      await setSwitch(o, true, boss);
      expect((await jobs(sw))[0].last_error).toBe("refused:reminder_off");
      expect(await stageTask(sw)).toEqual([]);
    });
  });

  it("the payload rule: collection_document_id only on a collection message to a contact, by SMS or email", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const ok = (payload: Record<string, unknown>) =>
      asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('message.send', $1::jsonb) as ok", [JSON.stringify(payload)])).ok);
    const base = { channel: "email", message_type: "collection", template_id: id, contact_id: id, collection_document_id: id };
    expect(await ok(base)).toBe(true);
    expect(await ok({ ...base, channel: "sms" })).toBe(true);
    expect(await ok({ ...base, channel: "whatsapp" })).toBe(false);
    expect(await ok({ ...base, message_type: "requested_document" })).toBe(false);
    expect(await ok({ channel: "email", message_type: "collection", template_id: id, lead_id: id, collection_document_id: id })).toBe(false);
    expect(await ok({ ...base, collection_document_id: "x" })).toBe(false);
    expect(await ok({ channel: "sms", message_type: "verification_code", sender_check_id: id, collection_document_id: id })).toBe(false);
    // the keys before are unchanged
    expect(await ok({ channel: "email", message_type: "requested_document", contact_id: id, signature_document_id: id })).toBe(true);
  });

  it("the templates' mark keeps every earlier value (021225's instant replies) and adds collection_reminder", async () => {
    const def = await asAdmin(
      async (q) =>
        (
          await one<{ d: string }>(
            q,
            "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'message_templates_notice_kind_check' and conrelid = 'public.message_templates'::regclass",
          )
        ).d,
    );
    for (const kind of [
      "punch_card_low",
      "punch_card_expiry",
      "meeting_confirm",
      "meeting_moved",
      "meeting_day",
      "meeting_hour",
      "signature_reminder",
      "instant_reply_open",
      "instant_reply_closed",
      "collection_reminder",
    ]) {
      expect(def, kind).toContain(`'${kind}'`);
    }
  });

  it("the new functions are for the server only", async () => {
    for (const fn of [
      "app.collection_customer_message(uuid, uuid, uuid, uuid, date, integer, date, text)",
      "app.collection_customer_cancel(uuid, uuid, text, text)",
      "app.collection_customer_refusal(uuid, uuid, uuid, integer)",
      "app.collection_message_worker_seen()",
      "app.collection_sms_room(uuid)",
      "app.collection_stage_task(uuid, uuid, text, text, uuid, uuid, uuid, date, date, date, text)",
      "app.collection_stage_task_backstop(uuid, uuid, date, integer)",
      "app.collection_stage_task_try(uuid, uuid, uuid, date, integer)",
      "app.cancel_settled_collection_messages(uuid[])",
      "app.seed_collection_reminder_templates(uuid)",
      "app.org_document_settings_collection_reminder_off()",
    ]) {
      const grants = await asAdmin(async (q) =>
        (
          await one<{ a: boolean; s: boolean }>(
            q,
            "select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('service_role', $1, 'execute') as s",
            [fn],
          )
        ),
      );
      expect(grants, fn).toEqual({ a: false, s: false });
    }
  });
});
