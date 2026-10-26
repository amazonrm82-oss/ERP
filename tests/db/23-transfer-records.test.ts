import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

describe("handing records to someone else", () => {
  let owner: U, admin: U, leaving: U, taking: U, viewer: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("transfer-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    leaving = await addMember(org, owner.id, "member");
    taking = await addMember(org, owner.id, "member");
    viewer = await addMember(org, owner.id, "viewer");
    await insertLead(leaving.id, org, { owner_id: leaving.id, full_name: "ליד פעיל" });
    const trashed = await insertLead(leaving.id, org, { owner_id: leaving.id, full_name: "ליד בסל" });
    await asAdmin(async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [trashed]);
      await q("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'איש קשר', $2)", [org, leaving.id]);
      await q("insert into public.tasks (organization_id, title, owner_id) values ($1, 'לחזור', $2), ($1, 'הושלמה', $2)", [org, leaving.id]);
      await q("update public.tasks set status = 'done', completed_at = now() where title = 'הושלמה' and organization_id = $1", [org]);
    });
  });

  const transfer = (actor: string, from: string, to: string) =>
    asUser(actor, async (q) => (await q<{ r: Record<string, number> }>("select public.transfer_records($1, $2, $3) as r", [org, from, to])).rows[0].r);

  it("only owners and admins, and only to an active user who can edit", async () => {
    expect((await pgError(transfer(taking.id, leaving.id, taking.id))).code).toBe("42501");
    expect((await pgError(transfer(admin.id, leaving.id, viewer.id))).hint).toBe("transfer:target");
    expect((await pgError(transfer(admin.id, leaving.id, leaving.id))).code).toBe("22023");
  });

  it("moves everything, sends one notification, starts no automation, and lets the person go", async () => {
    // before: the person cannot be removed while they own records
    expect((await pgError(asUser(leaving.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaving.id])))).code).toBe("23503");
    const outboxBefore = await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and coalesce(payload ->> 'origin', '') <> 'automation'", [org]));

    expect(await transfer(admin.id, leaving.id, taking.id)).toEqual({ leads: 2, contacts: 1, companies: 0, deals: 0, tasks: 2, meetings: 0, quotes: 0, orders: 0 });

    for (const table of ["leads", "contacts", "tasks"]) {
      expect(await asAdmin((q) => count(q, `select 1 from public.${table} where organization_id = $1 and owner_id = $2`, [org, leaving.id])), table).toBe(0);
    }
    const notes = await asAdmin(async (q) => (await q<{ title: string; body: string }>("select title, body from public.notifications where organization_id = $1 and user_id = $2", [org, taking.id])).rows);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("2 לידים");
    // the moves are in the outbox only as automation-made changes, which automations skip
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and coalesce(payload ->> 'origin', '') <> 'automation'", [org]))).toBe(outboxBefore);
    // and the person can now leave
    await asUser(leaving.id, (q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaving.id]));
  });
});

// Lead's decision, 26 October 2026: the handover also moves the person's quotes and orders, in every status. app.quotes_check and
// app.orders_check keep owner_id for every other writer; app.document_owner_transfer moves it only while transfer_records runs.
describe("handing over quotes and orders", () => {
  let owner: U, leaving: U, taking: U, stays: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const features = (orgId: string) =>
    asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify({ quotes: true, orders: true })]);
      await q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [orgId]);
    });
  const newDeal = (u: U, orgId = org, pipe = pipelineId, stage = stageId) =>
    asUser(u.id, async (q) => {
      // an order names a customer: the deal's contact
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוחה', $2) returning id", [orgId, u.id])).id;
      return (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
          [orgId, pipe, stage, u.id, contact],
        )
      ).id;
    });
  const newQuote = (u: U, deal: string, orgId = org) =>
    asUser(u.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [orgId, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שורה', 10000)", [orgId, id]);
      return id;
    });
  const sendQuote = (u: U, id: string, orgId = org) => asUser(u.id, (q) => q("select public.quote_send($1, $2)", [orgId, id]));
  const newOrder = (u: U, deal: string, orgId = org) =>
    asUser(u.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, deal_id) values ($1, $2) returning id", [orgId, deal])).id;
      await q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [orgId, id]);
      return id;
    });
  const confirmOrder = (u: U, id: string, orgId = org) => asUser(u.id, (q) => q("select public.order_confirm($1, $2)", [orgId, id]));
  // everything but the owner and the touch time
  const frozen = (table: "quotes" | "orders", id: string) =>
    asAdmin(async (q) => (await one<{ r: Record<string, unknown> }>(q, `select to_jsonb(t) - 'owner_id' - 'updated_at' as r from public.${table} t where id = $1`, [id])).r);
  const ownerOf = (table: "quotes" | "orders", id: string) =>
    asAdmin(async (q) => (await one<{ o: string }>(q, `select owner_id as o from public.${table} where id = $1`, [id])).o);
  const transfer = (actor: U, from: U, to: U, orgId = org) =>
    asUser(actor.id, async (q) => (await one<{ r: Record<string, number> }>(q, "select public.transfer_records($1, $2, $3) as r", [orgId, from.id, to.id])).r);

  let draftQuote: string, sentQuote: string, cancelledQuote: string, draftOrder: string, numberedOrder: string, cancelledOrder: string;
  let othersQuote: string, othersOrder: string, foreignQuote: string, foreignOrder: string;

  beforeAll(async () => {
    owner = await createUser("tq-owner");
    org = await createOrg(owner.id);
    leaving = await addMember(org, owner.id, "member", "tq-leaving");
    taking = await addMember(org, owner.id, "member", "tq-taking");
    stays = await addMember(org, owner.id, "member", "tq-stays");
    await features(org);
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;

    const deal = await newDeal(leaving);
    draftQuote = await newQuote(leaving, deal);
    sentQuote = await newQuote(leaving, deal);
    await sendQuote(leaving, sentQuote);
    cancelledQuote = await newQuote(leaving, deal);
    await sendQuote(leaving, cancelledQuote);
    await asUser(leaving.id, (q) => q("select public.quote_cancel($1, $2)", [org, cancelledQuote]));
    draftOrder = await newOrder(leaving, deal);
    numberedOrder = await newOrder(leaving, deal);
    await confirmOrder(leaving, numberedOrder);
    cancelledOrder = await newOrder(leaving, deal);
    await confirmOrder(leaving, cancelledOrder);
    await asUser(leaving.id, (q) => q("update public.orders set status = 'cancelled' where id = $1", [cancelledOrder]));

    const othersDeal = await newDeal(stays);
    othersQuote = await newQuote(stays, othersDeal);
    othersOrder = await newOrder(stays, othersDeal);

    // another business where the same person also works: its quotes and orders never move
    outsider = await createUser("tq-outsider");
    otherOrg = await createOrg(outsider.id);
    await asAdmin((q) =>
      q("insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')", [otherOrg, leaving.id]),
    );
    await features(otherOrg);
    const otherPipe = await defaultPipeline(otherOrg);
    const foreignDeal = await newDeal(leaving, otherOrg, otherPipe.pipelineId, otherPipe.stages.find((s) => s.kind === "open")!.id);
    foreignQuote = await newQuote(leaving, foreignDeal, otherOrg);
    await sendQuote(leaving, foreignQuote, otherOrg);
    foreignOrder = await newOrder(leaving, foreignDeal, otherOrg);
  });

  it("nobody else moves a quote's or an order's owner, not even an owner", async () => {
    // clients have no grant on the column
    expect((await pgError(asUser(owner.id, (q) => q("update public.quotes set owner_id = $2 where id = $1", [sentQuote, taking.id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.orders set owner_id = $2 where id = $1", [draftOrder, taking.id])))).code).toBe("42501");
    // a server write outside the handover is put back by quotes_check / orders_check
    await asAdmin((q) => q("update public.quotes set owner_id = $2 where id = $1", [draftQuote, taking.id]));
    await asAdmin((q) => q("update public.orders set owner_id = $2 where id = $1", [numberedOrder, taking.id]));
    expect(await ownerOf("orders", numberedOrder)).toBe(leaving.id);
    expect(await ownerOf("quotes", sentQuote)).toBe(leaving.id);
    expect(await ownerOf("orders", draftOrder)).toBe(leaving.id);
    expect(await ownerOf("quotes", draftQuote)).toBe(leaving.id);
  });

  it("moves every quote and order of the person in this business, keeps everything else, and leaves others' alone", async () => {
    const before = {
      quotes: await Promise.all([draftQuote, sentQuote, cancelledQuote].map((id) => frozen("quotes", id))),
      orders: await Promise.all([draftOrder, numberedOrder, cancelledOrder].map((id) => frozen("orders", id))),
    };
    const audits = () =>
      asAdmin((q) =>
        count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type in ('quotes', 'orders') and action = 'update' and changes ? 'owner_id'", [org]),
      );
    const auditsBefore = await audits();

    expect(await transfer(owner, leaving, taking)).toMatchObject({ contacts: 1, deals: 1, quotes: 3, orders: 3 });

    for (const id of [draftQuote, sentQuote, cancelledQuote]) expect(await ownerOf("quotes", id)).toBe(taking.id);
    for (const id of [draftOrder, numberedOrder, cancelledOrder]) expect(await ownerOf("orders", id)).toBe(taking.id);
    expect(await Promise.all([draftQuote, sentQuote, cancelledQuote].map((id) => frozen("quotes", id)))).toEqual(before.quotes);
    expect(await Promise.all([draftOrder, numberedOrder, cancelledOrder].map((id) => frozen("orders", id)))).toEqual(before.orders);

    // other people's, and the same person's in another business, stay
    expect(await ownerOf("quotes", othersQuote)).toBe(stays.id);
    expect(await ownerOf("orders", othersOrder)).toBe(stays.id);
    expect(await ownerOf("quotes", foreignQuote)).toBe(leaving.id);
    expect(await ownerOf("orders", foreignOrder)).toBe(leaving.id);

    // audited like the other tables: one owner change per row
    expect((await audits()) - auditsBefore).toBe(6);
    // the settings are gone after the handover: a later server write is put back again
    await asAdmin((q) => q("update public.quotes set owner_id = $2 where id = $1", [sentQuote, stays.id]));
    expect(await ownerOf("quotes", sentQuote)).toBe(taking.id);

    const note = await asAdmin(async (q) =>
      (await one<{ body: string }>(q, "select body from public.notifications where organization_id = $1 and user_id = $2 order by created_at desc limit 1", [org, taking.id])).body,
    );
    expect(note).toContain("3 הצעות מחיר ו-3 הזמנות.");
  });
});
