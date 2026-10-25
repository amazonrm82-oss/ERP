import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PAY-04: each cheque is its own payment; its status sets the payment's; whoever records payments moves it, only owners and
 * admins correct its details or take it back from "bounced" (with a reason); a reminder on its due date from 08:00; an
 * erasure empties its number, a foreign bank's name and the unbounce reason.
 */
describe("cheques (PAY-04)", () => {
  let owner: U, manager: U;
  let org: string;
  let contact: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const cheque = (u: U, fields: Partial<Record<string, string | null>> = {}, on: string = contact) =>
    run(u, async (q) => {
      const f = { cheque_number: String(1000 + ++n), cheque_bank: "12", cheque_bank_name: null, cheque_branch: "601", cheque_due_date: "2026-12-01", cheque_status: "in_hand", ...fields };
      return (
        await one<{ id: string; status: string }>(
          q,
          `insert into public.payments (organization_id, contact_id, amount_agorot, method, cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status)
           values ($1, $2, 25000, 'cheque', $3, $4, $5, $6, $7, $8) returning id, status`,
          [org, on, f.cheque_number, f.cheque_bank, f.cheque_bank_name, f.cheque_branch, f.cheque_due_date, f.cheque_status],
        )
      );
    });
  const row = (id: string) =>
    asAdmin((q) =>
      one<{ status: string; cheque_status: string; cheque_number: string | null; cheque_bank: string | null; cheque_bank_name: string | null; cheque_branch: string | null; cheque_unbounce_reason: string | null }>(
        q,
        "select status, cheque_status, cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_unbounce_reason from public.payments where id = $1",
        [id],
      ),
    );
  const setCheque = (u: U, id: string, status: string, reason: string | null = null) =>
    run(u, (q) => q("update public.payments set cheque_status = $2, cheque_unbounce_reason = coalesce($3, cheque_unbounce_reason) where id = $1", [id, status, reason]));

  beforeAll(async () => {
    owner = await createUser("chq-owner");
    org = await createOrg(owner.id, "עסק הצ'קים");
    manager = await addMember(org, owner.id, "manager", "chq-manager");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ payments: true })]));
    contact = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'רונית') returning id", [org])).id);
  });

  it("a cheque carries its details; the bank comes from the list, the branch is 3 digits; other methods carry none", async () => {
    expect((await pgError(cheque(owner, { cheque_number: null }))).hint).toBe("cheque:fields");
    expect((await pgError(cheque(owner, { cheque_branch: null }))).hint).toBe("cheque:fields");
    expect((await pgError(cheque(owner, { cheque_bank: "99" }))).hint).toBe("cheque:bank");
    expect((await pgError(cheque(owner, { cheque_branch: "61" }))).hint).toBe("cheque:branch");
    expect((await pgError(cheque(owner, { cheque_bank: "other", cheque_branch: null }))).hint).toBe("cheque:fields");
    const foreign = await cheque(owner, { cheque_bank: "other", cheque_bank_name: "Bank of America", cheque_branch: null });
    expect(await row(foreign.id)).toMatchObject({ cheque_bank: "other", cheque_bank_name: "Bank of America", cheque_branch: null });
    // a listed bank keeps no foreign name
    const listed = await cheque(owner, { cheque_bank_name: "שם מיותר" });
    expect((await row(listed.id)).cheque_bank_name).toBeNull();
    const cash = await pgError(
      run(owner, (q) => q("insert into public.payments (organization_id, contact_id, amount_agorot, method, cheque_number) values ($1, $2, 100, 'cash', '1')", [org, contact])),
    );
    expect(cash.code).toBe("23514");
    // a cheque payment recorded before PAY-04 (no details) still stands and moves as before
    const legacy = await asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 100, 'cheque') returning id", [org, contact])).id,
    );
    await run(manager, (q) => q("update public.payments set status = 'confirmed' where id = $1", [legacy]));
    expect((await row(legacy)).status).toBe("confirmed");
  });

  it("the cheque's status sets the payment's; a bounced cheque fails the payment and writes it on the timeline", async () => {
    expect((await cheque(owner, { cheque_status: "in_hand" })).status).toBe("recorded");
    expect((await cheque(owner, { cheque_status: "deposited" })).status).toBe("recorded");
    expect((await cheque(owner, { cheque_status: "cleared" })).status).toBe("confirmed");
    // a new payment is never failed
    expect((await pgError(cheque(owner, { cheque_status: "bounced" }))).hint).toBe("payment:status");
    const c = await cheque(manager);
    await setCheque(manager, c.id, "deposited");
    expect((await row(c.id)).status).toBe("recorded");
    await setCheque(manager, c.id, "cleared");
    expect((await row(c.id)).status).toBe("confirmed");
    // the payment's status is not set directly
    expect((await pgError(run(manager, (q) => q("update public.payments set status = 'failed' where id = $1", [c.id])))).hint).toBe("cheque:status");
    await setCheque(manager, c.id, "bounced");
    expect(await row(c.id)).toMatchObject({ status: "failed", cheque_status: "bounced" });
    // DOC-04 follow-up: the failed payment is on the timeline
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where metadata ->> 'kind' = 'payment_failed' and metadata ->> 'payment_id' = $1", [c.id]))).toBe(1);
  });

  it("only owners and admins correct a cheque or take it back from bounced, with a reason kept in the audit", async () => {
    const c = await cheque(manager);
    expect((await pgError(run(manager, (q) => q("update public.payments set cheque_branch = '602' where id = $1", [c.id])))).hint).toBe("payment:correction");
    await run(owner, (q) => q("update public.payments set cheque_branch = '602' where id = $1", [c.id]));
    expect((await row(c.id)).cheque_branch).toBe("602");
    await setCheque(manager, c.id, "bounced");
    expect((await pgError(setCheque(manager, c.id, "in_hand", "טעות"))).hint).toBe("cheque:bounced");
    expect((await pgError(setCheque(owner, c.id, "in_hand"))).hint).toBe("cheque:reason");
    // a reason without leaving bounced is refused
    expect((await pgError(run(owner, (q) => q("update public.payments set cheque_unbounce_reason = 'x' where id = $1", [c.id])))).hint).toBe("cheque:reason");
    await setCheque(owner, c.id, "deposited", "הבנק החזיר בטעות");
    expect(await row(c.id)).toMatchObject({ status: "recorded", cheque_status: "deposited", cheque_unbounce_reason: "הבנק החזיר בטעות" });
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'payments' and entity_id = $1 and changes::text like '%הבנק החזיר בטעות%'", [c.id])),
    ).toBe(1);
    // a second bounce needs a new reason to come back
    await setCheque(manager, c.id, "bounced");
    expect((await pgError(setCheque(owner, c.id, "in_hand", "הבנק החזיר בטעות"))).hint).toBe("cheque:reason");
  });

  it("a cancelled or refunded payment keeps its cheque, for every writer", async () => {
    const c = await cheque(manager);
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [c.id]));
    expect((await pgError(setCheque(manager, c.id, "deposited"))).hint).toBe("payment:cancelled");
    expect((await pgError(setCheque(owner, c.id, "bounced"))).hint).toBe("payment:cancelled");
    expect((await pgError(run(owner, (q) => q("update public.payments set cheque_number = '9' where id = $1", [c.id])))).hint).toBe("payment:cancelled");
    expect((await pgError(asAdmin((q) => q("update public.payments set cheque_due_date = '2027-01-01' where id = $1", [c.id])))).hint).toBe("payment:cancelled");
    expect(await row(c.id)).toMatchObject({ status: "cancelled", cheque_status: "in_hand" });

    const r = await cheque(manager, { cheque_status: "cleared" });
    await run(owner, (q) => q("update public.payments set status = 'refunded' where id = $1", [r.id]));
    expect((await pgError(setCheque(owner, r.id, "bounced"))).hint).toBe("cheque:refunded");
    expect((await pgError(run(owner, (q) => q("update public.payments set cheque_branch = '603' where id = $1", [r.id])))).hint).toBe("cheque:refunded");
    expect((await pgError(asAdmin((q) => q("update public.payments set cheque_status = 'in_hand' where id = $1", [r.id])))).hint).toBe("cheque:refunded");
    expect(await row(r.id)).toMatchObject({ status: "refunded", cheque_status: "cleared" });
  });

  it("a write naming only the cheque's status emits payment_confirmed when it clears", async () => {
    const c = await cheque(manager);
    const events = () =>
      asAdmin(async (q) =>
        (await q<{ entity_type: string }>("select entity_type from public.outbox_events where event_type = 'payment_confirmed' and payload ->> 'payment_id' = $1", [c.id])).rows.map(
          (e) => e.entity_type,
        ),
      );
    await run(manager, (q) => q("update public.payments set cheque_status = 'deposited' where id = $1", [c.id]));
    expect(await events()).toEqual([]);
    await run(manager, (q) => q("update public.payments set cheque_status = 'cleared' where id = $1", [c.id]));
    expect((await row(c.id)).status).toBe("confirmed");
    expect(await events()).toEqual(["contact"]);
    // an unrelated write on the confirmed payment emits nothing more
    await run(owner, (q) => q("update public.payments set note = 'הערה' where id = $1", [c.id]));
    expect(await events()).toEqual(["contact"]);
  });

  it("PAY-02: a bounced cheque releases its allocations and the invoice is unpaid again; leaving bounced does not revive them", async () => {
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ payments: true, documents: true })]));
    const invoice = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', $3, 25000) returning id",
          [org, contact, `INV-${++n}`],
        )
      ).id,
    );
    const c = await cheque(manager, { cheque_status: "deposited" });
    const allocation = await run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 25000) returning id", [
          org,
          c.id,
          invoice,
        ])
      ).id,
    );
    type DocState = { id: string; paid: number; balance: number; state: string };
    type PayState = { id: string; allocated: number; credit: number };
    const state = () =>
      run(owner, async (q) => (await one<{ s: { documents: DocState[]; payments: PayState[] } }>(q, "select public.money_allocation_state($1, $2, $3) as s", [org, [invoice], [c.id]])).s);
    const released = () => asAdmin(async (q) => (await one<{ released_at: string | null }>(q, "select released_at from public.payment_allocations where id = $1", [allocation])).released_at);
    const before = await state();
    expect(before.documents[0]).toMatchObject({ paid: 25000, balance: 0, state: "paid" });

    // only the cheque's status is written; the payment fails through the cheque trigger and its allocation is released
    await run(manager, (q) => q("update public.payments set cheque_status = 'bounced' where id = $1", [c.id]));
    expect((await row(c.id)).status).toBe("failed");
    expect(await released()).not.toBeNull();
    const bounced = await state();
    expect(bounced.documents[0]).toMatchObject({ paid: 0, balance: 25000, state: "unpaid" });

    // taken back from bounced: the payment counts again, but its old allocation stays released (allocate it again by hand)
    await setCheque(owner, c.id, "deposited", "הופקד שוב");
    expect((await row(c.id)).status).toBe("recorded");
    expect(await released()).not.toBeNull();
    const back = await state();
    expect(back.documents[0]).toMatchObject({ paid: 0, balance: 25000, state: "unpaid" });
    expect(back.payments[0]).toMatchObject({ allocated: 0, credit: 25000 });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ payments: true })]));
  });

  it("a series is N payments made by one insert", async () => {
    const ids = await run(manager, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.payments (organization_id, contact_id, amount_agorot, method, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status)
           select $1, $2, 10000, 'cheque', (5000 + g)::text, '10', '800', date '2026-11-01' + (g || ' month')::interval, 'in_hand' from generate_series(0, 2) g
           returning id`,
          [org, contact],
        )
      ).rows.map((r) => r.id),
    );
    expect(ids).toHaveLength(3);
  });

  it("reminds on the due date from 08:00 in the business's zone, once, to the recorder (else owners and admins)", async () => {
    // a zone where it is already after 09:00 today, and one where it is not yet 08:00
    const zones = await asAdmin(
      async (q) =>
        (
          await q<{ late: string | null; early: string | null }>(
            `select (select name from pg_timezone_names where name like 'Etc/GMT%' and extract(hour from now() at time zone name) between 9 and 22 order by name limit 1) as late,
                    (select name from pg_timezone_names where name like 'Etc/GMT%' and extract(hour from now() at time zone name) between 0 and 6 order by name limit 1) as early`,
          )
        ).rows[0],
    );
    const today = (zone: string) => asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d", [zone])).d);
    const notices = (id: string) => asAdmin((q) => count(q, "select 1 from public.notifications where type = 'payment' and organization_id = $1 and body like $2", [org, `%${id}%`]));
    const run_ = () => asAdmin((q) => q("select app.send_cheque_reminders()"));

    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zones.late]));
    const due = await cheque(manager, { cheque_due_date: await today(zones.late!), cheque_number: "770001" });
    const cleared = await cheque(manager, { cheque_due_date: await today(zones.late!), cheque_number: "770002", cheque_status: "cleared" });
    const byOwner = await cheque(owner, { cheque_due_date: await today(zones.late!), cheque_number: "770003" });
    await run_();
    await run_();
    expect(await notices("770001")).toBe(1);
    expect(await notices("770002")).toBe(0);
    const recipient = await asAdmin((q) => one<{ user_id: string; title: string; entity_type: string }>(q, "select user_id, title, entity_type from public.notifications where body like '%770001%'"));
    expect(recipient).toMatchObject({ user_id: manager.id, title: "צ'ק לפירעון היום", entity_type: "contact" });
    expect(await notices("770003")).toBe(1);
    void due;
    void cleared;
    void byOwner;

    // before 08:00 there, nothing yet
    if (zones.early) {
      await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zones.early]));
      await cheque(manager, { cheque_due_date: await today(zones.early), cheque_number: "770005" });
      await run_();
      expect(await notices("770005")).toBe(0);
      await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zones.late]));
    }

    // the recorder is no longer an active member: the owners and admins are told (last: the manager stays suspended)
    await cheque(manager, { cheque_due_date: await today(zones.late!), cheque_number: "770004" });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, manager.id]));
    await run_();
    const to = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where body like '%770004%'")).rows.map((r) => r.user_id));
    expect(to).toEqual([owner.id]);
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
  });
  it("an erasure empties the cheque's number, a foreign bank's name and the unbounce reason", async () => {
    const person = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'למחיקה') returning id", [org])).id);
    const foreign = await cheque(owner, { cheque_bank: "other", cheque_bank_name: "Bank of Dana", cheque_branch: null }, person);
    const back = await cheque(owner, {}, person);
    await setCheque(owner, back.id, "bounced");
    await setCheque(owner, back.id, "in_hand", "דנה הסבירה");
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [person]);
      await q("delete from public.contacts where id = $1", [person]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, person]));
    expect(await row(foreign.id)).toMatchObject({ cheque_number: null, cheque_bank: "other", cheque_bank_name: null });
    expect(await row(back.id)).toMatchObject({ cheque_number: null, cheque_bank: "12", cheque_branch: "601", cheque_unbounce_reason: null });
  });

  it("cancelled and refunded cheques let the server's purge, erasure and merge through", async () => {
    const pipe = await defaultPipeline(org);
    const newContact = (name: string) =>
      run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).id);
    const pair = async (on: string) => {
      const deal = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
            [org, pipe.pipelineId, pipe.stages.find((s) => s.kind === "open")!.id, on, owner.id],
          )
        ).id,
      );
      const make = (fields: Partial<Record<string, string | null>>) =>
        run(owner, async (q) =>
          (
            await one<{ id: string }>(
              q,
              `insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method, cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status)
               values ($1, $2, $3, 25000, 'cheque', $4, $5, $6, $7, '2026-12-01', $8) returning id`,
              [org, deal, on, fields.cheque_number, fields.cheque_bank, fields.cheque_bank_name ?? null, fields.cheque_branch ?? null, fields.cheque_status ?? "in_hand"],
            )
          ).id,
        );
      const cancelled = await make({ cheque_number: String(990000 + ++n), cheque_bank: "other", cheque_bank_name: "Bank of Probe" });
      await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [cancelled]));
      const refunded = await make({ cheque_number: String(990000 + ++n), cheque_bank: "12", cheque_branch: "601", cheque_status: "cleared" });
      await run(owner, (q) => q("update public.payments set status = 'refunded' where id = $1", [refunded]));
      return { deal, cancelled, refunded };
    };
    const contactOf = (id: string) => asAdmin(async (q) => (await one<{ contact_id: string | null }>(q, "select contact_id from public.payments where id = $1", [id])).contact_id);

    // (1) purging the contact: the FK set-null passes; (2) its erasure passes and empties the number and the bank's name
    const person = await newContact("בדיקה");
    const a = await pair(person);
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [person]);
      await q("delete from public.contacts where id = $1", [person]);
    });
    expect(await contactOf(a.cancelled)).toBeNull();
    expect(await contactOf(a.refunded)).toBeNull();
    expect(await row(a.cancelled)).toMatchObject({ status: "cancelled", cheque_status: "in_hand", cheque_bank_name: "Bank of Probe" });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, person]));
    expect(await row(a.cancelled)).toMatchObject({ status: "cancelled", cheque_status: "in_hand", cheque_number: null, cheque_bank: "other", cheque_bank_name: null });
    expect(await row(a.refunded)).toMatchObject({ status: "refunded", cheque_status: "cleared", cheque_number: null, cheque_bank: "12", cheque_branch: "601" });

    // (3) merging a duplicate contact that holds a cancelled and a refunded cheque: they move to the kept contact
    const keep = await newContact("שמור");
    const dup = await newContact("כפול");
    const b = await pair(dup);
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await contactOf(b.cancelled)).toBe(keep);
    expect(await contactOf(b.refunded)).toBe(keep);
    expect(await row(b.cancelled)).toMatchObject({ status: "cancelled", cheque_status: "in_hand", cheque_bank_name: "Bank of Probe" });
    expect(await row(b.refunded)).toMatchObject({ status: "refunded", cheque_status: "cleared" });
  });

  it("an erasure takes the cheque's number out of its due-date reminders", async () => {
    const late = await asAdmin(async (q) =>
      (
        await one<{ late: string }>(
          q,
          "select name as late from pg_timezone_names where name like 'Etc/GMT%' and extract(hour from now() at time zone name) between 9 and 22 order by name limit 1",
        )
      ).late,
    );
    const today = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d", [late])).d);
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, late]));
    const pipe = await defaultPipeline(org);
    const person = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'תזכורת') returning id", [org])).id);
    const deal = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקת צ''קים', $2, $3, $4, $5) returning id",
          [org, pipe.pipelineId, pipe.stages.find((s) => s.kind === "open")!.id, person, owner.id],
        )
      ).id,
    );
    const onDeal = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status)
           values ($1, $2, $3, 25000, 'cheque', '880001', '12', '601', $4, 'in_hand') returning id`,
          [org, deal, person, today],
        )
      ).id,
    );
    // another customer's cheque due the same day keeps its number
    const other = await cheque(owner, { cheque_number: "880002", cheque_due_date: today });
    await asAdmin((q) => q("select app.send_cheque_reminders()"));
    const bodies = () =>
      asAdmin(async (q) =>
        (await q<{ body: string; entity_id: string }>("select body, entity_id from public.notifications where organization_id = $1 and title = 'צ''ק לפירעון היום' and entity_id = any($2)", [org, [deal, contact]])).rows,
      );
    expect((await bodies()).map((b) => b.body).sort()).toEqual(expect.arrayContaining([expect.stringContaining("880001"), expect.stringContaining("880002")]));
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [person]);
      await q("delete from public.contacts where id = $1", [person]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, person]));
    const after = await bodies();
    const onDealBodies = after.filter((b) => b.entity_id === deal).map((b) => b.body);
    expect(onDealBodies.length).toBeGreaterThan(0);
    for (const body of onDealBodies) {
      expect(body).not.toContain("880001");
      expect(body).toMatch(/^צ'ק · /);
    }
    expect(after.filter((b) => b.entity_id === contact).map((b) => b.body).some((b) => b.includes("880002"))).toBe(true);
    expect((await row(onDeal)).cheque_number).toBeNull();
    expect((await row(other.id)).cheque_number).toBe("880002");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
  });
});
