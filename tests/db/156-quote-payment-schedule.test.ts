import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Step = { name: string; percent: number; due?: string | null; milestone?: string | null; position?: number };

/**
 * GAP-09: a payment schedule in a quote (name, percent, a date or a milestone). A draft may be incomplete; the steps never
 * pass 100%, and a quote with a schedule is sent only when it adds up to exactly 100%. Once sent it is locked for every
 * writer. The customer's page gets the rows it shows and each one's share of the total, no ids.
 */
describe("a quote's payment schedule (GAP-09)", () => {
  let owner: U, member: U, other: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const newQuote = (u: U, price = 10000, quantity = 1) =>
    asUser(u.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stageId])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', $3, $4)", [org, quote, quantity, price]);
      return quote;
    });
  const addStep = (u: U, quote: string, step: Step) =>
    asUser(u.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.quote_payment_steps (organization_id, quote_id, name, percent_bp, due_date, milestone, position) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, quote, step.name, step.percent, step.due ?? null, step.milestone ?? null, step.position ?? 0],
        )
      ).id,
    );
  const send = (u: U, quote: string) => asUser(u.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const linkOf = (u: U, quote: string) => asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const page = (token: string) =>
    asService(async (q) => (await one<{ p: { quote: { total_agorot: number }; schedule: Array<Record<string, unknown>> } }>(q, "select public.quote_public($1) as p", [token])).p);

  beforeAll(async () => {
    owner = await createUser("gap09-owner");
    org = await createOrg(owner.id, "עסק קבלני");
    member = await addMember(org, owner.id, "member", "gap09-member");
    other = await addMember(org, owner.id, "member", "gap09-other");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("each step names a date or a milestone; a draft may be incomplete but never passes 100%", async () => {
    const quote = await newQuote(member);
    expect((await pgError(addStep(member, quote, { name: "מקדמה", percent: 3000 }))).code).toBe("23514");
    await addStep(member, quote, { name: "מקדמה", percent: 3000, milestone: "בחתימה" });
    await addStep(member, quote, { name: "שלב א", percent: 5000, due: "2027-01-15", position: 1 });
    expect((await pgError(addStep(member, quote, { name: "יתרה", percent: 2001, milestone: "במסירה", position: 2 }))).hint).toBe("quote_schedule:over");
    expect((await pgError(addStep(member, quote, { name: "x", percent: 0, milestone: "x" }))).code).toBe("23514");
    // raising a step past 100% is refused too
    const err = await pgError(asUser(member.id, (q) => q("update public.quote_payment_steps set percent_bp = 7001 where quote_id = $1 and name = 'שלב א'", [quote])));
    expect(err.hint).toBe("quote_schedule:over");
    // an incomplete draft is kept as is
    const total = await asUser(member.id, async (q) => (await one<{ s: number }>(q, "select sum(percent_bp)::int as s from public.quote_payment_steps where quote_id = $1", [quote])).s);
    expect(total).toBe(8000);
  });

  it("at most 20 steps in a quote", async () => {
    const quote = await newQuote(member);
    for (let i = 0; i < 20; i += 1) await addStep(member, quote, { name: `תשלום ${i + 1}`, percent: 1, milestone: "x", position: i });
    expect((await pgError(addStep(member, quote, { name: "עוד", percent: 1, milestone: "x" }))).hint).toBe("quote_schedule:max");
  });

  it("a quote with a schedule is sent only when it adds up to exactly 100%; without one, as before", async () => {
    const quote = await newQuote(member);
    await addStep(member, quote, { name: "מקדמה", percent: 3000, milestone: "בחתימה" });
    expect((await pgError(send(member, quote))).hint).toBe("quote:schedule_total");
    await addStep(member, quote, { name: "יתרה", percent: 7000, milestone: "במסירה", position: 1 });
    await send(member, quote);
    const plain = await newQuote(member);
    await send(member, plain);
  });

  it("once sent, the schedule is locked for every writer; a step cannot move to another quote", async () => {
    const quote = await newQuote(member);
    const step = await addStep(member, quote, { name: "הכל", percent: 10000, milestone: "בחתימה" });
    const draft = await newQuote(member);
    expect((await pgError(asUser(member.id, (q) => q("update public.quote_payment_steps set quote_id = $2 where id = $1", [step, draft])))).code).toBe("42501");
    await send(member, quote);
    expect((await pgError(asAdmin((q) => q("update public.quote_payment_steps set name = 'x' where id = $1", [step])))).hint).toBe("quote:frozen");
    expect((await pgError(asAdmin((q) => q("insert into public.quote_payment_steps (organization_id, quote_id, name, percent_bp, milestone) values ($1, $2, 'x', 1, 'x')", [org, quote])))).hint).toBe(
      "quote:frozen",
    );
    // not even the server deletes a step of a sent quote
    expect((await pgError(asAdmin((q) => q("delete from public.quote_payment_steps where id = $1", [step])))).hint).toBe("quote:frozen");
    // its editors: a change or a delete reaches no row, an insert is refused
    expect(await asUser(member.id, async (q) => (await q("update public.quote_payment_steps set name = 'x' where id = $1", [step])).rowCount)).toBe(0);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.quote_payment_steps where id = $1", [step])).rowCount)).toBe(0);
    for (const u of [member, owner]) {
      const refused = await pgError(addStep(u, quote, { name: "x", percent: 1, milestone: "x" }));
      expect(["42501", "P0001"], u.email).toContain(refused.code);
    }
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quote_payment_steps where quote_id = $1", [quote])).c)).toBe(1);
  });

  it("only those who may edit the quote write its schedule", async () => {
    const quote = await newQuote(member);
    expect((await pgError(addStep(other, quote, { name: "x", percent: 1, milestone: "x" }))).code).toBe("42501");
    await addStep(owner, quote, { name: "מקדמה", percent: 1000, milestone: "בחתימה" });
  });

  it("someone who may not edit the quote learns nothing from the schedule's rules: a plain 42501, no hint", async () => {
    const outsider = await createUser("gap09-outsider");
    await createOrg(outsider.id, "עסק זר");
    // a full draft: the cap would refuse anyone who may edit it
    const full = await newQuote(member);
    await addStep(member, full, { name: "הכל", percent: 10000, milestone: "בחתימה" });
    // a sent quote: the lock would refuse anyone who may edit it
    const sent = await newQuote(member);
    await addStep(member, sent, { name: "הכל", percent: 10000, milestone: "בחתימה" });
    await send(member, sent);
    for (const u of [outsider, other]) {
      for (const quote of [full, sent]) {
        const refused = await pgError(addStep(u, quote, { name: "x", percent: 1, milestone: "x" }));
        expect([refused.code, refused.hint ?? null], u.email).toEqual(["42501", null]);
      }
    }
  });

  it("an updated step is counted once against 100%", async () => {
    const quote = await newQuote(member);
    await addStep(member, quote, { name: "מקדמה", percent: 6000, milestone: "בחתימה" });
    const rest = await addStep(member, quote, { name: "יתרה", percent: 4000, milestone: "במסירה", position: 1 });
    const setPercent = (bp: number) => asUser(member.id, (q) => q("update public.quote_payment_steps set percent_bp = $2 where id = $1", [rest, bp]));
    expect((await pgError(setPercent(5000))).hint).toBe("quote_schedule:over");
    expect((await setPercent(4000)).rowCount).toBe(1);
    expect((await setPercent(3000)).rowCount).toBe(1);
  });

  it("the customer's page gets the rows and each one's share of the total, which add up to it exactly; no ids", async () => {
    // a total that does not split evenly: 3 x 33.33% + 0.01%
    const quote = await newQuote(member, 10001, 1);
    await addStep(member, quote, { name: "שלישית א", percent: 3333, milestone: "בחתימה", position: 0 });
    await addStep(member, quote, { name: "שלישית ב", percent: 3333, due: "2027-02-01", milestone: "באמצע", position: 1 });
    await addStep(member, quote, { name: "שלישית ג", percent: 3334, due: "2027-03-01", position: 2 });
    await send(member, quote);
    const answer = await page(await linkOf(member, quote));
    expect(answer.schedule.map((s) => Object.keys(s).sort())).toEqual(Array(3).fill(["amount_agorot", "due_date", "milestone", "name", "percent_bp"]));
    expect(JSON.stringify(answer.schedule)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(answer.schedule.map((s) => [s.name, s.percent_bp, s.due_date, s.milestone])).toEqual([
      ["שלישית א", 3333, null, "בחתימה"],
      ["שלישית ב", 3333, "2027-02-01", "באמצע"],
      ["שלישית ג", 3334, "2027-03-01", null],
    ]);
    const amounts = answer.schedule.map((s) => Number(s.amount_agorot));
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(answer.quote.total_agorot);
    const total = answer.quote.total_agorot;
    expect(amounts[0]).toBe(Math.round((total * 3333) / 10000));
    // a quote without a schedule answers an empty list
    const plain = await newQuote(member);
    await send(member, plain);
    expect((await page(await linkOf(member, plain))).schedule).toEqual([]);
  });

  it("a schedule written while the quote is being sent waits for it, then is refused", async () => {
    const quote = await newQuote(member);
    await addStep(member, quote, { name: "הכל", percent: 10000, milestone: "בחתימה" });
    // the send holds the quote; a step taken away meanwhile waits for it, then finds the quote sent
    let removal: Promise<{ code?: string; hint?: string }> | null = null;
    await asUser(member.id, async (q) => {
      await q("select public.quote_send($1, $2)", [org, quote]);
      removal = pgError(asAdmin((q2) => q2("delete from public.quote_payment_steps where quote_id = $1", [quote])));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect((await removal!).hint).toBe("quote:frozen");
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quote_payment_steps where quote_id = $1", [quote])).c)).toBe(1);
  });

  it("a privacy erasure of the deal erases the entries of its quote's schedule", async () => {
    const quote = await newQuote(owner);
    const deal = await asAdmin(async (q) => (await one<{ d: string }>(q, "select deal_id as d from public.quotes where id = $1", [quote])).d);
    const step = await addStep(owner, quote, { name: "מקדמה לפרטי", percent: 1000, milestone: "בחתימה" });
    await asAdmin((q) => q("delete from public.deals where id = $1", [deal]));
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, deal]));
    const entries = await asAdmin(async (q) =>
      (await q<{ c: unknown }>("select changes as c from public.audit_log where organization_id = $1 and entity_type = 'quote_payment_steps' and entity_id = $2", [org, step])).rows.map((r) => r.c),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((c) => JSON.stringify(c) === JSON.stringify({ erased: true }))).toBe(true);
  });

  it("the schedule goes with its quote, and a draft's steps with the draft", async () => {
    const quote = await newQuote(member);
    await addStep(member, quote, { name: "מקדמה", percent: 1000, milestone: "בחתימה" });
    expect(await asUser(member.id, async (q) => (await q("delete from public.quotes where id = $1", [quote])).rowCount)).toBe(1);
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quote_payment_steps where quote_id = $1", [quote])).c)).toBe(0);
  });
});
