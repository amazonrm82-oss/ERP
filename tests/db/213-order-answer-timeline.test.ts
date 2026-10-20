import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Entry = {
  type: string;
  body: string;
  created_by: string | null;
  deal_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  metadata: Record<string, unknown>;
};

/**
 * ORD-05b (owner, 20 October 2026, answer (א)): the customer's answer through the order link leaves the order's status as it
 * is, tells the order's owner (a decline with its reason) and writes one system entry with no author on the timeline of the
 * order's deal and contact (else its company), which no person writes or changes; a privacy erasure removes the reason from
 * the entry and from the notices.
 */
describe("the customer's answer on the timeline (ORD-05b)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const newOrder = (u: U, name: string, opts: { deal?: boolean; companyOnly?: boolean } = {}) =>
    run(u, async (q) => {
      let contact: string | null = null;
      let deal: string | null = null;
      let company: string | null = null;
      if (opts.companyOnly) {
        company = (
          await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])
        ).id;
      } else {
        contact = (
          await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [
            org,
            name,
            u.id,
          ])
        ).id;
      }
      if (opts.deal) {
        deal = (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stageId, contact, u.id],
          )
        ).id;
      }
      const order = (
        await one<{ id: string }>(q, "insert into public.orders (organization_id, deal_id, contact_id, company_id) values ($1, $2, $3, $4) returning id", [
          org,
          deal,
          contact,
          company,
        ])
      ).id;
      await q("insert into public.order_lines (organization_id, order_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, order]);
      await q("select public.order_confirm($1, $2)", [org, order]);
      const token = (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, order])).t;
      return { contact, deal, company, order, token };
    });
  const fingerprint = (token: string) =>
    asService(async (q) => (await one<{ p: { fingerprint: string } }>(q, "select public.order_public($1, null) as p", [token])).p.fingerprint);
  const decide = (token: string, decision: "accepted" | "rejected", fp: string, reason: string | null = null) =>
    asService(
      async (q) =>
        (
          await one<{ r: { status: string } }>(
            q,
            `select public.order_public_decide(p_token => $1, p_decision => $2, p_fingerprint => $3, p_signer_name => 'דנה כהן',
                   p_signature_kind => 'typed', p_wording_version => 'order-draft-2026-10-20', p_agreed => true, p_decline_reason => $4) as r`,
            [token, decision, fp, reason],
          )
        ).r,
    );
  const entries = (order: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Entry>(
            "select type, body, created_by, deal_id, contact_id, company_id, metadata from public.activities where metadata ->> 'order_id' = $1 and metadata ->> 'kind' like 'order_answer_%'",
            [order],
          )
        ).rows,
    );
  const notices = (order: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ title: string; body: string | null; user_id: string }>("select title, body, user_id from public.notifications where entity_id = $1", [
            order,
          ])
        ).rows,
    );
  const number = (order: string) =>
    asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.orders where id = $1", [order])).n);

  beforeAll(async () => {
    owner = await createUser("oat-owner");
    org = await createOrg(owner.id, "עסק התשובות");
    member = await addMember(org, owner.id, "member", "oat-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"orders\": true}' where organization_id = $1", [org]));
    await asAdmin((q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("an approval writes one system entry with no author on the deal and contact; the status stays; not contact", async () => {
    const o = await newOrder(member, "רונית", { deal: true });
    const before = await asAdmin(
      async (q) => (await one<{ at: string | null }>(q, "select last_contacted_at as at from public.contacts where id = $1", [o.contact])).at,
    );
    expect((await decide(o.token, "accepted", await fingerprint(o.token))).status).toBe("accepted");
    const n = await number(o.order);
    const list = await entries(o.order);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: "system",
      created_by: null,
      deal_id: o.deal,
      contact_id: o.contact,
      company_id: null,
      body: `הלקוח אישר בקישור את ההזמנה ${n}`,
    });
    expect(list[0].metadata).toEqual({ kind: "order_answer_accepted", order_id: o.order, number: n });
    expect((await asAdmin((q) => one<{ status: string }>(q, "select status from public.orders where id = $1", [o.order]))).status).toBe("new");
    const after = await asAdmin(
      async (q) => (await one<{ at: string | null }>(q, "select last_contacted_at as at from public.contacts where id = $1", [o.contact])).at,
    );
    expect(after).toEqual(before);
    // the notice: the number only
    expect(await notices(o.order)).toEqual([{ title: "הלקוח אישר את ההזמנה בקישור", body: `הזמנה ${n}`, user_id: member.id }]);
    // whoever reads the contact sees the entry
    expect(
      await run(member, (q) =>
        count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'order_answer_accepted'", [o.contact]),
      ),
    ).toBe(1);
  });

  it("a decline carries its reason in the entry and the notice; a company-only order puts it on the company", async () => {
    const o = await newOrder(member, "חברת הדוגמה", { companyOnly: true });
    expect((await decide(o.token, "rejected", await fingerprint(o.token), "  המחיר גבוה מדי  ")).status).toBe("rejected");
    const n = await number(o.order);
    const [entry] = await entries(o.order);
    expect(entry).toMatchObject({
      type: "system",
      created_by: null,
      company_id: o.company,
      deal_id: null,
      contact_id: null,
      body: `הלקוח דחה בקישור את ההזמנה ${n} · סיבה: המחיר גבוה מדי`,
    });
    expect(entry.metadata.kind).toBe("order_answer_rejected");
    expect(await notices(o.order)).toEqual([{ title: "הלקוח דחה את ההזמנה בקישור", body: `הזמנה ${n} · סיבה: המחיר גבוה מדי`, user_id: member.id }]);
    // a decline without a reason
    const p = await newOrder(member, "בלי סיבה");
    await decide(p.token, "rejected", await fingerprint(p.token));
    const pn = await number(p.order);
    expect((await entries(p.order))[0].body).toBe(`הלקוח דחה בקישור את ההזמנה ${pn}`);
    expect((await notices(p.order))[0].body).toBe(`הזמנה ${pn}`);
  });

  it("no person writes, changes or removes such an entry, owners included", async () => {
    const o = await newOrder(member, "מיכאל");
    await decide(o.token, "accepted", await fingerprint(o.token));
    const id = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.activities where metadata ->> 'order_id' = $1", [o.order])).id);
    for (const u of [owner, member]) {
      // refused by the guard, or not reached at all (RLS): either way nothing changes
      const outcome = (sql: string) =>
        run(u, (q) => q(sql, [id])).then(
          (r) => r.rowCount,
          (e: { hint?: string }) => e.hint,
        );
      expect([0, "activity:order_entry"], u.email).toContain(await outcome("update public.activities set metadata = metadata || '{\"x\": 1}' where id = $1"));
      expect([0, "activity:order_entry"], u.email).toContain(await outcome("update public.activities set body = 'שונה' where id = $1"));
      expect([0, "activity:order_entry"], u.email).toContain(await outcome("delete from public.activities where id = $1"));
      expect(
        (
          await pgError(
            run(u, (q) =>
              q("insert into public.activities (organization_id, type, contact_id, body, metadata) values ($1, 'note', $2, 'מזויף', $3)", [
                org,
                o.contact,
                JSON.stringify({ kind: "order_answer_accepted", order_id: o.order }),
              ]),
            ),
          )
        ).hint,
        u.email,
      ).toBe("activity:order_entry");
    }
    const kept = await asAdmin(
      async (q) => await one<{ body: string; metadata: Record<string, unknown> }>(q, "select body, metadata from public.activities where id = $1", [id]),
    );
    expect(kept.body).toMatch(/^הלקוח אישר בקישור את ההזמנה /);
    expect(kept.metadata).not.toHaveProperty("x");
  });

  it("a privacy erasure removes the reason from the entry and the notices; the rest stays", async () => {
    const o = await newOrder(member, "יעל לוי", { deal: true });
    await decide(o.token, "rejected", await fingerprint(o.token), "יעל לוי עברה לספק אחר");
    const n = await number(o.order);
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [o.contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [o.contact])).rowCount)).toBe(1);
    // the entry stays on the deal
    expect((await entries(o.order))[0]).toMatchObject({ deal_id: o.deal, contact_id: null });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, o.contact]));
    const [entry] = await entries(o.order);
    expect(entry.body).toBe(`הלקוח דחה בקישור את ההזמנה ${n}`);
    expect(entry.metadata.kind).toBe("order_answer_rejected");
    expect(await notices(o.order)).toEqual([{ title: "הלקוח דחה את ההזמנה בקישור", body: `הזמנה ${n}`, user_id: member.id }]);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and changes::text like '%עברה לספק אחר%'", [org]))).toBe(0);
    expect(
      (await asAdmin((q) => one<{ r: string | null }>(q, "select decline_reason as r from public.order_decisions where order_id = $1", [o.order]))).r,
    ).toBeNull();
  });
});
