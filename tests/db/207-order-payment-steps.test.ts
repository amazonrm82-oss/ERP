import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Step = { name: string; percent_bp: number; due_date: string | null; milestone: string | null; position: number };

/**
 * ORD-04 part one (owner, 20 October 2026): a payment schedule on orders, the mechanism of quotes' (GAP-09). A manual
 * draft builds its own (20 steps at most, never over 100%) and is confirmed only with no schedule or exactly 100%; once
 * numbered it is frozen for every writer. An order from an accepted quote copies the quote's schedule, frozen with its
 * lines. A draft's steps go with it; erasure erases the entries of a gone order's steps.
 */
describe("order payment schedule (ORD-04)", () => {
  let owner: U, member: U, other: U;
  let org: string;
  let pipelineId: string, openStage: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newContact = (u: U, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])).id);
  const draft = (u: U, contact: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id);
  const addLine = (u: U, orderId: string) =>
    run(u, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 10000)", [org, orderId]));
  const addStep = (u: U, orderId: string, name: string, bp: number, position = 0) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.order_payment_steps (organization_id, order_id, position, name, percent_bp, milestone) values ($1, $2, $3, $4, $5, 'באספקה') returning id",
          [org, orderId, position, name, bp],
        )
      ).id,
    );
  const steps = (orderId: string) =>
    asAdmin(async (q) => (await q<Step>("select name, percent_bp, due_date::text, milestone, position from public.order_payment_steps where order_id = $1 order by position, id", [orderId])).rows);
  const confirm = (u: U, orderId: string) => run(u, (q) => q("select public.order_confirm($1, $2)", [org, orderId]));

  beforeAll(async () => {
    owner = await createUser("ops-owner");
    org = await createOrg(owner.id, "עסק לוח ההזמנות");
    member = await addMember(org, owner.id, "member", "ops-member");
    other = await addMember(org, owner.id, "member", "ops-other");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ orders: true, quotes: true })]));
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("a manual draft builds its schedule: at most 20 steps, never over 100%, a date or a milestone", async () => {
    const id = await draft(member, await newContact(member, "דנה"));
    await addStep(member, id, "  מקדמה  ", 3000);
    expect((await steps(id))[0].name).toBe("מקדמה");
    expect((await pgError(addStep(member, id, "יותר מדי", 7001, 1))).hint).toBe("order_schedule:over");
    expect(
      (await pgError(run(member, (q) => q("insert into public.order_payment_steps (organization_id, order_id, name, percent_bp) values ($1, $2, 'בלי מועד', 100)", [org, id])))).code,
    ).toBe("23514");
    const crowded = await draft(member, await newContact(member, "רון"));
    for (let i = 0; i < 20; i++) await addStep(member, crowded, `תשלום ${i}`, 100, i);
    expect((await pgError(addStep(member, crowded, "21", 100, 21))).hint).toBe("order_schedule:max");
    // a step stays in its order
    const step = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.order_payment_steps where order_id = $1 limit 1", [id])).id);
    expect((await pgError(asAdmin((q) => q("update public.order_payment_steps set order_id = $2 where id = $1", [step, crowded])))).code).toBe("22023");
  });

  it("confirming needs no schedule or exactly 100%; then the schedule is frozen for every writer", async () => {
    const id = await draft(member, await newContact(member, "מיכל"));
    await addLine(member, id);
    await addStep(member, id, "מקדמה", 3000);
    expect((await pgError(confirm(member, id))).hint).toBe("order:schedule_total");
    expect((await asAdmin((q) => one<{ status: string }>(q, "select status from public.orders where id = $1", [id]))).status).toBe("draft");
    await addStep(member, id, "יתרה", 7000, 1);
    await confirm(member, id);
    const step = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.order_payment_steps where order_id = $1 order by position limit 1", [id])).id);
    // a person: RLS finds nothing to change or delete, and an insert is refused
    expect(await run(member, async (q) => (await q("update public.order_payment_steps set name = 'שונה' where id = $1", [step])).rowCount)).toBe(0);
    expect(await run(member, async (q) => (await q("delete from public.order_payment_steps where id = $1", [step])).rowCount)).toBe(0);
    const added = await pgError(addStep(member, id, "עוד", 1, 5));
    expect(added.hint === "order:frozen" || added.code === "42501").toBe(true);
    // the server too
    expect((await pgError(asAdmin((q) => q("update public.order_payment_steps set percent_bp = 2000 where id = $1", [step])))).hint).toBe("order:frozen");
    expect((await pgError(asAdmin((q) => q("delete from public.order_payment_steps where id = $1", [step])))).hint).toBe("order:frozen");
    expect((await steps(id)).map((s) => s.percent_bp)).toEqual([3000, 7000]);
  });

  it("only who may edit the draft writes its schedule; others read it as they read the order", async () => {
    const id = await draft(member, await newContact(member, "שירה"));
    await addStep(member, id, "מקדמה", 5000);
    // record_visibility 'own': the other member sees neither the order nor its steps, and cannot add one
    expect(await run(other, (q) => count(q, "select 1 from public.order_payment_steps where order_id = $1", [id]))).toBe(0);
    expect((await pgError(addStep(other, id, "של אחר", 100, 1))).code).toBe("42501");
    expect(await run(owner, (q) => count(q, "select 1 from public.order_payment_steps where order_id = $1", [id]))).toBe(1);
  });

  it("an order from an accepted quote copies the quote's schedule, frozen with its lines", async () => {
    const contact = await newContact(member, "יעל");
    const deal = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [org, pipelineId, openStage, contact, member.id])).id,
    );
    const quote = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until) values ($1, 'הצעה', $2, $3, current_date + 14) returning id", [org, deal, contact])).id,
    );
    await run(member, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 10000)", [org, quote]));
    await run(member, (q) =>
      q(
        `insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, due_date, milestone)
         values ($1, $2, 0, 'מקדמה', 2500, '2027-01-10', null), ($1, $2, 1, 'יתרה', 7500, null, 'בסיום')`,
        [org, quote],
      ),
    );
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, quote]));
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    const id = await run(member, async (q) => (await one<{ id: string }>(q, "select public.order_from_quote($1, $2) as id", [org, quote])).id);

    expect(await steps(id)).toEqual([
      { name: "מקדמה", percent_bp: 2500, due_date: "2027-01-10", milestone: null, position: 0 },
      { name: "יתרה", percent_bp: 7500, due_date: null, milestone: "בסיום", position: 1 },
    ]);
    expect((await asAdmin((q) => one<{ status: string }>(q, "select status from public.orders where id = $1", [id]))).status).toBe("new");
    const step = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.order_payment_steps where order_id = $1 order by position limit 1", [id])).id);
    expect((await pgError(asAdmin((q) => q("update public.order_payment_steps set percent_bp = 1 where id = $1", [step])))).hint).toBe("order:frozen");
    // the order reads its steps as it reads the order
    expect(await run(member, (q) => count(q, "select 1 from public.order_payment_steps where order_id = $1", [id]))).toBe(2);
  });

  it("a deleted draft takes its steps; erasure erases the entries of a gone order's steps", async () => {
    const contact = await newContact(member, "אורית");
    const id = await draft(member, contact);
    const step = await addStep(member, id, "תשלום של אורית", 4000);
    expect(await run(member, async (q) => (await q("delete from public.orders where id = $1", [id])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.order_payment_steps where order_id = $1", [id]))).toBe(0);
    // the purge of the contact, then its erasure
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const left = await asAdmin(async (q) =>
      (await q<{ changes: unknown }>("select changes from public.audit_log where organization_id = $1 and entity_type = 'order_payment_steps' and entity_id = $2", [org, step])).rows,
    );
    // its insert and its delete, both erased
    expect(left.length).toBeGreaterThanOrEqual(2);
    expect(left.every((row) => JSON.stringify(row.changes) === '{"erased":true}')).toBe(true);
  });
});
