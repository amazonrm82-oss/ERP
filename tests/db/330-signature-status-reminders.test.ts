import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = Record<string, unknown> & { status_page?: Record<string, unknown>; fingerprint?: string | null };
type Draft = { segments: { locked: boolean; text: string }[] };

const CONTACT_BODY = "הסכם בין {שם העסק} לבין {שם פרטי}.";
const DEAL_BODY = "חוזה עבור {שם העסקה}.";
const WORDING = "sign-draft-2026-11-10";
// zones far apart, so one of them is always in working hours and one before 08:00
const ZONES = [
  "Asia/Jerusalem",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Pacific/Honolulu",
  "Australia/Sydney",
  "America/Chicago",
];

/**
 * SGN-03 (lead's choices, owner's answers pending): an unsigned document past its expires_at is stamped expired by the
 * job (state only) with one notice that names nothing personal; N business days after sending (setting
 * org_document_settings.signature_reminder_days, default 3, 0 = off) the sender gets one task to remind the customer.
 */
describe("signature states and reminders (SGN-03)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let template: string, dealTemplate: string, otherTemplate: string;
  let workZone: string, earlyZone: string;

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setPlan = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const setZone = (orgId: string, zone: string) => asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [orgId, zone]));
  const setDays = (orgId: string, days: number) =>
    asAdmin(async (q) => {
      const updated = await q("update public.org_document_settings set signature_reminder_days = $2 where organization_id = $1", [orgId, days]);
      if (updated.rowCount === 0) await q("insert into public.org_document_settings (organization_id, signature_reminder_days) values ($1, $2)", [orgId, days]);
    });
  const newContact = (u: U, orgId: string, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  const send = (u: U, orgId: string, tpl: string, type: string, record: string, days: number | null = null) =>
    run(u, async (q) => {
      const d = (await one<{ d: Draft }>(q, "select public.signature_document_draft($1, $2, $3, $4) as d", [orgId, tpl, type, record])).d;
      const body = d.segments.map((seg) => seg.text).join("\n");
      return (await one<{ r: { id: string; token: string } }>(q, "select public.signature_document_send($1, $2, $3, $4, '', $5, $6) as r", [orgId, tpl, type, record, body, days])).r;
    });
  const page = (token: string) => asService(async (q) => (await one<{ p: Page }>(q, "select public.signature_public($1, null) as p", [token])).p);
  const sign = (token: string, fingerprint: string) =>
    asService(async (q) =>
      (
        await one<{ r: { status: string } }>(
          q,
          `select public.signature_public_sign(p_token => $1, p_fingerprint => $2, p_signer_name => 'דנה כהן', p_id_number => null,
                   p_signature_kind => 'typed', p_signature_image => null, p_wording_version => $3, p_agreed => true,
                   p_ip => '203.0.113.5', p_user_agent => 'test') as r`,
          [token, fingerprint, WORDING],
        )
      ).r,
    );
  const expireJob = (perOrg: number | null = null, limit: number | null = null) =>
    asAdmin(async (q) => {
      if (perOrg !== null) await q("select set_config('app.signature_job_per_org', $1, true)", [String(perOrg)]);
      if (limit !== null) await q("select set_config('app.signature_job_limit', $1, true)", [String(limit)]);
      return Number((await one<{ n: number }>(q, "select app.expire_signature_documents() as n")).n);
    });
  const remindJob = (perOrg: number | null = null) =>
    asAdmin(async (q) => {
      if (perOrg !== null) await q("select set_config('app.signature_job_per_org', $1, true)", [String(perOrg)]);
      return Number((await one<{ n: number }>(q, "select app.send_signature_reminders() as n")).n);
    });
  const doc = (id: string) =>
    asAdmin((q) => one<{ status: string; expired_at: string | null; expires_at: string | null }>(q, "select status, expired_at, expires_at from public.signature_documents where id = $1", [id]));
  const notices = (orgId: string, title: string) =>
    asAdmin(async (q) => (await q<{ user_id: string; body: string; entity_type: string; entity_id: string }>("select user_id, body, entity_type, entity_id from public.notifications where organization_id = $1 and title = $2", [orgId, title])).rows);
  const reminderTasks = (docId: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ id: string; title: string; owner_id: string; status: string; outcome: string | null; contact_id: string | null; deal_id: string | null; description: string; due_at: string }>(
            `select t.id, t.title, t.owner_id, t.status, t.outcome, t.contact_id, t.deal_id, t.description, t.due_at
               from app.signature_reminders r join public.tasks t on t.id = r.task_id where r.document_id = $1`,
            [docId],
          )
        ).rows,
    );
  // the zone's today and a day sent on which N working days have passed (due), or not yet (not due)
  const sentDay = (orgId: string, zone: string, days: number, due: boolean) =>
    asAdmin(async (q) =>
      (
        await one<{ d: string }>(
          q,
          due
            ? `select to_char(d, 'YYYY-MM-DD') as d from generate_series((now() at time zone $2)::date - 30, (now() at time zone $2)::date - 1, interval '1 day') g(d)
                where app.add_business_days($1, d::date, $3) <= (now() at time zone $2)::date
                  and app.add_business_days($1, d::date, $3) >= (now() at time zone $2)::date - 7
                order by d desc limit 1`
            : `select to_char(((now() at time zone $2)::date - 1), 'YYYY-MM-DD') as d where app.add_business_days($1, (now() at time zone $2)::date - 1, $3) > (now() at time zone $2)::date`,
          [orgId, zone, days],
        )
      ).d,
    );
  // move a document's sending to noon of a day in the zone (its fingerprint follows, so it can still be signed)
  const sentOn = (id: string, day: string, zone: string) =>
    asAdmin(async (q) => {
      await q("update public.signature_documents set sent_at = ($2::date + time '12:00') at time zone $3 where id = $1", [id, day, zone]);
      await q("update public.signature_documents d set content_sha256 = app.signature_fingerprint(d) where id = $1", [id]);
    });

  beforeAll(async () => {
    owner = await createUser("sr-owner");
    org = await createOrg(owner.id, "עסק התזכורות");
    admin = await addMember(org, owner.id, "admin", "sr-admin");
    member = await addMember(org, owner.id, "member", "sr-member");
    other = await addMember(org, owner.id, "member", "sr-other");
    viewer = await addMember(org, owner.id, "viewer", "sr-viewer");
    outsider = await createUser("sr-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setPlan(org, { signatures: true });
    await setPlan(otherOrg, { signatures: true });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    for (const [o, u] of [
      [org, owner],
      [otherOrg, outsider],
    ] as const) {
      await run(u, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'service_agreement'", [o, CONTACT_BODY]));
      await run(u, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'contract'", [o, DEAL_BODY]));
    }
    const tpl = (o: string, key: string) => asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = $2", [o, key])).id);
    template = await tpl(org, "service_agreement");
    dealTemplate = await tpl(org, "contract");
    otherTemplate = await tpl(otherOrg, "service_agreement");
    const zones = await asAdmin(async (q) =>
      (await q<{ z: string; h: number }>("select z, extract(hour from now() at time zone z)::int as h from unnest($1::text[]) z", [ZONES])).rows,
    );
    workZone = zones.find((z) => z.h >= 9 && z.h <= 20)!.z;
    earlyZone = zones.find((z) => z.h <= 6)!.z;
    await setZone(org, workZone);
    await setZone(otherOrg, workZone);
  });

  it("the setting: 3 by default, 0..30, owners and admins write it, every member reads it", async () => {
    const fresh = await createUser("sr-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש");
    await run(fresh, (q) => q("insert into public.org_document_settings (organization_id) values ($1) on conflict do nothing", [freshOrg]));
    expect((await run(fresh, (q) => one<{ d: number }>(q, "select signature_reminder_days as d from public.org_document_settings where organization_id = $1", [freshOrg]))).d).toBe(3);
    await setDays(org, 3);
    expect((await run(admin, async (q) => (await q("update public.org_document_settings set signature_reminder_days = 5 where organization_id = $1 returning id", [org])).rowCount))).toBe(1);
    expect((await run(viewer, (q) => one<{ d: number }>(q, "select signature_reminder_days as d from public.org_document_settings where organization_id = $1", [org]))).d).toBe(5);
    expect((await run(member, async (q) => (await q("update public.org_document_settings set signature_reminder_days = 1 where organization_id = $1 returning id", [org])).rowCount))).toBe(0);
    expect((await run(outsider, async (q) => (await q("update public.org_document_settings set signature_reminder_days = 1 where organization_id = $1 returning id", [org])).rowCount))).toBe(0);
    expect((await pgError(run(owner, (q) => q("update public.org_document_settings set signature_reminder_days = 31 where organization_id = $1", [org])))).code).toBe("23514");
    expect((await pgError(run(owner, (q) => q("update public.org_document_settings set signature_reminder_days = -1 where organization_id = $1", [org])))).code).toBe("23514");
    await setDays(org, 3);
  });

  it("expiry: a document past expires_at is stamped once, its page shows expired, one notice to the sender with nothing personal", async () => {
    const contact = await newContact(member, org, "רונית");
    const past = await send(member, org, template, "contact", contact, 10);
    const future = await send(member, org, template, "contact", contact, 10);
    await asAdmin((q) => q("update public.signature_documents set expires_at = now() - interval '1 minute' where id = $1", [past.id]));
    await asAdmin((q) => q("update public.signature_documents set expires_at = now() + interval '1 minute' where id = $1", [future.id]));
    const noticesBefore = (await notices(org, "פג תוקף של מסמך לחתימה")).length;
    await expireJob();
    const stamped = await doc(past.id);
    expect(stamped.status).toBe("sent");
    expect(stamped.expired_at).not.toBeNull();
    expect((await doc(future.id)).expired_at).toBeNull();
    expect((await page(past.token)).status_page).toMatchObject({ state: "expired" });
    // a client cannot stamp it (no write grant)
    expect((await pgError(run(owner, (q) => q("update public.signature_documents set expired_at = null where id = $1", [past.id])))).code).toBe("42501");
    // the record's readers see the column (tried again a few times: test 64 re-runs _signature_documents.sql, whose revoke all
    // takes the column grants away for a moment until the files after it give them back)
    const readExpired = () => run(member, (q) => one<{ e: string | null }>(q, "select expired_at as e from public.signature_documents where id = $1", [past.id]));
    let seen: { e: string | null } | null = null;
    for (let attempt = 0; attempt < 5 && seen === null; attempt += 1) {
      try {
        seen = await readExpired();
      } catch (error) {
        if ((error as { code?: string }).code !== "42501" || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(seen?.e).not.toBeNull();

    const list = await notices(org, "פג תוקף של מסמך לחתימה");
    expect(list.length).toBe(noticesBefore + 1);
    const notice = list.find((n) => n.entity_id === contact)!;
    expect(notice).toMatchObject({ user_id: member.id, entity_type: "contact" });
    expect(notice.body).not.toContain("הסכם");
    expect(notice.body).not.toContain("רונית");
    // again: nothing new
    await expireJob();
    expect((await notices(org, "פג תוקף של מסמך לחתימה")).length).toBe(noticesBefore + 1);
  });

  it("expiry: a suspended sender's notice goes to the owners and admins; a signed or cancelled document is never stamped", async () => {
    const leaver = await addMember(org, owner.id, "member", "sr-leaver");
    const contact = await newContact(leaver, org, "גלית");
    const sent = await send(leaver, org, template, "contact", contact, 5);
    const signed = await send(leaver, org, template, "contact", contact, 5);
    const cancelled = await send(leaver, org, template, "contact", contact, 5);
    expect((await sign(signed.token, (await page(signed.token)).fingerprint as string)).status).toBe("signed");
    await run(leaver, (q) => q("select public.signature_document_cancel($1, $2)", [org, cancelled.id]));
    await asAdmin((q) => q("update public.signature_documents set expires_at = now() - interval '1 hour' where id = any ($1)", [[sent.id, signed.id, cancelled.id]]));
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    await expireJob();
    expect((await doc(sent.id)).expired_at).not.toBeNull();
    expect((await doc(signed.id)).expired_at).toBeNull();
    expect((await doc(cancelled.id)).expired_at).toBeNull();
    const to = (await notices(org, "פג תוקף של מסמך לחתימה")).filter((n) => n.entity_id === contact).map((n) => n.user_id).sort();
    expect(to).toEqual([owner.id, admin.id].sort());
  });

  it("expiry is batched and fair per business", async () => {
    const mine = await newContact(member, org, "תור");
    const theirs = await newContact(outsider, otherOrg, "תור");
    const docs = [
      await send(member, org, template, "contact", mine, 5),
      await send(member, org, template, "contact", mine, 5),
      await send(outsider, otherOrg, otherTemplate, "contact", theirs, 5),
      await send(outsider, otherOrg, otherTemplate, "contact", theirs, 5),
    ];
    // long past, so these come first among anything else waiting in the database
    await asAdmin((q) => q("update public.signature_documents set expires_at = '2001-01-01T00:00:00Z'::timestamptz + (random() * interval '1 hour') where id = any ($1)", [docs.map((d) => d.id)]));
    await expireJob(1, 1);
    const stamped = async () => (await Promise.all(docs.map((d) => doc(d.id)))).map((d) => d.expired_at !== null);
    expect((await stamped()).filter(Boolean).length).toBe(1);
    await expireJob(1, 2000);
    const afterSecond = await stamped();
    // one more of each business at most: every business's first before any business's second
    expect(afterSecond.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(afterSecond.slice(0, 2).some(Boolean) && afterSecond.slice(2).some(Boolean)).toBe(true);
    await expireJob();
    expect((await stamped()).every(Boolean)).toBe(true);
  });

  it("reminder: one task N business days after sending, for the sender, linked to the record; never twice", async () => {
    const contact = await newContact(member, org, "שירה");
    const due = await send(member, org, template, "contact", contact);
    const notDue = await send(member, org, template, "contact", contact);
    await sentOn(due.id, await sentDay(org, workZone, 3, true), workZone);
    await sentOn(notDue.id, await sentDay(org, workZone, 3, false), workZone);
    await remindJob();
    expect(await reminderTasks(notDue.id)).toEqual([]);
    const tasks = await reminderTasks(due.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({ owner_id: member.id, contact_id: contact, status: "open", title: "להזכיר לשירה לחתום על הסכם שירות" });
    expect(tasks[0].description).toContain("ועוד לא נחתם");
    await remindJob();
    expect((await reminderTasks(due.id)).length).toBe(1);
    expect(Number((await asAdmin((q) => one<{ n: string }>(q, "select count(*) as n from app.signature_reminders where document_id = $1", [due.id]))).n)).toBe(1);
    // the sender sees it; the reminders table is not in the API
    expect((await run(member, (q) => one<{ t: string }>(q, "select title as t from public.tasks where id = $1", [tasks[0].id]))).t).toContain("לחתום");
    expect((await pgError(run(owner, (q) => q("select * from app.signature_reminders")))).code).toBe("42501");

    // signing closes the open task
    expect((await sign(due.token, (await page(due.token)).fingerprint as string)).status).toBe("signed");
    expect((await reminderTasks(due.id))[0]).toMatchObject({ status: "done", outcome: "נסגרה: המסמך נחתם" });
  });

  it("reminder: the task closes when the document is cancelled or expires", async () => {
    const contact = await newContact(member, org, "נוי");
    const a = await send(member, org, template, "contact", contact);
    const b = await send(member, org, template, "contact", contact, 30);
    const day = await sentDay(org, workZone, 3, true);
    await sentOn(a.id, day, workZone);
    await sentOn(b.id, day, workZone);
    await remindJob();
    expect((await reminderTasks(a.id)).length).toBe(1);
    expect((await reminderTasks(b.id)).length).toBe(1);
    await run(member, (q) => q("select public.signature_document_cancel($1, $2)", [org, a.id]));
    expect((await reminderTasks(a.id))[0]).toMatchObject({ status: "done", outcome: "נסגרה: המסמך בוטל" });
    await asAdmin((q) => q("update public.signature_documents set expires_at = '2001-01-01' where id = $1", [b.id]));
    await expireJob();
    expect((await reminderTasks(b.id))[0]).toMatchObject({ status: "done", outcome: "נסגרה: פג תוקף המסמך" });
  });

  it("reminder: none when off, for a signed, cancelled or expired document, a record in the bin, before 08:00, without the key or a writable business", async () => {
    const contact = await newContact(member, org, "אין");
    const day = await sentDay(org, workZone, 3, true);
    const make = async () => {
      const d = await send(member, org, template, "contact", contact);
      await sentOn(d.id, day, workZone);
      return d;
    };
    const signed = await make();
    expect((await sign(signed.token, (await page(signed.token)).fingerprint as string)).status).toBe("signed");
    const cancelled = await make();
    await run(member, (q) => q("select public.signature_document_cancel($1, $2)", [org, cancelled.id]));
    const expired = await make();
    await asAdmin((q) => q("update public.signature_documents set expires_at = now() - interval '1 minute' where id = $1", [expired.id]));
    await remindJob();
    for (const d of [signed, cancelled, expired]) expect(await reminderTasks(d.id)).toEqual([]);

    const waiting = await make();
    await setDays(org, 0);
    await remindJob();
    expect(await reminderTasks(waiting.id)).toEqual([]);
    await setDays(org, 3);

    await setPlan(org, { signatures: false });
    await remindJob();
    await setPlan(org, { signatures: true });
    expect(await reminderTasks(waiting.id)).toEqual([]);

    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await remindJob();
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect(await reminderTasks(waiting.id)).toEqual([]);

    // before 08:00 in the business zone (same working-day count, in that zone)
    await setZone(org, earlyZone);
    try {
      await sentOn(waiting.id, await sentDay(org, earlyZone, 3, true), earlyZone);
      await remindJob();
    } finally {
      await setZone(org, workZone);
    }
    expect(await reminderTasks(waiting.id)).toEqual([]);

    await sentOn(waiting.id, day, workZone);
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    try {
      await remindJob();
      expect(await reminderTasks(waiting.id)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.contacts set deleted_at = null where id = $1", [contact]));
    }
    // nothing was recorded for the waiting document, so it is reminded once all of it holds
    await remindJob();
    expect((await reminderTasks(waiting.id)).length).toBe(1);
  });

  it("reminder: a sender who no longer reads the record, or left, hands it to the owner; a deal's task names no one", async () => {
    const contact = await newContact(member, org, "יעל");
    const lost = await send(member, org, template, "contact", contact);
    await sentOn(lost.id, await sentDay(org, workZone, 3, true), workZone);
    // the record went to another rep (visibility 'own'): the sender no longer reads it
    await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [contact, other.id]));
    await remindJob();
    expect((await reminderTasks(lost.id))[0]?.owner_id).toBe(owner.id);

    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקת יעל', $2, $3, $4, null) returning id", [org, pipelineId, stages[0].id, member.id])).id,
    );
    const dealDoc = await send(member, org, dealTemplate, "deal", deal);
    await sentOn(dealDoc.id, await sentDay(org, workZone, 3, true), workZone);
    await remindJob();
    const [task] = await reminderTasks(dealDoc.id);
    expect(task.owner_id).toBe(member.id);
    expect(task.deal_id).toBe(deal);
    expect(task.title).toMatch(/^להזכיר ללקוח לחתום על המסמך שנשלח ב-\d{2}\.\d{2}\.\d{4}$/);
  });

  it("reminder: the per-business cap leaves room for the other businesses", async () => {
    const contact = await newContact(member, org, "תור");
    const day = await sentDay(org, workZone, 3, true);
    const a = await send(member, org, template, "contact", contact);
    const b = await send(member, org, template, "contact", contact);
    await sentOn(a.id, day, workZone);
    await sentOn(b.id, day, workZone);
    await remindJob(1);
    const made = (await reminderTasks(a.id)).length + (await reminderTasks(b.id)).length;
    expect(made).toBe(1);
    await remindJob();
    expect((await reminderTasks(a.id)).length + (await reminderTasks(b.id)).length).toBe(2);
  });

  it("validity (247) ב: the end of the business day of the sending day + N days, in the business zone", async () => {
    const contact = await newContact(member, org, "תוקף");
    const sent = await send(member, org, template, "contact", contact, 10);
    const row = await asAdmin((q) =>
      one<{ days: number; t: string }>(
        q,
        `select ((d.expires_at at time zone $2)::date - (d.sent_at at time zone $2)::date) as days,
                to_char(d.expires_at at time zone $2, 'HH24:MI:SS.MS') as t
           from public.signature_documents d where d.id = $1`,
        [sent.id, workZone],
      ),
    );
    expect(row).toEqual({ days: 10, t: "23:59:59.999" });
    // in another zone the day ends at that zone's midnight
    await setZone(org, earlyZone);
    try {
      const other = await send(member, org, template, "contact", contact, 3);
      const t = await asAdmin((q) => one<{ t: string }>(q, "select to_char(expires_at at time zone $2, 'HH24:MI:SS.MS') as t from public.signature_documents where id = $1", [other.id, earlyZone]));
      expect(t.t).toBe("23:59:59.999");
    } finally {
      await setZone(org, workZone);
    }
    // without a validity, none
    expect((await doc((await send(member, org, template, "contact", contact)).id)).expires_at).toBeNull();
  });

  it("(248) ב: every N business days, at most 3; an open task is re-dated, a closed one makes a new task; one notice of its own kind each time", async () => {
    const contact = await newContact(member, org, "חוזרת");
    const sent = await send(member, org, template, "contact", contact);
    const day = await sentDay(org, workZone, 3, true);
    await sentOn(sent.id, day, workZone);
    const state = () =>
      asAdmin((q) => one<{ reminders: number; done: boolean; task_id: string }>(q, "select reminders, done_at is not null as done, task_id from app.signature_reminders where document_id = $1", [sent.id]));
    const kinds = (taskId: string) =>
      asAdmin(async (q) => (await q<{ type: string; user_id: string; body: string }>("select type, user_id, body from public.notifications where entity_type = 'task' and entity_id = $1 order by created_at", [taskId])).rows);
    // the next reminder's day has come: the previous one moved back by one interval
    const rewind = () => asAdmin((q) => q("update app.signature_reminders set last_reminder_day = $2::date where document_id = $1", [sent.id, day]));

    await remindJob();
    const first = await state();
    expect(first).toMatchObject({ reminders: 1, done: false });
    expect((await kinds(first.task_id)).map((n) => [n.type, n.user_id])).toEqual([["signature_reminder", member.id]]);
    expect((await kinds(first.task_id))[0].body).not.toContain("חוזרת");
    // the same day: nothing more
    await remindJob();
    expect((await state()).reminders).toBe(1);

    await rewind();
    await remindJob();
    const second = await state();
    expect(second).toMatchObject({ reminders: 2, task_id: first.task_id });
    expect((await reminderTasks(sent.id)).length).toBe(1);
    expect((await kinds(first.task_id)).filter((n) => n.type === "signature_reminder").length).toBe(2);

    await asAdmin((q) => q("update public.tasks set status = 'done' where id = $1", [first.task_id]));
    await rewind();
    await remindJob();
    const third = await state();
    expect(third.reminders).toBe(3);
    expect(third.done).toBe(true);
    expect(third.task_id).not.toBe(first.task_id);
    expect((await kinds(third.task_id)).map((n) => n.type)).toEqual(["signature_reminder"]);

    await rewind();
    await remindJob();
    expect((await state()).reminders).toBe(3);
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where contact_id = $1", [contact]))).toBe(2);
  });

  it("(248) ב: muting signature_reminder mutes the notice; the task is still made", async () => {
    await run(member, (q) => q("select public.set_notification_settings($1, $2)", [["signature_reminder"], []]));
    try {
      const contact = await newContact(member, org, "שקטה");
      const sent = await send(member, org, template, "contact", contact);
      await sentOn(sent.id, await sentDay(org, workZone, 3, true), workZone);
      await remindJob();
      const [task] = await reminderTasks(sent.id);
      expect(task.owner_id).toBe(member.id);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1", [task.id]))).toBe(0);
    } finally {
      await run(member, (q) => q("select public.set_notification_settings($1, $2)", [[], []]));
    }
  });

  describe("the customer's reminder (249) א", () => {
    type Job = { id: string; payload: Record<string, unknown>; status: string; last_error: string | null };
    const jobs = (docId: string) =>
      asAdmin(async (q) => (await q<Job>("select id, payload, status, last_error from app.jobs where payload ->> 'signature_document_id' = $1", [docId])).rows);
    const outcome = (docId: string) =>
      asAdmin(async (q) => (await q<{ outcome: string }>("select outcome from app.signature_customer_reminders where document_id = $1", [docId])).rows[0]?.outcome ?? null);
    const customerJob = () => asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.send_signature_customer_reminders() as n")).n));
    const person = (name: string, extra: { phone?: string; email?: string; channel?: string } = {}) =>
      run(member, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.contacts (organization_id, first_name, owner_id, phone, email, preferred_channel) values ($1, $2, $3, $4, $5, $6) returning id",
            [org, name, member.id, extra.phone ?? null, extra.email ?? null, extra.channel ?? null],
          )
        ).id,
      );
    // sent yesterday, valid until the end of the day `aheadDays` ahead in the business zone
    const dueSoon = async (record: string, kind = "contact", tpl = template, aheadDays = 2) => {
      const d = await send(member, org, tpl, kind, record);
      const yesterday = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone $1)::date - 1, 'YYYY-MM-DD') as d", [workZone])).d);
      await sentOn(d.id, yesterday, workZone);
      await asAdmin((q) => q("update public.signature_documents set expires_at = app.signature_valid_until(organization_id, $2) where id = $1", [d.id, aheadDays]));
      return d;
    };

    it("one service message through the queue, ids only, on the preferred channel else SMS; the DRAFT templates are seeded once", async () => {
      const contact = await person("מירב", { phone: "050-1234567", email: "merav@example.test" });
      const d = await dueSoon(contact);
      await customerJob();
      const [job] = await jobs(d.id);
      expect(job.status).toBe("queued");
      expect(job.payload).toMatchObject({ channel: "sms", message_type: "requested_document", contact_id: contact, signature_document_id: d.id });
      expect(Object.keys(job.payload).sort()).toEqual(["channel", "contact_id", "event_at", "message_type", "signature_document_id", "template_id"]);
      expect(JSON.stringify(job.payload)).not.toContain("מירב");
      const expires = Date.parse((await doc(d.id)).expires_at as string);
      expect(Date.parse(job.payload.event_at as string)).toBe(expires - (expires % 1000));
      const templates = await asAdmin(
        async (q) =>
          (
            await q<{ channel: string; body: string; message_type: string; wording_version: string }>(
              "select channel, body, message_type, wording_version from public.message_templates where organization_id = $1 and notice_kind = 'signature_reminder' order by channel",
              [org],
            )
          ).rows,
      );
      expect(templates.map((t) => t.channel)).toEqual(["email", "sms"]);
      expect(templates[1]).toMatchObject({ message_type: "requested_document", wording_version: "signature-draft-1" });
      expect(templates[1].body).toBe('שלום {שם פרטי}, המסמך "{שם המסמך}" מ-{שם העסק} ממתין לחתימתך עד {תאריך}: {קישור}. {שם העסק}, {טלפון העסק}');
      const sendable = await asAdmin(
        async (q) =>
          (
            await one<{ p: string | null }>(
              q,
              "select app.message_template_sendable($1, (select id from public.message_templates where organization_id = $1 and notice_kind = 'signature_reminder' and channel = 'sms')) as p",
              [org],
            )
          ).p,
      );
      expect(sendable).toBeNull();
      // once per document
      await customerJob();
      expect((await jobs(d.id)).length).toBe(1);

      // the preferred channel; signing cancels the job still waiting
      const byMail = await person("אורית", { phone: "050-7654321", email: "orit@example.test", channel: "email" });
      const d2 = await dueSoon(byMail);
      await customerJob();
      expect((await jobs(d2.id))[0].payload.channel).toBe("email");
      expect((await sign(d2.token, (await page(d2.token)).fingerprint as string)).status).toBe("signed");
      expect((await jobs(d2.id))[0]).toMatchObject({ status: "refused", last_error: "refused:document_closed" });

      // a deleted template is not brought back: email only now
      await asAdmin((q) => q("delete from public.message_templates where organization_id = $1 and notice_kind = 'signature_reminder' and channel = 'sms'", [org]));
      const d3 = await dueSoon(await person("תמר", { phone: "050-1112222", email: "tamar@example.test" }));
      await customerJob();
      expect((await jobs(d3.id))[0].payload.channel).toBe("email");
      expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind = 'signature_reminder'", [org]))).toBe(1);
      // no address on a channel with a template: nothing, tried again later
      const d4 = await dueSoon(await person("בלי", { phone: "050-3334444" }));
      await customerJob();
      expect(await jobs(d4.id)).toEqual([]);
      expect(await outcome(d4.id)).toBe("no_template");
    });

    it("a deal's document goes to the deal's contact; a company's document has no one; not before the window, not when off", async () => {
      const contact = await person("דנה", { email: "dana@example.test" });
      const { pipelineId, stages } = await defaultPipeline(org);
      const deal = await run(member, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקת דנה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stages[0].id, member.id, contact],
          )
        ).id,
      );
      const dd = await dueSoon(deal, "deal", dealTemplate);
      await customerJob();
      expect((await jobs(dd.id))[0].payload).toMatchObject({ channel: "email", contact_id: contact, deal_id: deal });

      const companyTemplate = await asAdmin(
        async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.document_templates (organization_id, name, kind, record_type, body) values ($1, 'הסכם חברה', 'other', 'company', 'הסכם עם {שם העסק}.') returning id",
              [org],
            )
          ).id,
      );
      const company = await run(member, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה', $2) returning id", [org, member.id])).id);
      const dc = await dueSoon(company, "company", companyTemplate);
      await customerJob();
      expect(await jobs(dc.id)).toEqual([]);
      expect(await outcome(dc.id)).toBe("no_customer");

      const later = await dueSoon(await person("מאוחר", { email: "late@example.test" }), "contact", template, 5);
      await customerJob();
      expect(await jobs(later.id)).toEqual([]);
      expect(await outcome(later.id)).toBeNull();

      await setDays(org, 3);
      await asAdmin((q) => q("update public.org_document_settings set signature_customer_reminder = false where organization_id = $1", [org]));
      try {
        const off = await dueSoon(await person("כבוי", { email: "off@example.test" }));
        await customerJob();
        expect(await jobs(off.id)).toEqual([]);
      } finally {
        await asAdmin((q) => q("update public.org_document_settings set signature_customer_reminder = true where organization_id = $1", [org]));
      }
    });

    it("a template that cannot be sent queues nothing and tells the owners and admins; the payload key is for requested_document only", async () => {
      await asAdmin((q) => q("update public.message_templates set body = body || ' https://evil.example.com' where organization_id = $1 and notice_kind = 'signature_reminder'", [org]));
      try {
        const d = await dueSoon(await person("קישור", { email: "link@example.test" }));
        await customerJob();
        expect(await jobs(d.id)).toEqual([]);
        expect(await outcome(d.id)).toBe("template:external_link");
      } finally {
        await asAdmin((q) => q("update public.message_templates set body = replace(body, ' https://evil.example.com', '') where organization_id = $1 and notice_kind = 'signature_reminder'", [org]));
      }
      const ok = (payload: Record<string, unknown>) =>
        asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).ok);
      const base = { channel: "sms", contact_id: owner.id, message_type: "requested_document", signature_document_id: owner.id };
      expect(await ok(base)).toBe(true);
      expect(await ok({ ...base, message_type: "collection" })).toBe(false);
      expect(await ok({ ...base, signature_document_id: "x" })).toBe(false);
      // the setting: owners and admins only
      expect(await run(member, async (q) => (await q("update public.org_document_settings set signature_customer_reminder = false where organization_id = $1 returning id", [org])).rowCount)).toBe(0);
      expect(await run(admin, async (q) => (await q("update public.org_document_settings set signature_customer_reminder = true where organization_id = $1 returning id", [org])).rowCount)).toBe(1);
    });

    it("review L1: signing one document cancels only its own waiting job, not another document's or another business's", async () => {
      const d1 = await dueSoon(await person("ראשונה", { email: "first@example.test" }));
      const d2 = await dueSoon(await person("שנייה", { email: "second@example.test" }));
      const theirs = await run(outsider, async (q) =>
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, email) values ($1, 'זרה', $2, 'zara@example.test') returning id", [otherOrg, outsider.id])).id,
      );
      const other = await send(outsider, otherOrg, otherTemplate, "contact", theirs);
      const yesterday = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone $1)::date - 1, 'YYYY-MM-DD') as d", [workZone])).d);
      await sentOn(other.id, yesterday, workZone);
      await asAdmin((q) => q("update public.signature_documents set expires_at = app.signature_valid_until(organization_id, 2) where id = $1", [other.id]));
      await customerJob();
      for (const d of [d1, d2, other]) expect((await jobs(d.id))[0]?.status, d.id).toBe("queued");
      expect((await sign(d2.token, (await page(d2.token)).fingerprint as string)).status).toBe("signed");
      expect((await jobs(d2.id))[0].status).toBe("refused");
      expect((await jobs(d1.id))[0].status).toBe("queued");
      expect((await jobs(other.id))[0].status).toBe("queued");
    });

    it("review L2: never on the sending day, never without the `signatures` key", async () => {
      // sent today, last day the day after tomorrow: the window has come, the sending day has not passed
      const today = await send(member, org, template, "contact", await person("היום", { email: "today@example.test" }));
      await asAdmin((q) => q("update public.signature_documents set expires_at = app.signature_valid_until(organization_id, 2) where id = $1", [today.id]));
      await customerJob();
      expect(await jobs(today.id)).toEqual([]);
      expect(await outcome(today.id)).toBeNull();

      const noKey = await dueSoon(await person("מפתח", { email: "key@example.test" }));
      await setPlan(org, { signatures: false });
      try {
        await customerJob();
      } finally {
        await setPlan(org, { signatures: true });
      }
      expect(await jobs(noKey.id)).toEqual([]);
      expect(await outcome(noKey.id)).toBeNull();
    });

    it("review L4: switching the customer's reminder off cancels the business's waiting reminders", async () => {
      const d = await dueSoon(await person("כיבוי", { email: "switch@example.test" }));
      await customerJob();
      expect((await jobs(d.id))[0].status).toBe("queued");
      const before = await asAdmin(async (q) => Number((await q<{ n: number }>("select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = 'reminder_off'", [org])).rows[0].n));
      await run(owner, (q) => q("update public.org_document_settings set signature_customer_reminder = false where organization_id = $1", [org]));
      try {
        expect((await jobs(d.id))[0]).toMatchObject({ status: "refused", last_error: "refused:reminder_off" });
        const after = await asAdmin(async (q) => Number((await q<{ n: number }>("select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = 'reminder_off'", [org])).rows[0].n));
        // every reminder of the business that still waited (earlier tests left some), each counted once
        expect(after).toBeGreaterThan(before);
        const waiting = await asAdmin((q) =>
          count(q, "select 1 from app.jobs j join app.signature_customer_reminders r on r.job_id = j.id where r.organization_id = $1 and j.status = 'queued'", [org]),
        );
        expect(waiting).toBe(0);
        // another business's reminders stay
        expect(await asAdmin((q) => count(q, "select 1 from app.jobs j join app.signature_customer_reminders r on r.job_id = j.id where r.organization_id = $1 and j.status = 'queued'", [otherOrg]))).toBeGreaterThan(0);
      } finally {
        await run(owner, (q) => q("update public.org_document_settings set signature_customer_reminder = true where organization_id = $1", [org]));
      }
    });

    it("review M1: the system's own templates are refused on the card's SMS and email and by a rule; their fields stay theirs", async () => {
      await setPlan(org, { signatures: true, sms: true });
      try {
        const contact = await person("כרטיס", { phone: "050-9998888", email: "card@example.test" });
        const tpl = (channel: string) =>
          asAdmin(async (q) =>
            (await q<{ id: string }>("select id from public.message_templates where organization_id = $1 and notice_kind = 'signature_reminder' and channel = $2", [org, channel])).rows[0]?.id,
          );
        // the SMS template was deleted above: seed a fresh business's pair is not needed, mark one of the business's own
        const email = await tpl("email");
        expect(email).toBeDefined();
        const emailError = await pgError(run(member, (q) => q("select public.record_email_send($1, 'contact', $2, $3)", [org, contact, email])));
        expect(emailError.hint).toBe("record_message:notice_template");
        const sms = await asAdmin(async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.message_templates (organization_id, name, channel, message_type, body, notice_kind) values ($1, 'תזכורת מערכת (SMS)', 'sms', 'requested_document', 'שלום {שם פרטי}: {קישור}', 'signature_reminder') returning id",
              [org],
            )
          ).id,
        );
        const smsError = await pgError(run(member, (q) => q("select public.record_sms_send($1, 'contact', $2, $3)", [org, contact, sms])));
        expect(smsError.hint).toBe("record_message:notice_template");
        // the automation step asks the same rule
        expect(await asAdmin(async (q) => (await one<{ r: string }>(q, "select app.record_sms_template_refusal($1, $2, false) as r", [org, sms])).r)).toBe("notice_template");
        // a person's template of the same type may not hold the document's link or title
        const own = await run(owner, async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'שלי', 'sms', 'requested_document', 'המסמך {שם המסמך}: {קישור}') returning id",
              [org],
            )
          ).id,
        );
        expect(await asAdmin(async (q) => (await one<{ p: string }>(q, "select app.message_template_sendable($1, $2) as p", [org, own])).p)).toBe("field_not_allowed");
        expect(await asAdmin(async (q) => (await one<{ p: string | null }>(q, "select app.message_template_sendable($1, $2) as p", [org, sms])).p)).toBeNull();
        await asAdmin((q) => q("delete from public.message_templates where id = any ($1)", [[own, sms]]));
      } finally {
        await setPlan(org, { signatures: true });
      }
    });

    it("delta review D2: a business with no settings row whose first save inserts the switch off cancels its waiting reminders", async () => {
      const boss = await createUser("sr-norow");
      const fresh = await createOrg(boss.id, "עסק בלי הגדרות");
      await setPlan(fresh, { signatures: true });
      await setZone(fresh, workZone);
      await asUser(boss.id, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'service_agreement'", [fresh, CONTACT_BODY]));
      const tpl = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [fresh])).id);
      const contact = await asUser(boss.id, async (q) =>
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, email) values ($1, 'רות', $2, 'ruth@example.test') returning id", [fresh, boss.id])).id,
      );
      const d = await send({ id: boss.id, email: boss.email }, fresh, tpl, "contact", contact);
      const yesterday = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone $1)::date - 1, 'YYYY-MM-DD') as d", [workZone])).d);
      await sentOn(d.id, yesterday, workZone);
      await asAdmin((q) => q("update public.signature_documents set expires_at = app.signature_valid_until(organization_id, 2) where id = $1", [d.id]));
      expect(await asAdmin((q) => count(q, "select 1 from public.org_document_settings where organization_id = $1", [fresh]))).toBe(0);
      await customerJob();
      expect((await jobs(d.id))[0]?.status).toBe("queued");
      await asUser(boss.id, (q) => q("insert into public.org_document_settings (organization_id, signature_customer_reminder) values ($1, false)", [fresh]));
      expect((await jobs(d.id))[0]).toMatchObject({ status: "refused", last_error: "refused:reminder_off" });
    });

    it("review L6: seeding at the 50-template cap is recorded once and never retried", async () => {
      const fullOwner = await createUser("sr-full");
      const full = await createOrg(fullOwner.id, "עסק מלא");
      await asAdmin(async (q) => {
        const have = Number((await one<{ n: string }>(q, "select count(*) as n from public.message_templates where organization_id = $1", [full])).n);
        for (let i = have; i < 50; i += 1) {
          await q("insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, $2, 'sms', 'marketing', 'שלום')", [full, `מילוי ${i}`]);
        }
      });
      await asAdmin((q) => q("select app.seed_signature_reminder_templates($1)", [full]));
      expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind = 'signature_reminder'", [full]))).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from app.signature_template_seeds where organization_id = $1", [full]))).toBe(2);
    });
  });

  it("review L2: a first reminder whose day passed more than a week ago is never made", async () => {
    const contact = await newContact(member, org, "ישנה");
    const sent = await send(member, org, template, "contact", contact);
    const old = await asAdmin(async (q) =>
      (
        await one<{ d: string }>(
          q,
          `select to_char(d, 'YYYY-MM-DD') as d from generate_series((now() at time zone $2)::date - 40, (now() at time zone $2)::date - 1, interval '1 day') g(d)
            where app.add_business_days($1, d::date, 3) < (now() at time zone $2)::date - 7 order by d desc limit 1`,
          [org, workZone],
        )
      ).d,
    );
    await sentOn(sent.id, old, workZone);
    await remindJob();
    expect(await reminderTasks(sent.id)).toEqual([]);
  });

  it("review L2: an expired document that is erased or detached gets no notice", async () => {
    const contact = await newContact(member, org, "בלי התראה");
    const erased = await send(member, org, template, "contact", contact, 5);
    const detached = await send(member, org, template, "contact", contact, 5);
    await asAdmin((q) => q("update public.signature_documents set erased_at = now(), expires_at = now() - interval '1 minute' where id = $1", [erased.id]));
    await asAdmin((q) =>
      q("update public.signature_documents set contact_id = null, former_contact_id = $2, customer_deleted_at = now(), expires_at = now() - interval '1 minute' where id = $1", [detached.id, contact]),
    );
    await expireJob();
    expect((await doc(erased.id)).expired_at).not.toBeNull();
    expect((await doc(detached.id)).expired_at).not.toBeNull();
    expect((await notices(org, "פג תוקף של מסמך לחתימה")).filter((n) => n.entity_id === contact)).toEqual([]);
  });

  it("review L5: an open task whose owner left is not re-dated: a new task by the owner rule", async () => {
    const leaver = await addMember(org, owner.id, "member", "sr-left");
    const contact = await newContact(leaver, org, "עזבה");
    const sent = await send(leaver, org, template, "contact", contact);
    const day = await sentDay(org, workZone, 3, true);
    await sentOn(sent.id, day, workZone);
    await remindJob();
    const [first] = await reminderTasks(sent.id);
    expect(first.owner_id).toBe(leaver.id);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    await asAdmin((q) => q("update app.signature_reminders set last_reminder_day = $2::date where document_id = $1", [sent.id, day]));
    await remindJob();
    const [second] = await reminderTasks(sent.id);
    expect(second.id).not.toBe(first.id);
    expect(second.owner_id).toBe(owner.id);
    expect((await asAdmin((q) => one<{ reminders: number }>(q, "select reminders from app.signature_reminders where document_id = $1", [sent.id]))).reminders).toBe(2);
    // delta review D3: the old task is closed in the same step
    expect(await asAdmin((q) => one<{ status: string; outcome: string }>(q, "select status, outcome from public.tasks where id = $1", [first.id]))).toEqual({
      status: "done",
      outcome: "נסגרה: הועברה לאחראי אחר",
    });
  });

  it("review L3: an open reminder task someone holds right now waits for the next run", async () => {
    const contact = await newContact(member, org, "נעולה");
    const sent = await send(member, org, template, "contact", contact);
    const day = await sentDay(org, workZone, 3, true);
    await sentOn(sent.id, day, workZone);
    await remindJob();
    const [task] = await reminderTasks(sent.id);
    await asAdmin((q) => q("update app.signature_reminders set last_reminder_day = $2::date where document_id = $1", [sent.id, day]));
    // a second connection holds the task while the job runs
    await asAdmin(async (hold) => {
      await hold("select 1 from public.tasks where id = $1 for update", [task.id]);
      await remindJob();
    });
    expect((await asAdmin((q) => one<{ reminders: number }>(q, "select reminders from app.signature_reminders where document_id = $1", [sent.id]))).reminders).toBe(1);
    await remindJob();
    expect((await asAdmin((q) => one<{ reminders: number }>(q, "select reminders from app.signature_reminders where document_id = $1", [sent.id]))).reminders).toBe(2);
  });

  it("the job functions are not callable by clients", async () => {
    for (const fn of ["app.expire_signature_documents()", "app.send_signature_reminders()", "app.send_signature_customer_reminders()"]) {
      expect((await pgError(run(owner, (q) => q(`select ${fn}`)))).code).toBe("42501");
      expect((await pgError(asService((q) => q(`select ${fn}`)))).code).toBe("42501");
    }
  });
});
