import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTION_REMINDER_DRAFT_TEXT, COLLECTION_REMINDER_OFFSETS, COLLECTION_REMINDER_STAGES, collectionReminderOffset } from "../../src/features/collection/reminders";
import { COLLECTION_REMINDER_KIND } from "../../src/features/whatsapp/templates";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Task = { id: string; title: string; owner_id: string | null; contact_id: string | null; status: string; collection_document_id: string };

/**
 * COL-04: a reminder task for the rep 3 days before the due date, on it, and 7 and 14 days after (calendar days, business zone,
 * from 08:00), once per document, due date and offset; held while a COL-03 promise holds; nothing for a paid or cancelled
 * document, a billed proforma, a business that is not writable or without the plan keys. One open task per document.
 */
describe("collection reminders (COL-04)", () => {
  let owner: U, member: U;
  let org: string;
  let contact: string;
  let zone: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, collection: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const job = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.send_collection_reminders($1::uuid[]) as n", [[org]])).n);
  /** an invoice due k days from the business's today (the server sets the due date) */
  const doc = async (k: number, type = "tax_invoice", amount = 1000) => {
    const id = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, $3, $4, current_date - 40, $5) returning id",
          [org, contact, type, `CR-${++n}`, amount],
        )
      ).id,
    );
    await setDue(id, k);
    return id;
  };
  const setDue = (id: string, k: number) =>
    asAdmin((q) => q("update public.accounting_documents set due_date = (now() at time zone $2)::date + $3::integer where id = $1", [id, zone, k]));
  const tasks = (document: string) =>
    asAdmin(async (q) =>
      (
        await q<Task>(
          "select id, title, owner_id, contact_id, status, collection_document_id from public.tasks where organization_id = $1 and collection_document_id = $2 and deleted_at is null order by created_at, id",
          [org, document],
        )
      ).rows,
    );
  const sent = (document: string) =>
    asAdmin(async (q) =>
      (await q<{ offset_days: number; task_id: string | null }>("select offset_days, task_id from app.collection_reminders_sent where document_id = $1 order by offset_days", [document])).rows,
    );

  beforeAll(async () => {
    owner = await createUser("cr-owner");
    org = await createOrg(owner.id, "עסק הגבייה");
    member = await addMember(org, owner.id, "member", "cr-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    // a zone where it is now between 08:00 and 23:59, so the job's 08:00 rule passes whenever the test runs
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
    contact = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'חייב', $2) returning id", [org, member.id])).id);
  });

  it("the schedule is the same in SQL and TS: the latest offset reached, for 7 days", async () => {
    const days = Array.from({ length: 45 }, (_, i) => i - 12);
    const sql = await asAdmin(async (q) =>
      (await q<{ d: number; k: number | null }>("select d, app.collection_reminder_offset(date '2026-11-16', date '2026-11-16' + d) as k from unnest($1::integer[]) d order by d", [days])).rows,
    );
    const ts = days.map((d) => {
      const today = new Date(Date.UTC(2026, 10, 16 + d)).toISOString().slice(0, 10);
      return { d, k: collectionReminderOffset("2026-11-16", today) };
    });
    expect(sql).toEqual(ts);
    expect(ts.filter((r) => r.k !== null).map((r) => r.d)).toEqual(Array.from({ length: 24 }, (_, i) => i - 3));
    expect(collectionReminderOffset("2026-11-16", "2026-11-12")).toBeNull();
    expect(collectionReminderOffset("2026-11-16", "2026-12-07")).toBeNull();
    const stages = await asAdmin(async (q) =>
      (await q<{ k: number; s: string }>("select k, app.collection_reminder_stage(k) as s from unnest(app.collection_reminder_offsets()) k")).rows,
    );
    expect(stages).toEqual(COLLECTION_REMINDER_OFFSETS.map((k) => ({ k, s: COLLECTION_REMINDER_STAGES[k] })));
  });

  it("makes one task for the rep on the due date, once; no amount and no name in the title", async () => {
    const invoice = await doc(0);
    const before = await job();
    expect(before).toBeGreaterThanOrEqual(1);
    const made = await tasks(invoice);
    expect(made).toEqual([
      { id: expect.any(String), title: expect.stringMatching(/^תזכורת גבייה: חשבונית מס CR-\d+ · היום מועד התשלום$/), owner_id: member.id, contact_id: contact, status: "open", collection_document_id: invoice },
    ]);
    expect(made[0].title).not.toMatch(/₪|חייב/);
    // the rep is told it was assigned (an ordinary task notice)
    expect(
      await asAdmin(async (q) => (await q("select 1 from public.notifications where organization_id = $1 and user_id = $2 and entity_type = 'task' and entity_id = $3", [org, member.id, made[0].id])).rowCount),
    ).toBe(1);
    await job();
    expect(await tasks(invoice)).toHaveLength(1);
    expect(await sent(invoice)).toEqual([{ offset_days: 0, task_id: made[0].id }]);
  });

  it("3 days before; nothing earlier, nothing a week after the last reminder", async () => {
    const early = await doc(3);
    const tooEarly = await doc(5);
    const old = await doc(-30);
    await job();
    expect((await tasks(early))[0].title).toMatch(/· בעוד 3 ימים מועד התשלום$/);
    expect(await tasks(tooEarly)).toEqual([]);
    expect(await tasks(old)).toEqual([]);
    expect(await sent(old)).toEqual([]);
  });

  it("the next reminder moves a still-open task; a done task gets a new one", async () => {
    const invoice = await doc(0);
    await job();
    const [first] = await tasks(invoice);
    await setDue(invoice, -7);
    await job();
    const moved = await tasks(invoice);
    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe(first.id);
    expect(moved[0].title).toMatch(/· 7 ימים אחרי מועד התשלום$/);
    await run(member, (q) => q("update public.tasks set status = 'done' where id = $1", [first.id]));
    await setDue(invoice, -14);
    await job();
    const after = await tasks(invoice);
    expect(after).toHaveLength(2);
    expect(after[1].title).toMatch(/· 14 ימים אחרי מועד התשלום$/);
    expect(after[1].status).toBe("open");
  });

  it("a promise holds the reminder; the day after the promise it comes", async () => {
    const invoice = await doc(0);
    const promise = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, (now() at time zone $3)::date) returning id", [org, invoice, zone])).id,
    );
    await job();
    expect(await tasks(invoice)).toEqual([]);
    expect(await sent(invoice)).toEqual([]);
    // the promised day passed (the server moves it)
    await asAdmin((q) => q("update public.payment_promises set promised_date = (now() at time zone $2)::date - 1 where id = $1", [promise, zone]));
    await job();
    expect(await tasks(invoice)).toHaveLength(1);
  });

  it("nothing for a paid or cancelled document or a billed proforma", async () => {
    const paid = await doc(0, "tax_invoice", 400);
    await run(owner, async (q) => {
      const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 400, current_date, 'cash') returning id", [org, contact]);
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 400)", [org, p.id, paid]);
    });
    const cancelled = await doc(0);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    const proforma = await doc(0, "proforma");
    await run(owner, (q) =>
      q(
        "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, proforma_id) values ($1, $2, 'tax_invoice', $3, current_date, 1000, $4)",
        [org, contact, `CR-${++n}`, proforma],
      ),
    );
    await job();
    for (const d of [paid, cancelled, proforma]) expect(await tasks(d), d).toEqual([]);
  });

  it("nothing while the business is read-only or without the collection key; it catches up after", async () => {
    const invoice = await doc(0);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await job();
      expect(await tasks(invoice)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, collection: false })]));
    try {
      await job();
      expect(await tasks(invoice)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    await job();
    expect(await tasks(invoice)).toHaveLength(1);
  });

  it("a rep who is no longer active: the business's owner gets the task", async () => {
    const invoice = await doc(0);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    try {
      await job();
      expect((await tasks(invoice))[0].owner_id).toBe(owner.id);
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    }
  });

  it("held documents do not take the places of the others under the per-business cap", async () => {
    const held = [await doc(0), await doc(0), await doc(0)];
    for (const h of held) {
      await run(owner, (q) => q("insert into public.payment_promises (organization_id, document_id, promised_date) values ($1, $2, (now() at time zone $3)::date + 2)", [org, h, zone]));
    }
    const free = await doc(0);
    // a cap of 1 per business: the free document still gets its reminder, the held ones none
    await asAdmin((q) => q("select set_config('app.collection_reminder_per_org', '1', true), app.send_collection_reminders($1::uuid[])", [[org]]));
    expect(await tasks(free)).toHaveLength(1);
    for (const h of held) expect(await tasks(h), h).toEqual([]);
  });

  it("businesses take turns: one with many documents does not block another", async () => {
    const other = await createUser("cr-other");
    const org2 = await createOrg(other.id, "עסק שני");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org2, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org2, zone]));
    const c2 = await run(other, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'שני') returning id", [org2])).id);
    const theirs = await run(other, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', 'T-1', current_date - 40, 1000) returning id", [org2, c2])).id,
    );
    await asAdmin((q) => q("update public.accounting_documents set due_date = (now() at time zone $2)::date where id = $1", [theirs, zone]));
    for (let i = 0; i < 3; i++) await doc(0);
    const before = await asAdmin(async (q) => (await one<{ t: string }>(q, "select clock_timestamp()::text as t")).t);
    // 2 a run in total: one of each business, never two of the busy one before the other's first
    await asAdmin((q) => q("select set_config('app.collection_reminder_limit', '2', true), app.send_collection_reminders($1::uuid[])", [[org, org2]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where organization_id = $1 and collection_document_id = $2", [org2, theirs]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.collection_reminders_sent where organization_id = $1 and done_at >= $2::timestamptz", [org, before]))).toBe(1);
  });

  it("a task a person retitled, re-dated or whose owner left is kept; the next reminder makes a new one", async () => {
    const retitled = await doc(0);
    const redated = await doc(0);
    const orphaned = await doc(0);
    await job();
    const [a] = await tasks(retitled);
    const [b] = await tasks(redated);
    const [c] = await tasks(orphaned);
    await run(member, (q) => q("update public.tasks set title = 'להתקשר ללקוח' where id = $1", [a.id]));
    await run(member, (q) => q("update public.tasks set due_at = due_at + interval '1 day' where id = $1", [b.id]));
    // the rep of the third leaves (the first two tasks were already changed by the person, so they stay anyway)
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    try {
      for (const d of [retitled, redated, orphaned]) await setDue(d, -7);
      await job();
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    }
    for (const [d, first] of [[retitled, a], [redated, b], [orphaned, c]] as const) {
      const all = await tasks(d);
      expect(all, d).toHaveLength(2);
      expect(all.find((t) => t.id === first.id)?.title).not.toMatch(/7 ימים/);
      expect(all.find((t) => t.id !== first.id)?.title).toMatch(/· 7 ימים אחרי מועד התשלום$/);
    }
  });

  it("nothing while the document's contact is in the recycle bin", async () => {
    const binned = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'בסל', $2) returning id", [org, member.id])).id);
    const invoice = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, current_date - 40, 1000) returning id", [org, binned, `CR-${++n}`])).id,
    );
    await setDue(invoice, 0);
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    await job();
    expect(await tasks(invoice)).toEqual([]);
    expect(await sent(invoice)).toEqual([]);
  });

  it("a reminder task on an imported opening balance is not work: the import is still undone by its importer", async () => {
    // an admin records the balance into their own import (only owners and admins record one), then is made a member who
    // holds the import key and undoes their own import (undo_own_import, the path that asks whether the records were worked)
    const former = await addMember(org, owner.id, "admin", "cr-former");
    const importJob = await run(former, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'cr.csv', 'skip') returning id", [org])).id,
    );
    const imported = await run(former, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `מיובא ${++n}`, former.id, importJob])).id,
    );
    const ob = await run(former, async (q) =>
      (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, null, 700, current_date - 40, (now() at time zone $3)::date, $4) as id", [org, imported, zone, importJob])).id,
    );
    await run(former, (q) => q("update public.import_jobs set status = 'done' where id = $1", [importJob]));
    await job();
    expect(await tasks(ob)).toHaveLength(1);
    expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 hour', $3) as w", [org, imported, importJob])).w)).toBe(false);
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, former.id]));
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{import}')", [org, former.id]));
    const r = await run(former, async (q) => (await one<{ r: { done: number } }>(q, "select public.undo_own_import($1, $2) as r", [org, importJob])).r);
    expect(r.done).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [imported]))).toBe(1);
  });

  it("a task of another document on an imported contact is still work", async () => {
    const importJob = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'cr2.csv', 'skip') returning id", [org])).id,
    );
    const imported = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `מיובא ${++n}`, owner.id, importJob])).id,
    );
    await run(owner, (q) => q("update public.import_jobs set status = 'done' where id = $1", [importJob]));
    const invoice = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, current_date, 1000) returning id", [org, imported, `CR-${++n}`])).id,
    );
    await setDue(invoice, 0);
    await job();
    expect(await tasks(invoice)).toHaveLength(1);
    expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 hour', $3) as w", [org, imported, importJob])).w)).toBe(true);
  });

  it("the job and the mark are the server's; the person changes the task like any other", async () => {
    expect(
      await asAdmin(async (q) =>
        (await one<{ x: boolean; y: boolean }>(q, "select has_function_privilege('authenticated', 'app.send_collection_reminders(uuid[])', 'execute') as x, has_function_privilege('service_role', 'app.send_collection_reminders(uuid[])', 'execute') as y")),
      ),
    ).toEqual({ x: false, y: false });
    const invoice = await doc(0);
    expect(
      (await pgError(run(owner, (q) => q("insert into public.tasks (organization_id, title, collection_document_id) values ($1, 'x', $2)", [org, invoice])))).code,
    ).toBe("42501");
    await job();
    const [task] = await tasks(invoice);
    expect((await pgError(run(owner, (q) => q("update public.tasks set collection_document_id = null where id = $1", [task.id])))).code).toBe("42501");
    expect(await run(member, async (q) => (await q("update public.tasks set title = 'להתקשר' where id = $1", [task.id])).rowCount)).toBe(1);
  });

  it("a new business starts with the collection reminder template (DRAFT); a person cannot set the kind", async () => {
    const other = await createUser("cr-new");
    const fresh = await createOrg(other.id, "עסק חדש");
    const rows = await run(other, async (q) => (await q<{ name: string; body: string; kind: string | null }>("select name, body, kind from public.whatsapp_templates where organization_id = $1 and kind = $2", [fresh, COLLECTION_REMINDER_KIND])).rows);
    expect(rows).toEqual([{ name: "תזכורת לתשלום", body: COLLECTION_REMINDER_DRAFT_TEXT, kind: COLLECTION_REMINDER_KIND }]);
    expect((await pgError(run(other, (q) => q("insert into public.whatsapp_templates (organization_id, name, body, kind) values ($1, 'x', 'y', 'collection_reminder')", [fresh])))).code).toBe("42501");
  });
});
