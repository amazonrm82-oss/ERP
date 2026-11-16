import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

// QUO-18, first part (owner's answer (89) א): a person who may send a quote sends a sent or viewed quote to its own customer by
// email or SMS, from a requested_document template; the composers fill {מסמך}, {תוקף} and mint {קישור להצעה} last.

const KEY = "test-consent-key";
const SITE = "https://mexuz.test";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type U = { id: string; email: string };
type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

afterAll(closePool);

describe("sending a quote to its customer (QUO-18)", () => {
  let owner: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipe: { pipelineId: string; stageId: string };
  let emailTpl: string, smsTpl: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const template = (orgId: string, channel: "email" | "sms", type: string, body: string, subject: string | null = null) =>
    asAdmin(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.message_templates (organization_id, name, channel, message_type, subject, body)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [orgId, `t-${Math.random().toString(36).slice(2, 10)}`, channel, type, channel === "email" ? (subject ?? "הצעת המחיר מ{שם העסק}") : null, body],
          )
        ).id,
    );
  const newQuote = async (u: U, orgId: string, opts: { email?: string | null; phone?: string | null; validDays?: number | null } = {}) => {
    const contact = await asUser(u.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, email, phone) values ($1, 'דנה', 'כהן', $2, $3) returning id", [
          orgId,
          opts.email === undefined ? "dana@example.test" : opts.email,
          opts.phone === undefined ? "052-1234567" : opts.phone,
        ])
      ).id,
    );
    return asUser(u.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          orgId,
          pipe.pipelineId,
          pipe.stageId,
          contact,
        ])
      ).id;
      const days = opts.validDays === undefined ? 14 : opts.validDays;
      const quote = (
        await one<{ id: string }>(
          q,
          `insert into public.quotes (organization_id, title, deal_id, valid_until)
           values ($1, 'הצעה', $2, case when $3::integer is null then null else current_date + $3::integer end) returning id`,
          [orgId, deal, days],
        )
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [orgId, quote]);
      return { contact, deal, quote };
    });
  };
  const sendQuote = (u: U, orgId: string, quote: string) => asUser(u.id, (q) => q("select public.quote_send($1, $2)", [orgId, quote]));
  const send = (u: U, orgId: string, quote: string, channel: string, tpl: string) =>
    asUser(u.id, async (q) => (await one<{ r: { job_id: string; paused: boolean } }>(q, "select public.quote_message_send($1, $2, $3, $4) as r", [orgId, quote, channel, tpl])).r);
  const payloadOf = (job: string) => asAdmin(async (q) => (await one<{ p: Answer }>(q, "select payload as p from app.jobs where id = $1", [job])).p);
  const prepared = async (job: string): Promise<Claimed> => {
    const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
    const claimed = rows.find((r) => r.id === job);
    expect(claimed, "claimed").toBeDefined();
    await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true where id = $1", [job]));
    return claimed as Claimed;
  };
  const compose = (kind: "email" | "sms", job: Claimed) =>
    asService(async (q) => (await one<{ r: Answer }>(q, `select public.${kind}_job_compose($1, $2, $3) as r`, [job.id, job.lease, SITE])).r);

  beforeAll(async () => {
    await asAdmin((q) => q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]));
    owner = await createUser("qsend-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    member = await addMember(org, owner.id, "member", "qsend-member");
    other = await addMember(org, owner.id, "member", "qsend-other");
    viewer = await addMember(org, owner.id, "viewer", "qsend-viewer");
    outsider = await createUser("qsend-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages[0].id };
    await asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": true, \"quotes\": true}'::jsonb where organization_id = $1", [org]);
      await q("update public.profiles set full_name = 'משה החבר' where id = $1", [member.id]);
      await q(
        `insert into public.org_document_settings (organization_id, vat_status, address_line, city, phone)
         values ($1, 'licensed', 'הרצל 1', 'תל אביב', '03-5555555')
         on conflict (organization_id) do update set vat_status = 'licensed', address_line = excluded.address_line, city = excluded.city, phone = excluded.phone`,
        [org],
      );
    });
    emailTpl = await template(org, "email", "requested_document", "שלום {שם פרטי}, {מסמך}: {קישור להצעה} בתוקף עד {תוקף}. {שם הנציג}");
    smsTpl = await template(org, "sms", "requested_document", "שלום {שם פרטי}, {מסמך}: {קישור להצעה} עד {תוקף}");
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));

  it("queues ids only, for whoever may send the quote, never for a viewer, a colleague who cannot edit it or another business", async () => {
    const { quote, contact } = await newQuote(member, org);
    expect((await pgError(send(member, org, quote, "email", emailTpl))).hint).toBe("quote:not_sent");
    await sendQuote(member, org, quote);
    for (const u of [other, viewer]) expect((await pgError(send(u, org, quote, "email", emailTpl))).code, u.email).toBe("42501");
    const outside = await pgError(send(outsider, org, quote, "email", emailTpl));
    expect(["42501", "P0001"]).toContain(outside.code);
    expect((await pgError(send(outsider, otherOrg, quote, "email", emailTpl))).code).not.toBeUndefined();
    const r = await send(member, org, quote, "email", emailTpl);
    expect(await payloadOf(r.job_id)).toEqual({
      channel: "email",
      message_type: "requested_document",
      template_id: emailTpl,
      quote_id: quote,
      contact_id: contact,
      reply_to_user_id: member.id,
    });
    const s = await send(member, org, quote, "sms", smsTpl);
    expect(await payloadOf(s.job_id)).toMatchObject({ channel: "sms", quote_id: quote, sent_by_user_id: member.id });
    // the quote's list shows both, to whoever may send it only
    const list = await asUser(member.id, async (q) => (await one<{ r: Answer[] }>(q, "select public.quote_message_queue($1, $2) as r", [org, quote])).r);
    expect(list.map((x) => x.channel).sort()).toEqual(["email", "sms"]);
    for (const u of [other, viewer]) {
      expect(await asUser(u.id, async (q) => (await one<{ r: Answer[] }>(q, "select public.quote_message_queue($1, $2) as r", [org, quote])).r)).toEqual([]);
    }
  });

  it("refuses a closed, superseded or channel-less send, and a template that is not the quote's kind", async () => {
    const { quote } = await newQuote(member, org, { email: null });
    await sendQuote(member, org, quote);
    expect((await pgError(send(member, org, quote, "email", emailTpl))).hint).toBe("record_email:no_address");
    expect((await pgError(send(member, org, quote, "sms", emailTpl))).hint).toBe("quote_message:channel");
    expect((await pgError(send(member, org, quote, "fax", emailTpl))).hint).toBe("quote_message:channel");
    const marketing = await template(org, "sms", "marketing", "שלום {שם פרטי}");
    expect((await pgError(send(member, org, quote, "sms", marketing))).hint).toBe("quote_message:type");
    // a field the type does not allow is refused by the service template rule before anything is queued
    const free = await template(org, "sms", "requested_document", "שלום {שם פרטי} {שעה}");
    expect((await pgError(send(member, org, quote, "sms", free))).hint).toBe("record_email:not_sendable");
    // the card still refuses the quote's template (its own rule is unchanged)
    const card = await pgError(
      asUser(member.id, (q) => q("select public.record_sms_send($1, 'contact', (select contact_id from public.deals where id = (select deal_id from public.quotes where id = $2)), $3)", [org, quote, smsTpl])),
    );
    expect(card.hint).toBe("record_message:unfillable_field");

    // expired by date, cancelled, accepted
    const late = await newQuote(member, org);
    await sendQuote(member, org, late.quote);
    // the server arranges the past (a sent quote's validity is frozen for every writer)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set quote_date = current_date - 10, valid_until = current_date - 2 where id = $1", [late.quote]);
    });
    expect((await pgError(send(member, org, late.quote, "sms", smsTpl))).hint).toBe("quote:closed");
    const cancelled = await newQuote(member, org);
    await sendQuote(member, org, cancelled.quote);
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, cancelled.quote]));
    expect((await pgError(send(member, org, cancelled.quote, "sms", smsTpl))).hint).toBe("quote:closed");

    // a newer sent version supersedes the older
    const v1 = await newQuote(member, org);
    await sendQuote(member, org, v1.quote);
    const v2 = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, v1.quote])).id);
    await sendQuote(member, org, v2);
    expect((await pgError(send(member, org, v1.quote, "sms", smsTpl))).hint).toBe("quote:superseded");

    // {תוקף} needs a validity date; an optional part holding it does not (review F5)
    const open = await newQuote(member, org, { validDays: null });
    await sendQuote(member, org, open.quote);
    expect((await pgError(send(member, org, open.quote, "sms", smsTpl))).hint).toBe("quote_message:no_validity");
    const optional = await template(org, "sms", "requested_document", "שלום {שם פרטי}: {קישור להצעה}{ עד {תוקף}}");
    const job = await prepared((await send(member, org, open.quote, "sms", optional)).job_id);
    expect(String((await compose("sms", job)).text)).toMatch(/^שלום דנה: https:\/\/mexuz\.test\/f\/quote\/[A-Za-z0-9_-]{64}$/);
  });

  it("composes the email with the quote's fields and one more link; the earlier link keeps working (owner (385) ב)", async () => {
    const { quote } = await newQuote(member, org);
    await sendQuote(member, org, quote);
    const oldToken = await asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
    const r = await send(member, org, quote, "email", emailTpl);
    const answer = await compose("email", await prepared(r.job_id));
    const number = await asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.quotes where id = $1", [quote])).n);
    const text = String(answer.text);
    const token = /\/f\/quote\/([A-Za-z0-9_-]{64})/.exec(text)?.[1];
    expect(token).toBeDefined();
    expect(text).toContain(`הצעת מחיר ${number}`);
    expect(text.startsWith("שלום דנה, ")).toBe(true);
    expect(text).toContain("משה החבר");
    expect(answer.to).toBe("dana@example.test");
    expect(answer.links).toEqual([`${SITE}/f/quote/${token}`]);
    const links = await asAdmin(
      async (q) => (await q<{ h: string; made_by: string; job_id: string | null }>("select token_hash as h, made_by, job_id from app.quote_link_tokens where quote_id = $1 order by created_at", [quote])).rows,
    );
    expect(links).toEqual([
      { h: sha256(oldToken), made_by: "screen", job_id: null },
      { h: sha256(token as string), made_by: "message", job_id: r.job_id },
    ]);
    for (const t of [token as string, oldToken]) {
      const page = await asService(async (q) => (await one<{ p: Answer }>(q, "select public.quote_public($1) as p", [t])).p);
      expect(page).toHaveProperty("quote");
    }
  });

  it("composes the SMS, and refuses when the quote changed state, the customer changed or the number is blocked", async () => {
    const a = await newQuote(member, org);
    await sendQuote(member, org, a.quote);
    const ok = await compose("sms", await prepared((await send(member, org, a.quote, "sms", smsTpl)).job_id));
    expect(String(ok.text)).toMatch(/^שלום דנה, הצעת מחיר .+: https:\/\/mexuz\.test\/f\/quote\/[A-Za-z0-9_-]{64} עד \d+ ב/);

    const b = await newQuote(member, org);
    await sendQuote(member, org, b.quote);
    let job = await prepared((await send(member, org, b.quote, "sms", smsTpl)).job_id);
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, b.quote]));
    expect(await compose("sms", job)).toEqual({ refused: "quote_changed" });

    const c = await newQuote(member, org);
    await sendQuote(member, org, c.quote);
    job = await prepared((await send(member, org, c.quote, "sms", smsTpl)).job_id);
    // the customer on the quote went to the bin after queuing
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [c.contact]));
    expect(await compose("sms", job)).toEqual({ refused: "record_gone" });

    const d = await newQuote(member, org, { phone: "052-9998887" });
    await sendQuote(member, org, d.quote);
    job = await prepared((await send(member, org, d.quote, "sms", smsTpl)).job_id);
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'sms', $2, 'complaint')", [org, ["052-9998887"]]));
    expect(await compose("sms", job)).toEqual({ refused: "consent_blocked" });

    // without the plan key nothing goes
    const e = await newQuote(member, org);
    await sendQuote(member, org, e.quote);
    job = await prepared((await send(member, org, e.quote, "sms", smsTpl)).job_id);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"quotes\": false}'::jsonb where organization_id = $1", [org]));
    try {
      expect(await compose("sms", job)).toEqual({ refused: "feature_off" });
      expect((await pgError(send(member, org, e.quote, "sms", smsTpl))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"quotes\": true}'::jsonb where organization_id = $1", [org]));
    }
  });

  it("review F3: the customer is the contact the quote names, never the deal's current contact", async () => {
    // a deal without a contact: the quote names none, and a contact linked to the deal later is not its customer
    const deal = await asUser(member.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה בלי איש קשר', $2, $3) returning id", [org, pipe.pipelineId, pipe.stageId])).id,
    );
    const quote = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, current_date + 14) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [org, id]);
      return id;
    });
    await sendQuote(member, org, quote);
    const later = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, email) values ($1, 'מאוחר', 'later@example.test') returning id", [org])).id);
    await asUser(member.id, (q) => q("update public.deals set contact_id = $2 where id = $1", [deal, later]));
    expect((await pgError(send(member, org, quote, "email", emailTpl))).hint).toBe("quote_message:no_contact");
    // a quote that names its contact keeps it when the deal's contact changes
    const named = await newQuote(member, org);
    await sendQuote(member, org, named.quote);
    await asUser(member.id, (q) => q("update public.deals set contact_id = $2 where id = $1", [named.deal, later]));
    const r = await send(member, org, named.quote, "email", emailTpl);
    expect((await payloadOf(r.job_id)).contact_id).toBe(named.contact);
    expect((await compose("email", await prepared(r.job_id))).to).toBe("dana@example.test");
  });

  it("the payload rule takes quote_id only on a requested_document to a contact, without other subjects", async () => {
    const ok = (p: Answer) => asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('message.send', $1::jsonb) as ok", [JSON.stringify(p)])).ok);
    const id = "11111111-1111-4111-8111-111111111111";
    const base = { channel: "email", message_type: "requested_document", template_id: id, quote_id: id, contact_id: id };
    expect(await ok(base)).toBe(true);
    expect(await ok({ ...base, message_type: "marketing" })).toBe(false);
    expect(await ok({ ...base, contact_id: undefined, lead_id: id })).toBe(false);
    expect(await ok({ ...base, deal_id: id })).toBe(false);
    expect(await ok({ ...base, channel: "whatsapp" })).toBe(false);
    expect(await ok({ ...base, signature_document_id: id })).toBe(false);
    expect(await ok({ ...base, quote_id: "x" })).toBe(false);
  });

  it("keeps its functions out of anon's reach and the composer branch away from a message no person sent", async () => {
    const acl = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; acl: string | null }>(
            `select p.oid::regprocedure::text as name, array_to_string(p.proacl, ',') as acl from pg_proc p
              where p.oid in ('public.quote_message_send(uuid, uuid, text, uuid)'::regprocedure, 'public.quote_message_queue(uuid, uuid)'::regprocedure,
                              'app.quote_message_refusal(app.jobs, public.quotes, uuid, public.message_templates)'::regprocedure,
                              'app.quote_message_link_issue(public.quotes, uuid, uuid)'::regprocedure)`,
          )
        ).rows,
    );
    for (const r of acl) expect(r.acl ?? "", r.name).not.toMatch(/(^|,)anon=/);
    for (const r of acl.filter((x) => x.name.startsWith("app."))) expect(r.acl ?? "", r.name).not.toMatch(/(authenticated|service_role)=/);
    const { quote, contact } = await newQuote(member, org);
    await sendQuote(member, org, quote);
    const job = await asAdmin(
      async (q) =>
        (
          await one<{ id: string }>(q, "select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [
            org,
            JSON.stringify({ channel: "sms", message_type: "requested_document", template_id: smsTpl, quote_id: quote, contact_id: contact }),
          ])
        ).id,
    );
    expect(await compose("sms", await prepared(job))).toEqual({ refused: "unsupported" });
  });
});
