import { afterAll, beforeAll, describe, expect, it } from "vitest";

import VALIDITY_ENDS from "../unit/fixtures/contract-validity-end.json";
import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = Record<string, unknown> & { fingerprint?: string | null };
type Draft = { segments: { locked: boolean; text: string }[] };

const CONTACT_BODY = "הסכם בין {שם העסק} לבין {שם פרטי}.";
const WORDING = "sign-draft-2026-11-10";
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
 * SGN-04 (lead's choices, owner's answers pending): a signed document's valid_until / renewal_on (the template's default
 * fills valid_until at signing; whoever may edit the record changes both), and one alert (a task and a signature_reminder
 * notice) per document and target day, contract_renewal_days (default 30, 0 = off) before it.
 */
describe("contract validity and renewal alerts (SGN-04)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let template: string, otherTemplate: string;
  let workZone: string, earlyZone: string;

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setPlan = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const setZone = (orgId: string, zone: string) => asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [orgId, zone]));
  const setDays = (orgId: string, days: number) =>
    asAdmin(async (q) => {
      const updated = await q("update public.org_document_settings set contract_renewal_days = $2 where organization_id = $1", [orgId, days]);
      if (updated.rowCount === 0) await q("insert into public.org_document_settings (organization_id, contract_renewal_days) values ($1, $2)", [orgId, days]);
    });
  const newContact = (u: U, orgId: string, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  const send = (u: U, orgId: string, tpl: string, record: string) =>
    run(u, async (q) => {
      const d = (await one<{ d: Draft }>(q, "select public.signature_document_draft($1, $2, 'contact', $3) as d", [orgId, tpl, record])).d;
      const body = d.segments.map((seg) => seg.text).join("\n");
      return (await one<{ r: { id: string; token: string } }>(q, "select public.signature_document_send($1, $2, 'contact', $3, '', $4, null) as r", [orgId, tpl, record, body])).r;
    });
  const sign = (token: string) =>
    asService(async (q) => {
      const p = (await one<{ p: Page }>(q, "select public.signature_public($1, null) as p", [token])).p;
      return (
        await one<{ r: { status: string } }>(
          q,
          `select public.signature_public_sign(p_token => $1, p_fingerprint => $2, p_signer_name => 'דנה כהן', p_id_number => null,
                   p_signature_kind => 'typed', p_signature_image => null, p_wording_version => $3, p_agreed => true,
                   p_ip => '203.0.113.5', p_user_agent => 'test') as r`,
          [token, p.fingerprint, WORDING],
        )
      ).r;
    });
  const signed = async (u: U, orgId: string, tpl: string, record: string) => {
    const d = await send(u, orgId, tpl, record);
    expect((await sign(d.token)).status).toBe("signed");
    return d.id;
  };
  const setValidity = (u: U, orgId: string, docId: string, validUntil: string | null, renewalOn: string | null) =>
    run(u, (q) => q("select public.signature_document_set_validity($1, $2, $3::date, $4::date)", [orgId, docId, validUntil, renewalOn]));
  const doc = (id: string) =>
    asAdmin((q) => one<{ valid_until: string | null; renewal_on: string | null; signed_day: string }>(
      q,
      `select to_char(d.valid_until, 'YYYY-MM-DD') as valid_until, to_char(d.renewal_on, 'YYYY-MM-DD') as renewal_on,
              to_char((d.signed_at at time zone app.intake_zone(o.timezone))::date, 'YYYY-MM-DD') as signed_day
         from public.signature_documents d join public.organizations o on o.id = d.organization_id where d.id = $1`,
      [id],
    ));
  // the business's today plus n days
  const day = (orgId: string, n: number) =>
    asAdmin(async (q) =>
      (await one<{ d: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone))::date + $2::int, 'YYYY-MM-DD') as d from public.organizations o where o.id = $1", [orgId, n])).d,
    );
  const job = (perOrg: number | null = null) =>
    asAdmin(async (q) => {
      if (perOrg !== null) await q("select set_config('app.signature_job_per_org', $1, true)", [String(perOrg)]);
      return Number((await one<{ n: number }>(q, "select app.send_contract_renewals() as n")).n);
    });
  const tasks = (docId: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ id: string; title: string; owner_id: string; status: string; outcome: string | null; contact_id: string | null; due_at: string; description: string }>(
            `select distinct t.id, t.title, t.owner_id, t.status, t.outcome, t.contact_id, t.due_at::text as due_at, t.description, t.created_at
               from app.contract_renewal_tasks k join public.tasks t on t.id = k.task_id where k.document_id = $1 order by t.created_at`,
            [docId],
          )
        ).rows,
    );
  const notices = (orgId: string, taskId: string) =>
    asAdmin(async (q) =>
      (await q<{ user_id: string; type: string; title: string; body: string }>("select user_id, type, title, body from public.notifications where organization_id = $1 and entity_type = 'task' and entity_id = $2", [orgId, taskId])).rows,
    );

  beforeAll(async () => {
    owner = await createUser("cr-owner");
    org = await createOrg(owner.id, "עסק החוזים");
    admin = await addMember(org, owner.id, "admin", "cr-admin");
    member = await addMember(org, owner.id, "member", "cr-member");
    other = await addMember(org, owner.id, "member", "cr-other");
    viewer = await addMember(org, owner.id, "viewer", "cr-viewer");
    outsider = await createUser("cr-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setPlan(org, { signatures: true });
    await setPlan(otherOrg, { signatures: true });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    for (const [o, u] of [
      [org, owner],
      [otherOrg, outsider],
    ] as const) {
      await run(u, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'service_agreement'", [o, CONTACT_BODY]));
    }
    const tpl = (o: string) => asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [o])).id);
    template = await tpl(org);
    otherTemplate = await tpl(otherOrg);
    const zones = await asAdmin(async (q) =>
      (await q<{ z: string; h: number }>("select z, extract(hour from now() at time zone z)::int as h from unnest($1::text[]) z", [ZONES])).rows,
    );
    workZone = zones.find((z) => z.h >= 9 && z.h <= 20)!.z;
    earlyZone = zones.find((z) => z.h <= 6)!.z;
    await setZone(org, workZone);
    await setZone(otherOrg, workZone);
  });

  it("the lead time: 30 by default, 0..365, owners and admins write it, every member reads it", async () => {
    const fresh = await createUser("cr-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש");
    await run(fresh, (q) => q("insert into public.org_document_settings (organization_id) values ($1) on conflict do nothing", [freshOrg]));
    expect((await run(fresh, (q) => one<{ d: number }>(q, "select contract_renewal_days as d from public.org_document_settings where organization_id = $1", [freshOrg]))).d).toBe(30);
    await setDays(org, 30);
    expect(await run(admin, async (q) => (await q("update public.org_document_settings set contract_renewal_days = 45 where organization_id = $1 returning id", [org])).rowCount)).toBe(1);
    expect((await run(viewer, (q) => one<{ d: number }>(q, "select contract_renewal_days as d from public.org_document_settings where organization_id = $1", [org]))).d).toBe(45);
    expect(await run(member, async (q) => (await q("update public.org_document_settings set contract_renewal_days = 1 where organization_id = $1 returning id", [org])).rowCount)).toBe(0);
    expect(await run(outsider, async (q) => (await q("update public.org_document_settings set contract_renewal_days = 1 where organization_id = $1 returning id", [org])).rowCount)).toBe(0);
    expect((await pgError(run(owner, (q) => q("update public.org_document_settings set contract_renewal_days = 366 where organization_id = $1", [org])))).code).toBe("23514");
    expect((await pgError(run(owner, (q) => q("update public.org_document_settings set contract_renewal_days = -1 where organization_id = $1", [org])))).code).toBe("23514");
    await setDays(org, 30);
  });

  it("the template's default validity: owners and admins with the key, 1..120; without the key only a switch-off that keeps it", async () => {
    const fresh = await createUser("cr-tpl");
    const tOrg = await createOrg(fresh.id, "עסק תבניות");
    const tMember = await addMember(tOrg, fresh.id, "member", "cr-tpl-member");
    await setPlan(tOrg, { signatures: true });
    const id = (await asAdmin((q) => one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'contract'", [tOrg]))).id;
    expect(await run(fresh, async (q) => (await q("update public.document_templates set default_validity_months = 12 where id = $1 returning id", [id])).rowCount)).toBe(1);
    expect(await run(tMember, async (q) => (await q("update public.document_templates set default_validity_months = 6 where id = $1 returning id", [id])).rowCount)).toBe(0);
    expect(await run(outsider, async (q) => (await q("update public.document_templates set default_validity_months = 6 where id = $1 returning id", [id])).rowCount)).toBe(0);
    expect((await pgError(run(fresh, (q) => q("update public.document_templates set default_validity_months = 121 where id = $1", [id])))).code).toBe("23514");
    expect((await pgError(run(fresh, (q) => q("update public.document_templates set default_validity_months = 0 where id = $1", [id])))).code).toBe("23514");
    await setPlan(tOrg, { signatures: false });
    const refused = await pgError(run(fresh, (q) => q("update public.document_templates set default_validity_months = 6 where id = $1", [id])));
    expect(refused.hint).toBe("feature:signatures");
    const offAndChanged = await pgError(run(fresh, (q) => q("update public.document_templates set is_active = false, default_validity_months = 6 where id = $1", [id])));
    expect(offAndChanged.hint).toBe("feature:signatures");
    expect(await run(fresh, async (q) => (await q("update public.document_templates set is_active = false where id = $1 returning id", [id])).rowCount)).toBe(1);
    expect((await asAdmin((q) => one<{ m: number }>(q, "select default_validity_months as m from public.document_templates where id = $1", [id]))).m).toBe(12);
  });

  it("signing fills valid_until from the template's default (the last day of N months); no default = none", async () => {
    const contact = await newContact(member, org, "יעל");
    const none = await signed(member, org, template, contact);
    expect((await doc(none)).valid_until).toBeNull();
    await run(owner, (q) => q("update public.document_templates set default_validity_months = 12 where id = $1", [template]));
    try {
      const filled = await signed(member, org, template, contact);
      const d = await doc(filled);
      const expected = (await asAdmin((q) => one<{ e: string }>(q, "select to_char(($1::date + interval '12 months')::date - 1, 'YYYY-MM-DD') as e", [d.signed_day]))).e;
      expect(d.valid_until).toBe(expected);
      expect(d.renewal_on).toBeNull();
      // an unsigned document gets nothing
      const waiting = await send(member, org, template, contact);
      expect((await doc(waiting.id)).valid_until).toBeNull();
    } finally {
      await run(owner, (q) => q("update public.document_templates set default_validity_months = null where id = $1", [template]));
    }
  });

  it("the dates: whoever may edit the record sets them on a signed document, audited; everyone else is refused", async () => {
    const contact = await newContact(member, org, "מיכל");
    const id = await signed(member, org, template, contact);
    const until = await day(org, 200);
    const renew = await day(org, 150);
    await setValidity(member, org, id, until, renew);
    expect(await doc(id)).toMatchObject({ valid_until: until, renewal_on: renew });
    // the record's readers see the columns
    expect((await run(member, (q) => one<{ v: string }>(q, "select to_char(valid_until, 'YYYY-MM-DD') as v from public.signature_documents where id = $1", [id]))).v).toBe(until);
    const audit = await asAdmin((q) => one<{ changes: Record<string, { new: string }> }>(q, "select changes from public.audit_log where entity_id = $1 and action = 'signature_validity' order by created_at desc limit 1", [id]));
    expect(audit.changes.valid_until.new).toBe(until);
    // the owner and admins edit too
    await setValidity(admin, org, id, until, null);
    expect((await doc(id)).renewal_on).toBeNull();
    // another member (own visibility), a viewer and an outsider may not
    for (const u of [other, viewer, outsider]) expect((await pgError(setValidity(u, org, id, until, null))).code).toBe("42501");
    // no client writes the table
    expect((await pgError(run(owner, (q) => q("update public.signature_documents set valid_until = null where id = $1", [id])))).code).toBe("42501");
    // the rules
    expect((await pgError(setValidity(member, org, id, null, renew))).hint).toBe("signature_document:validity_renewal");
    expect((await pgError(setValidity(member, org, id, until, await day(org, 201)))).hint).toBe("signature_document:validity_renewal");
    expect((await pgError(setValidity(member, org, id, await day(org, -400), null))).hint).toBe("signature_document:validity_date");
    const waiting = await send(member, org, template, contact);
    expect((await pgError(setValidity(member, org, waiting.id, until, null))).hint).toBe("signature_document:validity_status");
    // clearing is allowed
    await setValidity(member, org, id, null, null);
    expect((await doc(id)).valid_until).toBeNull();
    // without the key, or in a read-only business
    await setPlan(org, { signatures: false });
    try {
      expect((await pgError(setValidity(member, org, id, until, null))).hint).toBe("feature:signatures");
    } finally {
      await setPlan(org, { signatures: true });
    }
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(setValidity(member, org, id, until, null))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    // an erased document's dates stay as they are
    const erased = await signed(member, org, template, contact);
    await asAdmin((q) => q("update public.signature_documents set erased_at = now() where id = $1", [erased]));
    expect((await pgError(setValidity(member, org, erased, until, null))).hint).toBe("signature_document:validity_erased");
  });

  it("the alert: one task for the sender and one notice with nothing personal, once per document and date", async () => {
    const contact = await newContact(member, org, "אורית");
    const id = await signed(member, org, template, contact);
    const far = await signed(member, org, template, contact);
    await setValidity(member, org, id, await day(org, 10), null);
    await setValidity(member, org, far, await day(org, 60), null);
    await job();
    expect(await tasks(far)).toEqual([]);
    const list = await tasks(id);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ owner_id: member.id, contact_id: contact, status: "open" });
    // never the document's title or the person's name: dates only
    expect(list[0].title).toMatch(/^לחדש חוזה שנחתם ב-\d{2}\.\d{2}\.\d{4} \(בתוקף עד \d{2}\.\d{2}\.\d{4}\)$/);
    expect(`${list[0].title} ${list[0].description}`).not.toContain("הסכם שירות");
    expect(`${list[0].title} ${list[0].description}`).not.toContain("אורית");
    const sent = await notices(org, list[0].id);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ user_id: member.id, type: "signature_reminder" });
    expect(`${sent[0].title} ${sent[0].body}`).not.toContain("אורית");
    expect(`${sent[0].title} ${sent[0].body}`).not.toContain("הסכם");
    // no 'assigned' notice beside it
    expect((await notices(org, list[0].id)).map((n) => n.type)).toEqual(["signature_reminder"]);
    await job();
    expect((await tasks(id)).length).toBe(1);
    expect((await notices(org, list[0].id)).length).toBe(1);
    // the bookkeeping is not in the API
    expect((await pgError(run(owner, (q) => q("select * from app.contract_renewal_alerts")))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("select * from app.contract_renewal_tasks")))).code).toBe("42501");

    // a new date inside the window: the same task, re-dated
    await setValidity(member, org, id, await day(org, 20), await day(org, 15));
    expect((await tasks(id))[0].status).toBe("open");
    await job();
    const moved = await tasks(id);
    expect(moved.length).toBe(1);
    expect(moved[0].due_at).not.toBe(list[0].due_at);
    expect(moved[0].description).toContain("מועד החידוש");
    // moved out of the window: the task closes itself
    await setValidity(member, org, id, await day(org, 100), null);
    expect((await tasks(id))[0]).toMatchObject({ status: "done", outcome: "נסגרה: מועד החידוש נדחה" });
    await job();
    expect((await tasks(id)).length).toBe(1);
    // back inside: a new task (the old one is done)
    await setValidity(member, org, id, await day(org, 5), null);
    await job();
    const again = await tasks(id);
    expect(again.length).toBe(2);
    expect(again[1].status).toBe("open");
    // clearing the dates closes it
    await setValidity(member, org, id, null, null);
    expect((await tasks(id))[1]).toMatchObject({ status: "done", outcome: "נסגרה: תאריך התוקף הוסר" });
  });

  it("the alert's person: the sender, else the record's owner, else the business owner", async () => {
    const recordOwner = await addMember(org, owner.id, "member", "cr-record-owner");
    const contact = await newContact(recordOwner, org, "רחל");
    // an admin sends on another person's record
    const sender = await addMember(org, owner.id, "admin", "cr-sender");
    const a = await signed(sender, org, template, contact);
    const b = await signed(sender, org, template, contact);
    await setValidity(sender, org, a, await day(org, 3), null);
    await setValidity(sender, org, b, await day(org, 3), null);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, sender.id]));
    await asAdmin((q) => q("update public.signature_documents set valid_until = null where id = $1", [b]));
    await job();
    expect((await tasks(a))[0].owner_id).toBe(recordOwner.id);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, recordOwner.id]));
    // the record owner's open task is closed and a new one goes to the business owner on the next date
    await asAdmin((q) => q("update public.signature_documents set valid_until = (now() at time zone 'UTC')::date + 4 where id = $1", [b]));
    await job();
    expect((await tasks(b))[0].owner_id).toBe(owner.id);
    await asAdmin((q) => q("update public.signature_documents set valid_until = (now() at time zone 'UTC')::date + 6 where id = $1", [a]));
    await job();
    const aTasks = await tasks(a);
    expect(aTasks[0]).toMatchObject({ status: "done", outcome: "נסגרה: הועברה לאחראי אחר" });
    expect(aTasks[1].owner_id).toBe(owner.id);
  });

  it("no alert when off, without the key, in a business that is not writable, before 08:00, for an erased document or a record in the bin", async () => {
    const contact = await newContact(member, org, "שקט");
    const id = await signed(member, org, template, contact);
    await setValidity(member, org, id, await day(org, 3), null);

    await setDays(org, 0);
    await job();
    await setDays(org, 30);
    expect(await tasks(id)).toEqual([]);

    await setPlan(org, { signatures: false });
    await job();
    await setPlan(org, { signatures: true });
    expect(await tasks(id)).toEqual([]);

    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await job();
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect(await tasks(id)).toEqual([]);

    await setZone(org, earlyZone);
    try {
      await job();
    } finally {
      await setZone(org, workZone);
    }
    expect(await tasks(id)).toEqual([]);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await job();
    expect(await tasks(id)).toEqual([]);
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [contact]));

    // now it comes; an erasure of the document closes the task
    await job();
    expect((await tasks(id)).length).toBe(1);
    await asAdmin((q) => q("update public.signature_documents set erased_at = now() where id = $1", [id]));
    expect((await tasks(id))[0]).toMatchObject({ status: "done", outcome: "נסגרה: פרטי המסמך נמחקו" });
  });

  it("businesses are apart: each alert is in its own business, and the job takes turns", async () => {
    const mine = await newContact(member, org, "תור");
    const theirs = await newContact(outsider, otherOrg, "תור");
    const a = await signed(member, org, template, mine);
    const b = await signed(outsider, otherOrg, otherTemplate, theirs);
    await setValidity(member, org, a, await day(org, 2), null);
    await setValidity(outsider, otherOrg, b, await day(otherOrg, 2), null);
    // an outsider cannot touch this business's document
    expect((await pgError(setValidity(outsider, org, a, null, null))).code).toBe("42501");
    expect((await pgError(setValidity(outsider, otherOrg, a, null, null))).code).toBe("42501");
    await job();
    const mineTask = (await tasks(a))[0];
    const theirTask = (await tasks(b))[0];
    expect(mineTask.owner_id).toBe(member.id);
    expect(theirTask.owner_id).toBe(outsider.id);
    const orgOf = (taskId: string) => asAdmin(async (q) => (await one<{ o: string }>(q, "select organization_id as o from public.tasks where id = $1", [taskId])).o);
    expect(await orgOf(mineTask.id)).toBe(org);
    expect(await orgOf(theirTask.id)).toBe(otherOrg);
    expect((await run(outsider, (q) => q("select id from public.signature_documents where id = $1", [a]))).rowCount).toBe(0);
  });

  it("review 4: the last day of N months equals the app's rule (shared fixture)", async () => {
    for (const c of VALIDITY_ENDS) {
      const got = (await asAdmin((q) => one<{ e: string }>(q, "select to_char(app.contract_validity_end($1::date, $2), 'YYYY-MM-DD') as e", [c.day, c.months]))).e;
      expect(got, `${c.day} + ${c.months}`).toBe(c.end);
    }
  });

  it("review 1: a target that comes back to a day already alerted is alerted again, and the task follows the target", async () => {
    const contact = await newContact(member, org, "חוזרת");
    const id = await signed(member, org, template, contact);
    const d5 = await day(org, 5);
    await setValidity(member, org, id, d5, null);
    await job();
    expect((await tasks(id)).length).toBe(1);
    // cleared (the task closes), then the same day again: a new task
    await setValidity(member, org, id, null, null);
    expect((await tasks(id))[0].status).toBe("done");
    await setValidity(member, org, id, d5, null);
    await job();
    const back = await tasks(id);
    expect(back.length).toBe(2);
    expect(back[1].status).toBe("open");
    // out of the window and back: a new task again
    await setValidity(member, org, id, await day(org, 200), null);
    expect((await tasks(id))[1].status).toBe("done");
    await setValidity(member, org, id, d5, null);
    await job();
    expect((await tasks(id)).filter((t) => t.status === "open").length).toBe(1);
    // +5 -> +10 -> +5 inside the window: one open task, due on the current target
    const dueOf = async () => (await tasks(id)).filter((t) => t.status === "open").map((t) => t.due_at);
    const first = await dueOf();
    await setValidity(member, org, id, await day(org, 10), null);
    await job();
    const second = await dueOf();
    expect(second.length).toBe(1);
    expect(second[0]).not.toBe(first[0]);
    await setValidity(member, org, id, d5, null);
    await job();
    const third = await dueOf();
    expect(third.length).toBe(1);
    expect(third[0]).toBe(first[0]);
  });

  it("review 2: a change of the last day alone retitles the open task in place", async () => {
    const contact = await newContact(member, org, "כותרת");
    const id = await signed(member, org, template, contact);
    const renew = await day(org, 5);
    await setValidity(member, org, id, await day(org, 40), renew);
    await job();
    const before = (await tasks(id))[0];
    const later = await day(org, 90);
    await setValidity(member, org, id, later, renew);
    const after = await tasks(id);
    expect(after.length).toBe(1);
    expect(after[0].status).toBe("open");
    expect(after[0].title).not.toBe(before.title);
    expect(after[0].title).toContain(`${later.slice(8, 10)}.${later.slice(5, 7)}.${later.slice(0, 4)}`);
    expect(after[0].description).toContain(`${later.slice(8, 10)}.${later.slice(5, 7)}.${later.slice(0, 4)}`);
  });

  it("review 3: renewal tasks never carry the document's title, and a named person's erasure leaves them as they are", async () => {
    const contact = await newContact(member, org, "נמחקת");
    const id = await signed(member, org, template, contact);
    await setValidity(member, org, id, await day(org, 5), null);
    await job();
    // an earlier task, done
    await setValidity(member, org, id, null, null);
    await setValidity(member, org, id, await day(org, 6), null);
    await job();
    const list = await tasks(id);
    expect(list.length).toBe(2);
    const titles = list.map((t) => t.title);
    expect(list.every((t) => !t.title.includes("הסכם שירות"))).toBe(true);
    // a named person's erasure has nothing to change on them
    await asAdmin((q) => q("update public.signature_documents set text_erased_at = now() where id = $1", [id]));
    const after = await tasks(id);
    expect(after.length).toBe(2);
    expect(after.map((t) => t.title)).toEqual(titles);
    for (const t of after) expect(t.title).toContain("לחדש חוזה שנחתם ב-");
    // nothing of the document's title in the tasks' audit entries
    const audited = await asAdmin(async (q) =>
      (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_type = 'tasks' and entity_id = any ($1)", [after.map((t) => t.id)])).rows,
    );
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.some((row) => row.c.includes("הסכם שירות"))).toBe(false);
  });

  it("review 5: a failing alert is counted, and a failing count never stops the job", async () => {
    const contact = await newContact(member, org, "תקלה");
    const id = await signed(member, org, template, contact);
    await setValidity(member, org, id, await day(org, 4), null);
    const rollback = new Error("rollback");
    await expect(
      asAdmin(async (q) => {
        // inside one transaction that is rolled back: the task insert fails, then the bookkeeping too
        await q("create function public.zz_test_fail() returns trigger language plpgsql as $f$ begin raise exception 'boom'; end $f$");
        await q("create trigger zz_test_fail before insert on public.tasks for each row execute function public.zz_test_fail()");
        await q("select app.send_contract_renewals()");
        const counted = await q<{ f: number }>("select failures as f from app.contract_renewal_alerts where document_id = $1", [id]);
        expect(counted.rows[0]?.f).toBe(1);
        await q("create trigger zz_test_fail before insert or update on app.contract_renewal_alerts for each row execute function public.zz_test_fail()");
        // the bookkeeping fails as well: the job still ends normally
        await q("select app.send_contract_renewals()");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await tasks(id)).toEqual([]);
  });
});
