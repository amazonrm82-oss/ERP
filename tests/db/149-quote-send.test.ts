import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = Record<string, unknown>;

/**
 * QUO-07 (marking as sent) and the owner's retention rule: a sent quote outlives its purged deal or
 * contact, detached, with the customer's name as sent and "הלקוח נמחק"; a privacy erasure empties its
 * personal details and keeps its number, date and amounts; drafts go with their record.
 */
describe("sending a quote and keeping it (QUO-07)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const quote = (id: string) => asAdmin((q) => one<Row>(q, "select * from public.quotes where id = $1", [id]));
  const newContact = (u: U, name: string, extra: Record<string, unknown> = {}) =>
    run(u, async (q) => {
      const keys = Object.keys(extra);
      return (
        await one<{ id: string }>(
          q,
          `insert into public.contacts (organization_id, first_name${keys.map((k) => `, ${k}`).join("")}) values ($1, $2${keys.map((_, i) => `, $${i + 3}`).join("")}) returning id`,
          [org, name, ...Object.values(extra)],
        )
      ).id;
    });
  const newDeal = (u: U, contact: string | null) =>
    run(u, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [org, pipelineId, stageId, contact]))
        .id,
    );
  const newQuote = (u: U, parent: { deal_id?: string; contact_id?: string }, title = "הצעה ללקוח") =>
    run(u, async (q) => {
      const keys = Object.keys(parent);
      const id = (
        await one<{ id: string }>(
          q,
          `insert into public.quotes (organization_id, title, notes, ${keys.join(", ")}) values ($1, $2, 'הערה אישית', ${keys.map((_, i) => `$${i + 3}`).join(", ")}) returning id`,
          [org, title, ...Object.values(parent)],
        )
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שורה', 10000)", [org, id]);
      return id;
    });
  const send = (u: U, id: string) => run(u, async (q) => (await one<{ r: { number: string } }>(q, "select public.quote_send($1, $2) as r", [org, id])).r);
  const purge = async (table: "contacts" | "deals", id: string) => {
    await run(owner, (q) => q(`update public.${table} set deleted_at = now() where id = $1`, [id]));
    expect(await run(owner, async (q) => (await q(`delete from public.${table} where id = $1`, [id])).rowCount)).toBe(1);
  };

  beforeAll(async () => {
    owner = await createUser("qs-owner");
    org = await createOrg(owner.id, "עסק השליחה");
    admin = await addMember(org, owner.id, "admin", "qs-admin");
    member = await addMember(org, owner.id, "member", "qs-member");
    other = await addMember(org, owner.id, "member", "qs-other");
    viewer = await addMember(org, owner.id, "viewer", "qs-viewer");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [org],
      ),
    );
    await run(owner, (q) => q("select public.number_sequence_jump($1, 'quote', 100)", [org]).catch(() => null));
  });

  it("sending gives the next running number, keeps the customer names and locks the quote", async () => {
    const company = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, billing_name) values ($1, 'חברת לקוח', 'חברת לקוח בע\"מ') returning id", [org])).id,
    );
    const contact = await newContact(member, "דנה", { company_id: company });
    const first = await newQuote(member, { contact_id: contact });
    const second = await newQuote(member, { contact_id: contact });
    const a = await send(member, first);
    const b = await send(member, second);
    const [qa, qb] = [await quote(first), await quote(second)];
    expect(Number(qb.number)).toBe(Number(qa.number) + 1);
    expect(a.number).toBe(qa.number_display);
    expect(b.number).toBe(qb.number_display);
    expect(qa).toMatchObject({ status: "sent", customer_name: 'חברת לקוח בע"מ', customer_contact_name: "דנה", total_agorot: "11800", vat_rate_bp: 1800 });
    expect(qa.sent_at).not.toBeNull();
    // once sent: not again, and nobody edits it
    expect((await pgError(send(member, first))).hint).toBe("quote:frozen");
    expect(await run(member, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [first])).rowCount)).toBe(0);
    // the server-only columns stay the server's
    expect((await pgError(run(member, (q) => q("update public.quotes set number = 1 where id = $1", [first])))).code).toBe("42501");
  });

  it("only someone who may edit the draft sends it; an empty quote or unknown VAT is refused; the plan flag is needed", async () => {
    await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    const contact = await newContact(member, "שלי");
    const draft = await newQuote(member, { contact_id: contact });
    for (const u of [other, viewer]) expect((await pgError(send(u, draft))).code, u.email).toBe("42501");
    const empty = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'ריקה', $2) returning id", [org, contact])).id,
    );
    expect((await pgError(send(member, empty))).hint).toBe("quote:empty");
    await run(owner, (q) => q("update public.org_document_settings set vat_status = null where organization_id = $1", [org]));
    try {
      expect((await pgError(send(member, draft))).hint).toBe("quote:vat_unknown");
    } finally {
      await run(owner, (q) => q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org]));
    }
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"quotes\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(send(member, draft))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    const status = await asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.organizations where id = $1", [org])).status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(send(member, draft))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    expect((await quote(draft)).status).toBe("draft");
  });

  it("purging a contact keeps its sent quotes, detached and marked, and removes its drafts; owners and admins read them", async () => {
    const contact = await newContact(member, "לקוח שיימחק");
    const sent = await newQuote(member, { contact_id: contact });
    await send(member, sent);
    const draft = await newQuote(member, { contact_id: contact });
    await purge("contacts", contact);
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where id = $1", [draft]))).toBe(0);
    const kept = await quote(sent);
    expect(kept).toMatchObject({ contact_id: null, deal_id: null, former_contact_id: contact, status: "sent", customer_contact_name: null, customer_name: "לקוח שיימחק" });
    expect(kept.customer_deleted_at).not.toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [sent]))).toBe(1);
    for (const u of [owner, admin]) {
      expect(await run(u, (q) => count(q, "select 1 from public.quotes where id = $1", [sent])), u.email).toBe(1);
      expect(await run(u, (q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [sent])), u.email).toBe(1);
      expect(await run(u, async (q) => (await q("update public.quotes set notes = 'x' where id = $1", [sent])).rowCount), u.email).toBe(0);
      expect(await run(u, async (q) => (await q("delete from public.quotes where id = $1", [sent])).rowCount), u.email).toBe(0);
    }
    for (const u of [member, viewer]) expect(await run(u, (q) => count(q, "select 1 from public.quotes where id = $1", [sent])), u.email).toBe(0);
  });

  it("purging a deal keeps its sent quotes (with their contact, or on their own) and removes its drafts", async () => {
    const contact = await newContact(member, "לקוח העסקה");
    const deal = await newDeal(member, contact);
    const withContact = await newQuote(member, { deal_id: deal });
    await send(member, withContact);
    const lone = await newDeal(member, null);
    const alone = await newQuote(member, { deal_id: lone }, "הצעה בלי איש קשר");
    // a quote with neither contact nor company sends with no customer name
    await send(member, alone);
    const draft = await newQuote(member, { deal_id: deal });
    await purge("deals", deal);
    await purge("deals", lone);
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where id = $1", [draft]))).toBe(0);
    expect(await quote(withContact)).toMatchObject({ deal_id: null, contact_id: contact, former_deal_id: deal, customer_deleted_at: null });
    const lonely = await quote(alone);
    expect(lonely).toMatchObject({ deal_id: null, contact_id: null, former_deal_id: lone });
    expect(lonely.customer_deleted_at).not.toBeNull();
    // the one still with its contact is read through the contact, as before
    expect(await run(member, (q) => count(q, "select 1 from public.quotes where id = $1", [withContact]))).toBe(1);
  });

  it("a privacy erasure empties the personal details of a kept quote and keeps its number, date and amounts", async () => {
    const contact = await newContact(member, "ישראל לפרטיות");
    const sent = await newQuote(member, { contact_id: contact }, "הצעת מחיר: ישראל לפרטיות");
    await send(member, sent);
    const before = await quote(sent);
    await purge("contacts", contact);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const after = await quote(sent);
    expect(after).toMatchObject({
      title: "הצעת מחיר",
      notes: null,
      customer_name: null,
      customer_contact_name: null,
      number_display: before.number_display,
      quote_date: before.quote_date,
      total_agorot: before.total_agorot,
      vat_agorot: before.vat_agorot,
    });
    const leftover = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where entity_type = 'quotes' and entity_id = $1 and changes <> '{\"erased\": true}'::jsonb", [sent]),
    );
    expect(leftover).toBe(0);
  });

  it("deleting a whole business with kept quotes works", async () => {
    const boss = await createUser("qs-doomed");
    const doomed = await createOrg(boss.id, "עסק שנמחק עם הצעות");
    await asUser(boss.id, (q) =>
      q(`insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'`, [
        doomed,
      ]),
    );
    const id = await asUser(boss.id, async (q) => {
      const c = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'x') returning id", [doomed])).id;
      const qid = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'x', $2) returning id", [doomed, c])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'x', 1)", [doomed, qid]);
      await q("select public.quote_send($1, $2)", [doomed, qid]);
      // a sent deal quote that names a contact: the deal's purge would detach it, then the contact's
      const pipe = (await one<{ id: string }>(q, "select id from public.pipelines where organization_id = $1 limit 1", [doomed])).id;
      const stage = (await one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 order by position limit 1", [pipe])).id;
      const d = (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'x', $2, $3, $4) returning id", [doomed, pipe, stage, c])).id;
      const dq = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'y', $2) returning id", [doomed, d])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'y', 1)", [doomed, dq]);
      await q("select public.quote_send($1, $2)", [doomed, dq]);
      return qid;
    });
    await asAdmin((q) => q("delete from public.organizations where id = $1", [doomed]));
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where id = $1", [id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where organization_id = $1", [doomed]))).toBe(0);
  });
});
