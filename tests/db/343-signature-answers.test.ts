import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WORDING = "sign-draft-2026-11-10";
const QUOTE_WORDING = "draft-2026-10-18";
const BODY = "**הסכם שירות**\n\nההסכם נערך בין {שם העסק} לבין {שם פרטי}.";
const UA = "Mozilla/5.0 (Linux; Android 14) rep-tablet";
const EXPIRED_OUTCOME = "נסגרה: פג תוקף החוזה";

/**
 * The owner's answers of 12 November 2026 (migration 021230): (283) ב an open renewal task of a contract whose validity ended
 * closes by itself and the contract is marked; (287) ב an in-person signature keeps the IP address of the rep's device (sent
 * by the server in the x-crm-device-ip header); (288) ב the rep makes the signed PDF within 24 hours; (289) ב when the rep
 * would be the only recipient of the notice, the owners and admins get it; (290) ב a quote may be declined in person.
 */
describe("signature answers of 12 November 2026 (SGN-04, SGN-07)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U;
  let org: string, plainOrg: string, plainOwner: U;
  let template: string, plainTemplate: string;
  let pipe: { pipelineId: string; stageId: string };

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const can = async (role: string, fn: string) => (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn]))).c;
  // the header the server action sends (clientIp() of the rep's request)
  const deviceIp = (q: Query, ip: string | null) => (ip === null ? Promise.resolve() : q("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-crm-device-ip": ip })]));

  const newContact = (u: U, name: string, orgId = org) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  const sendDoc = (u: U, contact: string, orgId = org, tpl = template) =>
    run(u, async (q) => {
      const d = (await one<{ d: { segments: { text: string }[] } }>(q, "select public.signature_document_draft($1, $2, 'contact', $3) as d", [orgId, tpl, contact])).d;
      return (
        await one<{ r: { id: string; token: string } }>(q, "select public.signature_document_send($1, $2, 'contact', $3, '', $4, null) as r", [
          orgId,
          tpl,
          contact,
          d.segments.map((s) => s.text).join("\n"),
        ])
      ).r;
    });
  const fingerprintOf = (doc: string) => asAdmin(async (q) => (await one<{ f: string }>(q, "select content_sha256 as f from public.signature_documents where id = $1", [doc])).f);
  const signInPerson = (u: U, doc: string, ip: string | null, orgId = org) =>
    run(u, async (q) => {
      await deviceIp(q, ip);
      return (
        await one<{ r: { status: string } }>(
          q,
          `select public.signature_in_person_sign(p_org => $1, p_doc => $2, p_fingerprint => $3, p_signer_name => 'דנה כהן',
                   p_signature_kind => 'drawn', p_signature_image => $4, p_wording_version => $5, p_agreed => true,
                   p_user_agent => $6) as r`,
          [orgId, doc, await fingerprintOf(doc), PNG, WORDING, UA],
        )
      ).r;
    });

  const newQuote = (u: U, withLink = true) =>
    run(u, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          pipe.stageId,
          u.id,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה לבדיקה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, quantity, unit_price_agorot) values ($1, $2, 1, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      if (withLink) await q("select public.quote_link_create($1, $2)", [org, id]);
      return id;
    });
  const quoteFingerprint = (quote: string) =>
    asAdmin(async (q) => (await one<{ f: string }>(q, "select app.quote_fingerprint(q) as f from public.quotes q where q.id = $1", [quote])).f);
  const acceptInPerson = (u: U, quote: string, ip: string | null) =>
    run(u, async (q) => {
      await deviceIp(q, ip);
      return (
        await one<{ r: { status: string } }>(
          q,
          `select public.quote_in_person_accept(p_org => $1, p_quote => $2, p_fingerprint => $3, p_signer_name => 'נועה לוי',
                   p_signature_kind => 'drawn', p_signature_image => $4, p_wording_version => $5, p_agreed => true,
                   p_user_agent => $6) as r`,
          [org, quote, await quoteFingerprint(quote), PNG, QUOTE_WORDING, UA],
        )
      ).r;
    });
  const declineInPerson = (u: U, quote: string, args: { ip?: string | null; reason?: string | null; fingerprint?: string; name?: string | null } = {}) =>
    run(u, async (q) => {
      await deviceIp(q, args.ip ?? null);
      return (
        await one<{ r: { status: string } }>(
          q,
          "select public.quote_in_person_decline(p_org => $1, p_quote => $2, p_fingerprint => $3, p_signer_name => $4, p_decline_reason => $5, p_user_agent => $6) as r",
          [org, quote, args.fingerprint ?? (await quoteFingerprint(quote)), args.name ?? null, args.reason ?? null, UA],
        )
      ).r;
    });

  // the business's today plus n days
  const day = (orgId: string, n: number) =>
    asAdmin(async (q) =>
      (await one<{ d: string }>(q, "select to_char((now() at time zone app.intake_zone(o.timezone))::date + $2::int, 'YYYY-MM-DD') as d from public.organizations o where o.id = $1", [orgId, n])).d,
    );
  // a signed contract whose last day is `lastDay` days from today, with one open renewal task (made before it ended)
  const contractWithTask = async (lastDay: number, orgId = org, u: U = member, tpl = template) => {
    const contact = await newContact(u, "חוזה", orgId);
    const sent = await sendDoc(u, contact, orgId, tpl);
    expect((await signInPerson(u, sent.id, null, orgId)).status).toBe("signed");
    await asAdmin((q) => q("update public.signature_documents set signed_at = now() - interval '400 days' where id = $1", [sent.id]));
    await asAdmin((q) => q("update public.signature_signatures set signed_at = now() - interval '400 days' where document_id = $1", [sent.id]));
    const until = await day(orgId, lastDay);
    await run(u, (q) => q("select public.signature_document_set_validity($1, $2, $3::date, null)", [orgId, sent.id, until]));
    const task = await asAdmin(async (q) => {
      const t = (
        await one<{ id: string }>(
          q,
          "insert into public.tasks (organization_id, title, task_type, due_at, owner_id, contact_id) values ($1, 'לחדש חוזה', 'todo', now(), $2, $3) returning id",
          [orgId, u.id, contact],
        )
      ).id;
      await q("insert into app.contract_renewal_tasks (organization_id, document_id, task_id) values ($1, $2, $3)", [orgId, sent.id, t]);
      return t;
    });
    return { doc: sent.id, task, contact };
  };
  const taskOf = (id: string) => asAdmin((q) => one<{ status: string; outcome: string | null }>(q, "select status, outcome from public.tasks where id = $1", [id]));
  const marked = (doc: string) =>
    asAdmin(async (q) => (await one<{ m: boolean }>(q, "select contract_expired_at is not null as m from public.signature_documents where id = $1", [doc])).m);
  const closeJob = () => asAdmin(async (q) => Number((await one<{ n: number }>(q, "select app.close_expired_contract_renewals() as n")).n));

  beforeAll(async () => {
    owner = await createUser("sa-owner");
    org = await createOrg(owner.id, "עסק התשובות");
    admin = await addMember(org, owner.id, "admin", "sa-admin");
    member = await addMember(org, owner.id, "member", "sa-member");
    other = await addMember(org, owner.id, "member", "sa-other");
    viewer = await addMember(org, owner.id, "viewer", "sa-viewer");
    plainOwner = await createUser("sa-plain");
    plainOrg = await createOrg(plainOwner.id, "עסק בלי חתימות");
    for (const o of [org, plainOrg]) {
      await asAdmin((q) =>
        q(
          "update public.subscriptions set feature_overrides = '{\"signatures\": true}'::jsonb, limit_overrides = '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1",
          [o],
        ),
      );
    }
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    for (const [o, u] of [
      [org, owner],
      [plainOrg, plainOwner],
    ] as const) {
      await run(u, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'service_agreement'", [o, BODY]));
    }
    const tpl = (o: string) => asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [o])).id);
    template = await tpl(org);
    plainTemplate = await tpl(plainOrg);
    await run(owner, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages.find((s) => s.kind === "open")!.id };
  });

  it("grants: the decline is for signed-in people, the helpers for no role, the mark is read-only", async () => {
    const fn = "public.quote_in_person_decline(uuid, uuid, text, text, text, text)";
    expect(await can("anon", fn)).toBe(false);
    expect(await can("authenticated", fn)).toBe(true);
    for (const f of [
      "app.in_person_device_ip()",
      "app.in_person_notice_targets(uuid, uuid, uuid[])",
      "app.close_expired_contract_renewals()",
      "app.contract_renewal_task_touched(uuid, uuid)",
      "app.signature_documents_contract_expired_clear()",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(await can(role, f), `${f} ${role}`).toBe(false);
    }
    const col = (priv: string) =>
      asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.signature_documents', 'contract_expired_at', $1) as c", [priv])).c);
    expect(await col("select")).toBe(true);
    expect(await col("update")).toBe(false);
    expect(await col("insert")).toBe(false);
  });

  it("(287) ב: the device's IP address from the server's header is kept on an in-person signature and acceptance", async () => {
    const doc = (await sendDoc(member, await newContact(member, "אבי"))).id;
    expect((await signInPerson(member, doc, "198.51.100.7")).status).toBe("signed");
    expect(await asAdmin((q) => one(q, "select ip, user_agent, in_person from public.signature_signatures where document_id = $1", [doc]))).toEqual({ ip: "198.51.100.7", user_agent: UA, in_person: true });
    // IPv6 too; anything else is not an address and is not kept
    const doc6 = (await sendDoc(member, await newContact(member, "בני"))).id;
    expect((await signInPerson(member, doc6, "2001:db8::42")).status).toBe("signed");
    expect(await asAdmin((q) => one(q, "select ip from public.signature_signatures where document_id = $1", [doc6]))).toEqual({ ip: "2001:db8::42" });
    const docBad = (await sendDoc(member, await newContact(member, "גיל"))).id;
    expect((await signInPerson(member, docBad, "<script>")).status).toBe("signed");
    expect(await asAdmin((q) => one(q, "select ip from public.signature_signatures where document_id = $1", [docBad]))).toEqual({ ip: null });

    const quote = await newQuote(member);
    expect((await acceptInPerson(member, quote, "203.0.113.9")).status).toBe("accepted");
    expect(await asAdmin((q) => one(q, "select ip, in_person, in_person_by from public.quote_decisions where quote_id = $1", [quote]))).toEqual({
      ip: "203.0.113.9",
      in_person: true,
      in_person_by: member.id,
    });
  });

  it("(288) ב: the rep makes a quote's signed PDF within 24 hours of the in-person acceptance", async () => {
    const quote = await newQuote(member);
    expect((await acceptInPerson(member, quote, null)).status).toBe("accepted");
    const allowed = () => run(member, async (q) => (await one<{ b: { fingerprint: string } }>(q, "select public.quote_in_person_pdf_allowed($1, $2) as b", [org, quote])).b);
    await asAdmin((q) => q("update public.quote_decisions set decided_at = now() - interval '23 hours' where quote_id = $1", [quote]));
    const fingerprint = (await allowed()).fingerprint;
    const store = () =>
      asService(async (q) => (await one<{ r: { status: string } }>(q, "select public.quote_signed_pdf_store($1, $2, $3, 20000, $4, 'הצעה חתומה.pdf', null, $5) as r", [org, quote, member.id, "d".repeat(64), fingerprint])).r);
    expect((await store()).status).toBe("upload");
    await asAdmin((q) => q("update public.quote_decisions set decided_at = now() - interval '24 hours 1 minute' where quote_id = $1", [quote]));
    expect((await pgError(allowed())).code).toBe("42501");
    expect((await pgError(store())).code).toBe("42501");
  });

  it("(289) ב: a notice the rep alone would get goes to the owners and admins; with someone else, only to them", async () => {
    // the member's own document signed by the member: the owners and admins are told
    const contact = await newContact(member, "דור");
    const doc = (await sendDoc(member, contact)).id;
    expect((await signInPerson(member, doc, null)).status).toBe("signed");
    const told = (entity: string) =>
      asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 and title = 'מסמך נחתם בקישור' order by user_id", [entity])).rows.map((r) => r.user_id));
    expect(await told(contact)).toEqual([owner.id, admin.id].sort());
    // an admin signing the member's document: the member alone (the admin never, the owner not)
    const contact2 = await newContact(member, "הדר");
    const doc2 = (await sendDoc(member, contact2)).id;
    expect((await signInPerson(admin, doc2, null)).status).toBe("signed");
    expect(await told(contact2)).toEqual([member.id]);
    // the owner as the rep and the only one besides the admin: the admin only, never the owner
    const contact3 = await newContact(owner, "ורד");
    const doc3 = (await sendDoc(owner, contact3)).id;
    expect((await signInPerson(owner, doc3, null)).status).toBe("signed");
    expect(await told(contact3)).toEqual([admin.id]);
  });

  it("(290) ב: a quote is declined in person exactly as on the customer's page, recording the rep, the device and the reason", async () => {
    const quote = await newQuote(member);
    for (const u of [other, viewer]) expect((await pgError(declineInPerson(u, quote))).code, u.email).toBe("42501");
    expect((await declineInPerson(member, quote, { fingerprint: "1".repeat(64) })).status).toBe("changed");
    expect((await declineInPerson(member, quote, { reason: "א".repeat(1001) })).status).toBe("invalid");
    expect((await declineInPerson(member, quote, { name: "א" })).status).toBe("invalid");
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_decisions where quote_id = $1", [quote]))).toBe(0);

    expect((await declineInPerson(member, quote, { ip: "192.0.2.44", reason: "  יקר מדי  " })).status).toBe("rejected");
    const row = await asAdmin((q) =>
      one(q, "select q.status, d.decision, d.decline_reason, d.ip, d.user_agent, d.in_person, d.in_person_by, d.signer_name from public.quotes q join public.quote_decisions d on d.quote_id = q.id where q.id = $1", [quote]),
    );
    expect(row).toEqual({ status: "rejected", decision: "rejected", decline_reason: "יקר מדי", ip: "192.0.2.44", user_agent: UA, in_person: true, in_person_by: member.id, signer_name: null });
    // the timeline entry is the server's (as the customer's decline); the audit names the rep
    const entries = await asAdmin(async (q) => (await q<{ created_by: string | null }>("select created_by from public.activities where metadata ->> 'kind' = 'quote_rejected' and metadata ->> 'quote_id' = $1", [quote])).rows);
    expect(entries).toEqual([{ created_by: null }]);
    expect(await asAdmin((q) => one(q, "select actor_id, changes from public.audit_log where entity_id = $1 and action = 'in_person_decline'", [quote]))).toEqual({
      actor_id: member.id,
      changes: { status: "rejected", in_person: true },
    });
    // the rep (the quote's owner) would be the only one told: the owners and admins instead
    const told = await asAdmin(async (q) => (await q<{ user_id: string; body: string | null }>("select user_id, body from public.notifications where entity_id = $1 and title = 'הצעת מחיר נדחתה במקום: הצעה לבדיקה' order by user_id", [quote])).rows);
    expect(told.map((t) => t.user_id)).toEqual([owner.id, admin.id].sort());
    expect(told[0].body).toMatch(/^הצעה /);
    // once only; no signed PDF for a decline; the customer's link reads it as decided
    expect((await declineInPerson(member, quote)).status).toBe("already_decided");
    expect((await acceptInPerson(member, quote, null)).status).toBe("already_decided");
    expect((await pgError(run(member, (q) => q("select public.quote_in_person_pdf_allowed($1, $2)", [org, quote]))))).toMatchObject({ code: "42501" });

    // a quote declined through the customer's link, for comparison
    const twin = await newQuote(member, false);
    const token = await run(member, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, twin])).t);
    const answer = await asService(async (q) =>
      (await one<{ a: { status: string } }>(q, "select public.quote_public_answer(p_token => $1, p_decision => 'rejected', p_fingerprint => $2, p_decline_reason => 'יקר מדי') as a", [token, await quoteFingerprint(twin)])).a,
    );
    expect(answer.status).toBe("rejected");
    const shape = (id: string) => asAdmin((q) => one(q, "select q.status, d.decision, d.decline_reason, d.content_sha256 = app.quote_fingerprint(q) as same from public.quotes q join public.quote_decisions d on d.quote_id = q.id where q.id = $1", [id]));
    expect(await shape(quote)).toEqual(await shape(twin));
  });

  it("(290) ב: no live customer link, no decline (the link row carries the try counter)", async () => {
    const quote = await newQuote(member, false);
    expect((await declineInPerson(member, quote)).status).toBe("closed");
    expect(await asAdmin((q) => one(q, "select status from public.quotes where id = $1", [quote]))).toEqual({ status: "sent" });
  });

  it("(283) ב: an open renewal task of a contract that ended closes by itself, once, and the contract is marked", async () => {
    const ended = await contractWithTask(-1);
    const today = await contractWithTask(0);
    expect(await closeJob()).toBeGreaterThanOrEqual(1);
    expect(await taskOf(ended.task)).toEqual({ status: "done", outcome: EXPIRED_OUTCOME });
    expect(await marked(ended.doc)).toBe(true);
    // the last day is today: still valid
    expect(await taskOf(today.task)).toEqual({ status: "open", outcome: null });
    expect(await marked(today.doc)).toBe(false);

    // never reopened, never judged again: a task the person opens again stays open
    await run(member, (q) => q("update public.tasks set status = 'open', outcome = null where id = $1", [ended.task]));
    await closeJob();
    expect(await taskOf(ended.task)).toEqual({ status: "open", outcome: null });

    // the renewal job runs it first
    const viaJob = await contractWithTask(-3);
    await asAdmin((q) => q("select app.send_contract_renewals()"));
    expect(await taskOf(viaJob.task)).toEqual({ status: "done", outcome: EXPIRED_OUTCOME });

    // a later last day takes the mark off
    await run(member, (q) => q("select public.signature_document_set_validity($1, $2, $3::date, null)", [org, viaJob.doc, null]));
    expect(await marked(viaJob.doc)).toBe(false);
  });

  it("(283) ב: a task a person changed stays as it is (a retitle alone does not count); the contract is still marked", async () => {
    const changed = await contractWithTask(-2);
    await run(member, (q) => q("update public.tasks set due_at = now() + interval '1 day' where id = $1", [changed.task]));
    const retitled = await contractWithTask(-2);
    await run(member, (q) => q("update public.tasks set title = 'לחדש את החוזה' where id = $1", [retitled.task]));
    await closeJob();
    expect(await taskOf(changed.task)).toEqual({ status: "open", outcome: null });
    expect(await marked(changed.doc)).toBe(true);
    expect(await taskOf(retitled.task)).toEqual({ status: "done", outcome: EXPIRED_OUTCOME });
  });

  it("(283) ב: only writable businesses with the key; an erased document is not touched", async () => {
    const plain = await contractWithTask(-1, plainOrg, plainOwner, plainTemplate);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"signatures\": false}'::jsonb where organization_id = $1", [plainOrg]));
    await closeJob();
    expect(await taskOf(plain.task)).toEqual({ status: "open", outcome: null });
    expect(await marked(plain.doc)).toBe(false);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"signatures\": true}'::jsonb where organization_id = $1", [plainOrg]));

    const erased = await contractWithTask(-1);
    await asAdmin((q) => q("update public.signature_documents set erased_at = now() where id = $1", [erased.doc]));
    // the erasure closes its task by its own rule
    expect((await taskOf(erased.task)).outcome).toBe("נסגרה: פרטי המסמך נמחקו");
    await closeJob();
    expect(await marked(erased.doc)).toBe(false);
  });

  it("review: businesses take turns (a cap per business inside the run's cap)", async () => {
    const a = await contractWithTask(-1);
    const b = await contractWithTask(-1);
    await asAdmin(async (q) => {
      await q("select set_config('app.signature_job_per_org', '1', true)");
      await q("select app.close_expired_contract_renewals()");
    });
    const closed = [(await taskOf(a.task)).status, (await taskOf(b.task)).status].filter((s) => s === "done").length;
    expect(closed).toBe(1);
    await closeJob();
    expect([(await taskOf(a.task)).status, (await taskOf(b.task)).status]).toEqual(["done", "done"]);
  });

  it("review: a document that fails 3 times for the same last day is skipped; a new last day starts again", async () => {
    const c = await contractWithTask(-1);
    // a failure in the closing update, only inside this transaction (the trigger never outlives it)
    const failingRun = () =>
      asAdmin(async (q) => {
        await q("create or replace function pg_temp.sa_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$");
        await q(`create trigger sa_boom before update of status on public.tasks for each row when (new.id = '${c.task}'::uuid) execute function pg_temp.sa_boom()`);
        await q("select app.close_expired_contract_renewals()");
        await q("drop trigger sa_boom on public.tasks");
        return (await one<{ f: number }>(q, "select failures as f from app.contract_expiry_failures where document_id = $1", [c.doc])).f;
      });
    expect(await failingRun()).toBe(1);
    expect(await failingRun()).toBe(2);
    expect(await failingRun()).toBe(3);
    expect(await taskOf(c.task)).toEqual({ status: "open", outcome: null });
    expect(await marked(c.doc)).toBe(false);
    // skipped now
    await closeJob();
    expect(await taskOf(c.task)).toEqual({ status: "open", outcome: null });
    expect(await marked(c.doc)).toBe(false);
    // a new last day (still past) is judged afresh (moved by the server here, so no person touches the task; the move's own
    // trigger closes the task, which the server opens again)
    await asAdmin(async (q) => q("update public.signature_documents set valid_until = $2::date where id = $1", [c.doc, await day(org, -2)]));
    await asAdmin((q) => q("update public.tasks set status = 'open', outcome = null where id = $1", [c.task]));
    await closeJob();
    expect(await taskOf(c.task)).toEqual({ status: "done", outcome: EXPIRED_OUTCOME });
    expect(await marked(c.doc)).toBe(true);
  });

  it("review: a renewal task back from the bin after the mark is closed by the next run, unless a person restored it", async () => {
    const server = await contractWithTask(-1);
    const person = await contractWithTask(-1);
    await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = any ($1::uuid[])", [[server.task, person.task]]));
    await closeJob();
    expect(await marked(server.doc)).toBe(true);
    expect(await marked(person.doc)).toBe(true);
    // brought back by the server (no person) and by the business owner (restoring is for admins and team managers)
    await asAdmin((q) => q("update public.tasks set deleted_at = null where id = $1", [server.task]));
    await run(owner, (q) => q("update public.tasks set deleted_at = null where id = $1", [person.task]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and action = 'restore' and actor_id = $2", [person.task, owner.id]))).toBe(1);
    await closeJob();
    expect(await taskOf(server.task)).toEqual({ status: "done", outcome: EXPIRED_OUTCOME });
    expect(await taskOf(person.task)).toEqual({ status: "open", outcome: null });
    // a person's restore of an unmarked contract's task counts as touched too
    const restoredFirst = await contractWithTask(-1);
    await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = $1", [restoredFirst.task]));
    await run(owner, (q) => q("update public.tasks set deleted_at = null where id = $1", [restoredFirst.task]));
    await closeJob();
    expect(await taskOf(restoredFirst.task)).toEqual({ status: "open", outcome: null });
    expect(await marked(restoredFirst.doc)).toBe(true);
  });

  it("(290) ב: a privacy erasure reaches an in-person decline (IP, browser, signer name and reason)", async () => {
    const contact = await newContact(member, "שרון");
    const quote = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה ללקוחה', $2) returning id", [org, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, quantity, unit_price_agorot) values ($1, $2, 1, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      await q("select public.quote_link_create($1, $2)", [org, id]);
      return id;
    });
    expect((await declineInPerson(member, quote, { ip: "192.0.2.77", name: "שרון לוי", reason: "שרון מעדיפה ספק אחר" })).status).toBe("rejected");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    expect(
      await asAdmin((q) => one(q, "select decision, signer_name, ip, user_agent, decline_reason, in_person, erased_at is not null as erased from public.quote_decisions where quote_id = $1", [quote])),
    ).toEqual({ decision: "rejected", signer_name: null, ip: null, user_agent: null, decline_reason: null, in_person: true, erased: true });
  });
});
