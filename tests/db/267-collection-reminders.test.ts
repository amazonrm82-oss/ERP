import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings, type Weekday } from "../../src/features/calendar-days/holidays";
import {
  COLLECTION_REMINDER_TEXT,
  COLLECTION_REMINDER_OFFSETS,
  COLLECTION_REMINDER_STAGES,
  collectionReminderAt,
  collectionReminderOffset,
  collectionReminderStage,
} from "../../src/features/collection/reminders";
import { COLLECTION_REMINDER_KIND } from "../../src/features/whatsapp/templates";
import { Client } from "pg";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, TEST_DB_URL, type Query } from "./helpers";

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
    // no rest days, so the job's day-to-day tests pass on any weekday (answer (2) moves a reminder off a rest day; its own tests below)
    await setCalendar(NO_REST);
  });

  const NO_REST: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };
  const setCalendar = (c: CalendarSettings) =>
    run(owner, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = excluded.holidays_rest,
           holiday_eves_rest = excluded.holiday_eves_rest, rest_occasions = excluded.rest_occasions`,
        [org, c.restWeekdays, c.holidaysRest, c.holidayEvesRest, c.restOccasions],
      ),
    );

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
    const any = await asAdmin(async (q) =>
      (await q<{ k: number; s: string }>("select k, app.collection_reminder_stage(k) as s from generate_series(-30, 60) k order by k")).rows,
    );
    expect(any).toEqual(any.map(({ k }) => ({ k, s: collectionReminderStage(k) })));
  });

  it("answer (2): the moved reminder is the same in SQL and TS, day by day, for several settings", async () => {
    const cases: CalendarSettings[] = [
      DEFAULT_CALENDAR_SETTINGS,
      { restWeekdays: [6], holidaysRest: true, holidayEvesRest: true, restOccasions: ["chol_hamoed_sukkot", "chol_hamoed_pesach"] },
      { restWeekdays: [0, 5, 6], holidaysRest: false, holidayEvesRest: false, restOccasions: ["yom_hazikaron", "purim"] },
      NO_REST,
    ];
    // due dates around the autumn holidays and Pesach, every day from 5 days before to 40 after
    const dues = ["2026-09-08", "2026-09-18", "2026-09-22", "2026-09-28", "2026-10-02", "2027-04-16", "2027-04-22"];
    try {
      for (const settings of cases) {
        await setCalendar(settings);
        const sql = await asAdmin(async (q) =>
          (
            await q<{ due: string; today: string; offset: number | null; day: string | null }>(
              `select to_char(d, 'YYYY-MM-DD') as due, to_char(d + k, 'YYYY-MM-DD') as today, r.offset_days as offset,
                      to_char(r.reminder_day, 'YYYY-MM-DD') as day
                 from unnest($2::date[]) d cross join generate_series(-5, 40) k
                 cross join lateral app.collection_reminder_at($1, d, d + k) r
                order by d, k`,
              [org, dues],
            )
          ).rows,
        );
        const ts = sql.map(({ due, today }) => {
          const r = collectionReminderAt(due, today, settings);
          return { due, today, offset: r?.offset ?? null, day: r?.day ?? null };
        });
        expect(sql, JSON.stringify(settings)).toEqual(ts);
      }
    } finally {
      await setCalendar(NO_REST);
    }
  });

  it("answer (2): nothing on a rest day; a reminder whose day was a rest day comes on the next working day, titled by that day", async () => {
    const dow = await asAdmin(async (q) => (await one<{ d: number }>(q, "select extract(dow from (now() at time zone $1)::date)::integer as d", [zone])).d);
    const yesterday = (dow + 6) % 7;
    // today is a rest day: nothing is made, nothing recorded
    await setCalendar({ ...NO_REST, restWeekdays: [dow as Weekday] });
    const restToday = await doc(3);
    try {
      await job();
      expect(await tasks(restToday)).toEqual([]);
      expect(await sent(restToday)).toEqual([]);
    } finally {
      await setCalendar(NO_REST);
    }
    // yesterday was a rest day: a document due in 2 days had its 3-days-before reminder yesterday, moved to today
    await setCalendar({ ...NO_REST, restWeekdays: [yesterday as Weekday] });
    const moved = await doc(2);
    // and a document due in 4 days: its -3 reminder is tomorrow (a working day), nothing today
    const notYet = await doc(4);
    try {
      await job();
    } finally {
      await setCalendar(NO_REST);
    }
    const [task] = await tasks(moved);
    expect(task.title).toMatch(/· בעוד יומיים מועד התשלום$/);
    expect(await sent(moved)).toEqual([{ offset_days: -3, task_id: task.id }]);
    expect(await tasks(notYet)).toEqual([]);
    // the next stage still moves the task the job titled by its moved day
    await setDue(moved, 0);
    await job();
    const after = await tasks(moved);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(task.id);
    expect(after[0].title).toMatch(/· היום מועד התשלום$/);
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

  it("a new business starts with the collection reminder template (the owner's text); a person cannot set the kind", async () => {
    const other = await createUser("cr-new");
    const fresh = await createOrg(other.id, "עסק חדש");
    const rows = await run(other, async (q) => (await q<{ name: string; body: string; kind: string | null }>("select name, body, kind from public.whatsapp_templates where organization_id = $1 and kind = $2", [fresh, COLLECTION_REMINDER_KIND])).rows);
    expect(rows).toEqual([{ name: "תזכורת לתשלום", body: COLLECTION_REMINDER_TEXT, kind: COLLECTION_REMINDER_KIND }]);
    expect((await pgError(run(other, (q) => q("insert into public.whatsapp_templates (organization_id, name, body, kind) values ($1, 'x', 'y', 'collection_reminder')", [fresh])))).code).toBe("42501");
  });

  it("answer (1): an existing business without the template gets it once; a renamed one, a full list and a taken name are respected", async () => {
    const make = async (label: string) => {
      const u = await createUser(`cr-bf-${label}`);
      return { u, o: await createOrg(u.id, `עסק ${label}`) };
    };
    const list = (o: string) =>
      asAdmin(async (q) =>
        (await q<{ name: string; body: string; kind: string | null; position: number }>("select name, body, kind, position from public.whatsapp_templates where organization_id = $1 order by position, name", [o])).rows,
      );
    // an existing business as before this migration: its own list, no collection template
    const missing = await make("missing");
    await asAdmin((q) => q("delete from public.whatsapp_templates where organization_id = $1 and kind = 'collection_reminder'", [missing.o]));
    // renamed and reworded: kept as it is
    const renamed = await make("renamed");
    await run(renamed.u, (q) => q("update public.whatsapp_templates set name = 'גבייה שלי', body = 'טקסט שלי' where organization_id = $1 and kind = 'collection_reminder'", [renamed.o]));
    // the name is taken by another template: the second name
    const taken = await make("taken");
    await asAdmin((q) => q("delete from public.whatsapp_templates where organization_id = $1 and kind = 'collection_reminder'", [taken.o]));
    await run(taken.u, (q) => q("insert into public.whatsapp_templates (organization_id, name, body, position) values ($1, 'תזכורת לתשלום', 'שלי', 9)", [taken.o]));
    // both names taken: skipped
    const both = await make("both");
    await asAdmin((q) => q("delete from public.whatsapp_templates where organization_id = $1 and kind = 'collection_reminder'", [both.o]));
    await run(both.u, (q) => q("insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'תזכורת לתשלום', 'א'), ($1, 'תזכורת גבייה', 'ב')", [both.o]));
    // at the 50-template cap: skipped, never a failure
    const full = await make("full");
    await asAdmin((q) => q("delete from public.whatsapp_templates where organization_id = $1 and kind = 'collection_reminder'", [full.o]));
    await asAdmin((q) =>
      q("insert into public.whatsapp_templates (organization_id, name, body, position) select $1, 'תבנית ' || n, 'גוף', 10 + n from generate_series(1, 50 - (select count(*) from public.whatsapp_templates where organization_id = $1)) n", [full.o]),
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.whatsapp_templates where organization_id = $1", [full.o]))).toBe(50);

    const orgs = [missing.o, renamed.o, taken.o, both.o, full.o];
    const before = { renamed: await list(renamed.o), both: await list(both.o), full: await list(full.o) };
    const added = await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.collection_template_backfill($1::uuid[]) as n", [orgs])).n);
    expect(added).toBe(2);
    const mine = (await list(missing.o)).filter((t) => t.kind === COLLECTION_REMINDER_KIND);
    expect(mine).toEqual([{ name: "תזכורת לתשלום", body: COLLECTION_REMINDER_TEXT, kind: COLLECTION_REMINDER_KIND, position: 4 }]);
    expect((await list(taken.o)).filter((t) => t.kind === COLLECTION_REMINDER_KIND)).toEqual([
      { name: "תזכורת גבייה", body: COLLECTION_REMINDER_TEXT, kind: COLLECTION_REMINDER_KIND, position: 10 },
    ]);
    expect(await list(renamed.o)).toEqual(before.renamed);
    expect(await list(both.o)).toEqual(before.both);
    expect(await list(full.o)).toEqual(before.full);
    // once: a second run adds nothing
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.collection_template_backfill($1::uuid[]) as n", [orgs])).n)).toBe(0);
    expect(
      await asAdmin(async (q) =>
        (await one<{ x: boolean }>(q, "select has_function_privilege('authenticated', 'app.collection_template_backfill(uuid[])', 'execute') as x")).x,
      ),
    ).toBe(false);
  });

  describe("answer (4): the system closes a reminder task once the debt is paid", () => {
    const pay = (document: string, amount: number) =>
      run(owner, async (q) => {
        const p = await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, current_date, 'cash') returning id", [org, contact, amount]);
        await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, p.id, document, amount]);
        return p.id;
      });
    // a failed payment releases its allocations: the debt is back
    const fail = (payment: string) => run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [payment]));
    const marker = (task: string) =>
      asAdmin(async (q) => (await q<{ closed: boolean; failures: number }>("select closed_at is not null as closed, failures from app.collection_task_closes where task_id = $1", [task])).rows[0] ?? null);
    const state = (task: string) =>
      asAdmin(async (q) => await one<{ status: string; outcome: string | null }>(q, "select status::text as status, outcome from public.tasks where id = $1", [task]));

    it("paid in full: done with the note; partly paid: left open", async () => {
      const full = await doc(0, "tax_invoice", 500);
      const part = await doc(0, "tax_invoice", 500);
      await job();
      const [a] = await tasks(full);
      const [b] = await tasks(part);
      await pay(full, 500);
      await pay(part, 200);
      await job();
      expect(await state(a.id)).toEqual({ status: "done", outcome: "נסגרה: החוב שולם" });
      expect(await state(b.id)).toEqual({ status: "open", outcome: null });
      // the close is an ordinary update with no actor
      expect(
        await asAdmin(async (q) => (await one<{ a: string | null }>(q, "select actor_id as a from public.audit_log where entity_type = 'tasks' and entity_id = $1 and action = 'update' order by id desc limit 1", [a.id])).a),
      ).toBeNull();
    });

    it("a cancelled document closes nothing (the owner's answer covers a paid debt only)", async () => {
      const invoice = await doc(0);
      await job();
      const [t] = await tasks(invoice);
      await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [invoice]));
      await job();
      expect(await state(t.id)).toEqual({ status: "open", outcome: null });
    });

    it("the debt comes back: the task the system closed is open again, and closed again once paid", async () => {
      const invoice = await doc(0, "tax_invoice", 600);
      await job();
      const [t] = await tasks(invoice);
      const payment = await pay(invoice, 600);
      await job();
      expect(await state(t.id)).toEqual({ status: "done", outcome: "נסגרה: החוב שולם" });
      expect(await marker(t.id)).toEqual({ closed: true, failures: 0 });
      await fail(payment);
      await job();
      expect(await state(t.id)).toEqual({ status: "open", outcome: null });
      expect(await marker(t.id)).toEqual({ closed: false, failures: 0 });
      await pay(invoice, 600);
      await job();
      expect(await state(t.id)).toEqual({ status: "done", outcome: "נסגרה: החוב שולם" });
    });

    it("a person who reopened or re-closed a task the system closed keeps it", async () => {
      const reopened = await doc(0, "tax_invoice", 350);
      const reclosed = await doc(0, "tax_invoice", 350);
      await job();
      const [a] = await tasks(reopened);
      const [b] = await tasks(reclosed);
      await pay(reopened, 350);
      const second = await pay(reclosed, 350);
      await job();
      // a person reopens the first while it is still paid: the system never closes it again
      await run(member, (q) => q("update public.tasks set status = 'open' where id = $1", [a.id]));
      // a person reopens and closes the second, then the debt comes back: the system never reopens it
      await run(member, (q) => q("update public.tasks set status = 'open' where id = $1", [b.id]));
      await run(member, (q) => q("update public.tasks set status = 'done' where id = $1", [b.id]));
      await fail(second);
      await job();
      expect((await state(a.id)).status).toBe("open");
      expect((await state(b.id)).status).toBe("done");
    });

    it("a task with a repeat rule is never closed", async () => {
      const invoice = await doc(0, "tax_invoice", 150);
      await job();
      const [t] = await tasks(invoice);
      await run(member, (q) => q(`update public.tasks set recurrence = '{"kind": "daily"}' where id = $1`, [t.id]));
      await pay(invoice, 150);
      await job();
      expect((await state(t.id)).status).toBe("open");
    });

    it("only in the named businesses, and only with the three plan keys", async () => {
      const invoice = await doc(0, "tax_invoice", 120);
      await job();
      const [t] = await tasks(invoice);
      await pay(invoice, 120);
      const other = await createUser("cr-close-other");
      const elsewhere = await createOrg(other.id, "עסק אחר");
      await asAdmin((q) => q("select app.close_paid_collection_tasks($1::uuid[])", [[elsewhere]]));
      expect((await state(t.id)).status).toBe("open");
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, collection: false })]));
      try {
        await job();
        expect((await state(t.id)).status).toBe("open");
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
      await asAdmin((q) => q("select app.close_paid_collection_tasks($1::uuid[])", [[org]]));
      expect((await state(t.id)).status).toBe("done");
    });

    it("a failing close is counted, warned in one redacted line, and skipped after 3 attempts", async () => {
      const invoice = await doc(0, "tax_invoice", 90);
      await job();
      const [t] = await tasks(invoice);
      await pay(invoice, 90);
      // a test-only trigger that refuses this one task's update (removed below)
      await asAdmin(async (q) => {
        await q("create schema if not exists cr_test");
        await q(`create or replace function cr_test.refuse() returns trigger language plpgsql as $f$
                 begin if new.id = '${t.id}'::uuid then raise exception 'refused by the test'; end if; return new; end $f$`);
        await q("create or replace trigger zz_cr_test_refuse before update on public.tasks for each row execute function cr_test.refuse()");
      });
      const notices: string[] = [];
      try {
        for (let i = 0; i < 4; i++) {
          const client = new Client({ connectionString: TEST_DB_URL });
          client.on("notice", (n) => notices.push(n.message ?? ""));
          await client.connect();
          try {
            await client.query("select app.close_paid_collection_tasks($1::uuid[])", [[org]]);
          } finally {
            await client.end();
          }
        }
      } finally {
        await asAdmin(async (q) => {
          await q("drop trigger if exists zz_cr_test_refuse on public.tasks");
          await q("drop schema if exists cr_test cascade");
        });
      }
      expect(await marker(t.id)).toEqual({ closed: false, failures: 3 });
      const lines = notices.filter((n) => n.includes(t.id));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(`crm-collection-reminders: closing task ${t.id} failed (SQLSTATE P0001)`);
      expect(lines[2]).toMatch(/skipped after 3 failures$/);
      expect(lines.join(" ")).not.toMatch(/refused by the test/);
      // skipped now, even with the refusal gone
      await job();
      expect((await state(t.id)).status).toBe("open");
    });

    it("a task a person closed or reopened is never touched", async () => {
      const closed = await doc(0, "tax_invoice", 300);
      const reopened = await doc(0, "tax_invoice", 300);
      await job();
      const [c] = await tasks(closed);
      const [r] = await tasks(reopened);
      await run(member, (q) => q("update public.tasks set status = 'done', outcome = 'דיברתי איתו' where id = $1", [c.id]));
      await run(member, (q) => q("update public.tasks set status = 'done' where id = $1", [r.id]));
      await run(member, (q) => q("update public.tasks set status = 'open' where id = $1", [r.id]));
      await pay(closed, 300);
      await pay(reopened, 300);
      await job();
      expect(await state(c.id)).toEqual({ status: "done", outcome: "דיברתי איתו" });
      expect(await state(r.id)).toEqual({ status: "open", outcome: null });
    });

    it("a billed proforma's task is judged by its invoice", async () => {
      const proforma = await doc(0, "proforma", 800);
      await job();
      const [t] = await tasks(proforma);
      const invoice = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, proforma_id) values ($1, $2, 'tax_invoice', $3, current_date, 800, $4) returning id",
            [org, contact, `CR-${++n}`, proforma],
          )
        ).id,
      );
      await job();
      expect(await state(t.id)).toEqual({ status: "open", outcome: null });
      await pay(invoice, 800);
      await job();
      expect(await state(t.id)).toEqual({ status: "done", outcome: "נסגרה: החוב שולם" });
    });

    it("nothing while the business is read-only; it closes after", async () => {
      const invoice = await doc(0, "tax_invoice", 250);
      await job();
      const [t] = await tasks(invoice);
      await pay(invoice, 250);
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        await job();
        expect((await state(t.id)).status).toBe("open");
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
      await job();
      expect((await state(t.id)).status).toBe("done");
    });

    it("the close job is the server's", async () => {
      expect(
        await asAdmin(async (q) =>
          (await one<{ x: boolean; y: boolean }>(q, "select has_function_privilege('authenticated', 'app.close_paid_collection_tasks(uuid[])', 'execute') as x, has_function_privilege('service_role', 'app.close_paid_collection_tasks(uuid[])', 'execute') as y")),
        ),
      ).toEqual({ x: false, y: false });
    });
  });
});
