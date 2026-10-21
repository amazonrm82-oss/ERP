import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * RVW-41 (weekly review of 21 October 2026, high): an order made from a deal keeps its deal when its contact is purged
 * (app.orders_detach clears only contact_id). It must stay workable: a person moves its status, writes notes and the
 * delivery date, and cancels it; purging its delivery contact (FK set null) and erasing that person (PRV-03) go through.
 * A deal is enough of a customer for a numbered order; a person who changes the customer still names one.
 */
describe("an order whose contact was purged (RVW-41)", () => {
  let owner: U, admin: U, member: U, outsider: U;
  let org: string;
  let pipelineId: string, wonStage: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const order = (id: string) =>
    asAdmin((q) =>
      one<{ status: string; deal_id: string | null; contact_id: string | null; delivery_contact_id: string | null; notes: string | null; delivery_date: string | null }>(
        q,
        "select status, deal_id, contact_id, delivery_contact_id, notes, delivery_date::text from public.orders where id = $1",
        [id],
      ),
    );
  const newContact = (name: string) =>
    asUser(member.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, member.id])).id);
  const purge = async (id: string) => {
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [id]));
    return asUser(owner.id, async (q) => (await q("delete from public.contacts where id = $1", [id])).rowCount);
  };
  // a numbered order from a won deal of `contact`, with `delivery` as its delivery contact
  const orderFromDeal = async (contact: string, delivery: string | null) => {
    const deal = await asUser(member.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'התקנה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          wonStage,
          contact,
          member.id,
        ])
      ).id,
    );
    await asUser(member.id, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'התקנה', 50000, 1)", [org, deal]));
    const id = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, deal])).id);
    if (delivery) await asUser(member.id, (q) => q("update public.orders set delivery_contact_id = $2 where id = $1", [id, delivery]));
    return { id, deal };
  };
  const update = (u: U, id: string, set: string, params: unknown[] = []) => asUser(u.id, async (q) => (await q(`update public.orders set ${set} where id = $1`, [id, ...params])).rowCount);

  beforeAll(async () => {
    owner = await createUser("rvw41-owner");
    org = await createOrg(owner.id, "עסק ההזמנות");
    admin = await addMember(org, owner.id, "admin", "rvw41-admin");
    member = await addMember(org, owner.id, "member", "rvw41-member");
    outsider = await createUser("rvw41-outsider");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ orders: true })]));
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [org],
      ),
    );
  });

  it("stays workable after its contact is purged: status, notes, delivery date, cancel", async () => {
    const contact = await newContact("רון");
    const { id, deal } = await orderFromDeal(contact, null);
    expect(await purge(contact)).toBe(1);
    expect(await order(id)).toMatchObject({ status: "new", deal_id: deal, contact_id: null });

    expect(await update(member, id, "notes = 'להתקשר לפני'")).toBe(1);
    expect(await update(member, id, "delivery_date = '2026-11-01'")).toBe(1);
    expect(await update(member, id, "status = 'in_progress'")).toBe(1);
    expect(await update(owner, id, "status = 'delivered'")).toBe(1);
    expect(await order(id)).toMatchObject({ status: "delivered", notes: "להתקשר לפני", delivery_date: "2026-11-01" });
    // the customer of a numbered order still never changes, and an outsider still gets nothing
    expect((await pgError(update(member, id, "contact_id = $2", [await newContact("אחר")]))).hint).toBe("order:frozen");
    expect(await update(outsider, id, "notes = 'זר'")).toBe(0);
  });

  it("purging its delivery contact and erasing that person go through", async () => {
    const contact = await newContact("דנה");
    const delivery = await newContact("אבי");
    const { id } = await orderFromDeal(contact, delivery);
    expect(await purge(contact)).toBe(1);
    expect(await purge(delivery)).toBe(1);
    expect(await order(id)).toMatchObject({ contact_id: null, delivery_contact_id: null, status: "new" });

    // PRV-03 removes a delivery contact the same way
    const contact2 = await newContact("שירה");
    const delivery2 = await newContact("משה");
    const { id: id2 } = await orderFromDeal(contact2, delivery2);
    expect(await purge(contact2)).toBe(1);
    await asMfaUser(admin.id, (q) => q("select public.privacy_erase_person($1, 'contacts', $2, '[]'::jsonb, 'הלקוח ביקש', '{}'::jsonb, true)", [org, delivery2]));
    expect(await order(id2)).toMatchObject({ contact_id: null, delivery_contact_id: null });
  });

  it("a person's new order still names a customer, and a draft is never left without one", async () => {
    // a deal with no contact or company is not enough for a new order
    const bare = await asUser(member.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'בלי לקוח', $2, $3, $4) returning id", [
          org,
          pipelineId,
          wonStage,
          member.id,
        ])
      ).id,
    );
    expect((await pgError(asUser(member.id, (q) => q("insert into public.orders (organization_id, deal_id) values ($1, $2)", [org, bare])))).hint).toBe("order:customer");
    // a deal-less draft whose contact is taken away belongs to nobody the person may edit: RLS refuses it
    const contact = await newContact("תמר");
    const draft = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id);
    expect((await pgError(update(member, draft, "contact_id = null"))).code).toBe("42501");
  });
});
