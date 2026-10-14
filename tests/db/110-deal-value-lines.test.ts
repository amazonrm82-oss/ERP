import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dealLinesNet } from "@/features/deal-lines/pricing";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type DealValue = {
  amount: number;
  auto: boolean | null;
  source: string | null;
  recurring: number | null;
  recurring_auto: boolean | null;
};

/**
 * DLI-03 (owner, 14 October 2026): the deal value follows its product lines. A typed value; else
 * the lines' sum before VAT; else a recurring deal's first year; else empty. On a recurring deal the
 * lines are the amount per period and fill recurring_amount_agorot while nobody typed it. A line
 * change recomputes the deal through its own trigger (deals_amount_auto), for every writer.
 * The pure rule is checked against the shared fixtures in tests/db/106-deal-recurring.test.ts.
 */
describe("deal value from product lines (DLI-03)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const newDeal = (userId: string, values: Record<string, unknown> = {}) =>
    asUser(userId, async (q) => {
      const keys = ["organization_id", "name", "pipeline_id", "stage_id", ...Object.keys(values)];
      const params = [org, "עסקה", pipelineId, stageId, ...Object.values(values)];
      return (await q<{ id: string }>(`insert into public.deals (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, params))
        .rows[0].id;
    });
  const addLine = (userId: string, deal: string, unit: number, extra: Record<string, unknown> = {}) =>
    asUser(userId, async (q) => {
      const values: Record<string, unknown> = { deal_id: deal, description: "שורה", quantity: 1, unit_price_agorot: unit, ...extra };
      const keys = Object.keys(values);
      return (
        await q<{ id: string }>(
          `insert into public.deal_lines (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
          [org, ...Object.values(values)],
        )
      ).rows[0].id;
    });
  const value = (deal: string) =>
    asAdmin(async (q) => {
      const row = (
        await q<{ amount: string; auto: boolean | null; source: string | null; recurring: string | null; recurring_auto: boolean | null }>(
          `select amount_agorot::text as amount, amount_auto as auto, amount_source as source,
                  recurring_amount_agorot::text as recurring, recurring_amount_auto as recurring_auto
             from public.deals where id = $1`,
          [deal],
        )
      ).rows[0];
      return {
        amount: Number(row.amount),
        auto: row.auto,
        source: row.source,
        recurring: row.recurring === null ? null : Number(row.recurring),
        recurring_auto: row.recurring_auto,
      } satisfies DealValue;
    });
  const dealUpdates = (deal: string) =>
    asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'deals' and entity_id = $1 and action = 'update'", [deal]));
  const setVat = (fields: { prices_include_vat?: boolean; vat_status?: string | null }) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, prices_include_vat, vat_status) values ($1, $2, $3)
         on conflict (organization_id) do update set prices_include_vat = excluded.prices_include_vat, vat_status = excluded.vat_status`,
        [org, fields.prices_include_vat ?? false, fields.vat_status ?? null],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("value-lines-owner");
    org = await createOrg(owner.id, "עסק שווי מהשורות");
    member = await addMember(org, owner.id, "member", "value-lines-member");
    outsider = await createUser("value-lines-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("a line added, changed and removed recomputes an empty one-time deal; all lines gone = empty", async () => {
    const deal = await newDeal(member.id);
    expect(await value(deal)).toEqual({ amount: 0, auto: null, source: null, recurring: null, recurring_auto: null });

    const first = await addLine(member.id, deal, 10000);
    expect(await value(deal)).toEqual({ amount: 10000, auto: true, source: "lines", recurring: null, recurring_auto: null });

    const second = await addLine(member.id, deal, 2500, { quantity: 2, discount_bp: 1000 });
    expect((await value(deal)).amount).toBe(14500);

    await asUser(member.id, (q) => q("update public.deal_lines set quantity = 3 where id = $1", [first]));
    expect((await value(deal)).amount).toBe(34500);

    await asUser(member.id, (q) => q("delete from public.deal_lines where id = $1", [second]));
    expect(await value(deal)).toEqual({ amount: 30000, auto: true, source: "lines", recurring: null, recurring_auto: null });

    await asUser(member.id, (q) => q("delete from public.deal_lines where id = $1", [first]));
    expect(await value(deal)).toEqual({ amount: 0, auto: null, source: null, recurring: null, recurring_auto: null });

    // and lines added again drive it again
    await addLine(member.id, deal, 700);
    expect(await value(deal)).toEqual({ amount: 700, auto: true, source: "lines", recurring: null, recurring_auto: null });
  });

  it("one statement touches its deal once, and a line change that moves nothing writes nothing", async () => {
    const deal = await newDeal(member.id);
    const before = await dealUpdates(deal);
    await asUser(member.id, (q) =>
      q(
        `insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot)
         values ($1, $2, 'א', 1, 1000), ($1, $2, 'ב', 1, 2000), ($1, $2, 'ג', 1, 3000)`,
        [org, deal],
      ),
    );
    expect((await value(deal)).amount).toBe(6000);
    expect(await dealUpdates(deal)).toBe(before + 1);
    // a new description or order moves no amount: the deal is not written
    await asUser(member.id, (q) => q("update public.deal_lines set description = 'שם אחר', position = position + 1 where deal_id = $1", [deal]));
    expect(await dealUpdates(deal)).toBe(before + 1);
  });

  it("a person's typed value survives every line change; clearing it brings the lines back", async () => {
    const deal = await newDeal(member.id, { amount_agorot: 99900 });
    await addLine(member.id, deal, 5000);
    expect(await value(deal)).toEqual({ amount: 99900, auto: null, source: null, recurring: null, recurring_auto: null });

    // typed over a computed value: kept from then on
    const other = await newDeal(member.id);
    const line = await addLine(member.id, other, 5000);
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 4000 where id = $1", [other]));
    await asUser(member.id, (q) => q("update public.deal_lines set unit_price_agorot = 8000 where id = $1", [line]));
    expect(await value(other)).toEqual({ amount: 4000, auto: null, source: null, recurring: null, recurring_auto: null });

    // a form that re-sends the value it showed keeps it
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 4000, name = 'שם חדש' where id = $1", [other]));
    expect((await value(other)).amount).toBe(4000);

    // emptied: the lines again
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = null where id = $1", [other]));
    expect(await value(other)).toEqual({ amount: 8000, auto: true, source: "lines", recurring: null, recurring_auto: null });
  });

  it("a writer's own flags are ignored", async () => {
    const deal = await newDeal(member.id, { amount_source: "lines", recurring_amount_auto: true, amount_auto: true });
    expect(await value(deal)).toEqual({ amount: 0, auto: null, source: null, recurring: null, recurring_auto: null });
    await addLine(member.id, deal, 1200);
    await asUser(member.id, (q) => q("update public.deals set amount_source = 'first_year', amount_auto = null where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 1200, auto: true, source: "lines", recurring: null, recurring_auto: null });
  });

  it("a monthly deal: the lines are the monthly amount while nobody typed it, and the value its first year", async () => {
    const deal = await newDeal(member.id, { billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
    // empty value and recurring amount (as the form sends them), no lines yet
    // M1: nothing to compute from yet, so the value is empty (no flag, no source); the amount waits for lines
    expect(await value(deal)).toEqual({ amount: 0, auto: null, source: null, recurring: 0, recurring_auto: true });

    const line = await addLine(member.id, deal, 30000);
    expect(await value(deal)).toEqual({ amount: 360000, auto: true, source: "lines", recurring: 30000, recurring_auto: true });

    await asUser(member.id, (q) => q("update public.deal_lines set unit_price_agorot = 40000 where id = $1", [line]));
    expect(await value(deal)).toEqual({ amount: 480000, auto: true, source: "lines", recurring: 40000, recurring_auto: true });

    // to yearly: the lines are the yearly amount
    await asUser(member.id, (q) => q("update public.deals set billing_kind = 'yearly' where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 40000, auto: true, source: "lines", recurring: 40000, recurring_auto: true });
    await asUser(member.id, (q) => q("update public.deals set billing_kind = 'monthly' where id = $1", [deal]));

    // a typed recurring amount: the first year of it, and the lines no longer move it
    await asUser(member.id, (q) => q("update public.deals set recurring_amount_agorot = 50000 where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 600000, auto: true, source: "first_year", recurring: 50000, recurring_auto: null });
    await asUser(member.id, (q) => q("update public.deal_lines set unit_price_agorot = 1000 where id = $1", [line]));
    expect(await value(deal)).toEqual({ amount: 600000, auto: true, source: "first_year", recurring: 50000, recurring_auto: null });

    // emptied: the lines again
    await asUser(member.id, (q) => q("update public.deals set recurring_amount_agorot = null where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 12000, auto: true, source: "lines", recurring: 1000, recurring_auto: true });

    // a typed deal value turns off both sources for the value; the recurring amount keeps following
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 777 where id = $1", [deal]));
    await asUser(member.id, (q) => q("update public.deal_lines set unit_price_agorot = 2000 where id = $1", [line]));
    expect(await value(deal)).toEqual({ amount: 777, auto: null, source: null, recurring: 2000, recurring_auto: true });
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = null where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 24000, auto: true, source: "lines", recurring: 2000, recurring_auto: true });

    // all lines removed: the first year of the last amount
    await asUser(member.id, (q) => q("delete from public.deal_lines where id = $1", [line]));
    expect(await value(deal)).toEqual({ amount: 24000, auto: true, source: "first_year", recurring: 2000, recurring_auto: true });

    // to one-time: the recurring fields go, and the flag with them
    await asUser(member.id, (q) =>
      q("update public.deals set billing_kind = null, recurring_amount_agorot = null, recurring_start_date = null, renewal_date = null where id = $1", [deal]),
    );
    expect(await value(deal)).toEqual({ amount: 24000, auto: null, source: null, recurring: null, recurring_auto: null });
  });

  it("prices including VAT count before VAT, exempt lines at their amount, by the one totals rule", async () => {
    await setVat({ prices_include_vat: true, vat_status: "licensed" });
    try {
      const rate = await asAdmin(async (q) =>
        Number((await q<{ r: number }>("select app.vat_rate_at((now() at time zone 'Asia/Jerusalem')::date) as r")).rows[0].r),
      );
      const deal = await newDeal(member.id);
      await addLine(member.id, deal, 11800);
      await addLine(member.id, deal, 5000, { vat_exempt: true });
      await addLine(member.id, deal, 3333, { quantity: 3, discount_agorot: 99 });
      const expected = dealLinesNet(
        [
          { quantity: 1, unitPriceAgorot: 11800, discountBp: null, discountAgorot: null, vatExempt: false },
          { quantity: 1, unitPriceAgorot: 5000, discountBp: null, discountAgorot: null, vatExempt: true },
          { quantity: 3, unitPriceAgorot: 3333, discountBp: null, discountAgorot: 99, vatExempt: false },
        ],
        rate,
        true,
      );
      expect(rate).toBe(1800);
      expect(expected).not.toBeNull();
      expect(await value(deal)).toEqual({ amount: expected, auto: true, source: "lines", recurring: null, recurring_auto: null });
      // 11800 gross = 10000 net at 18%; the exempt line at its amount
      expect(expected!).toBe(10000 + 5000 + Math.round(((3 * 3333 - 99) * 10000) / 11800));

      // a business that charges no VAT: the prices are the amounts
      await setVat({ prices_include_vat: true, vat_status: "exempt" });
      // the value is recomputed on the next line change, now at rate 0
      await asUser(member.id, (q) => q("update public.deal_lines set unit_price_agorot = 6000 where deal_id = $1 and vat_exempt", [deal]));
      expect((await value(deal)).amount).toBe(11800 + 6000 + (3 * 3333 - 99));
    } finally {
      await setVat({ prices_include_vat: false, vat_status: null });
    }
  });

  it("a deal in the recycle bin: a person cannot change its lines; a server writer can, without errors; a purge cascades quietly", async () => {
    const deal = await newDeal(member.id);
    const line = await addLine(member.id, deal, 4000);
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    // RLS: the line policies need a deal that is not in the bin
    const byPerson = await asUser(owner.id, (q) => q("update public.deal_lines set unit_price_agorot = 1 where id = $1 returning id", [line]));
    expect(byPerson.rows).toHaveLength(0);
    // a server writer recomputes it like any other deal
    await asAdmin((q) => q("update public.deal_lines set unit_price_agorot = 4500 where id = $1", [line]));
    expect((await value(deal)).amount).toBe(4500);
    // purged: the lines go with the deal by cascade, no error
    await asAdmin((q) => q("delete from public.deals where id = $1", [deal]));
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.deal_lines where id = $1", [line])).toBe(0);
    });
  });

  it("another business cannot add a line or move the value, and reads no sum", async () => {
    const deal = await newDeal(member.id);
    await addLine(member.id, deal, 2000);
    const e = await pgError(
      asUser(outsider.id, (q) =>
        q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot) values ($1, $2, 'x', 1, 9999)", [org, deal]),
      ),
    );
    expect(e.code).toBe("42501");
    // no WHERE clause: nothing of this business moves
    await asUser(outsider.id, (q) => q("update public.deal_lines set unit_price_agorot = 1"));
    await asUser(outsider.id, (q) => q("delete from public.deal_lines"));
    expect((await value(deal)).amount).toBe(2000);
    // the sum helper answers nothing to a non-member
    const sum = await asUser(outsider.id, async (q) => (await q<{ s: string | null }>("select app.deal_lines_net($1, $2) as s", [org, deal])).rows[0].s);
    expect(sum).toBeNull();
    // and its own business's deals are its own
    expect(otherOrg).not.toBe(org);
  });

  it("the sum helper answers a member only for a deal they may read; a server writer always", async () => {
    const seller = await addMember(org, owner.id, "member", "value-lines-own");
    const deal = await newDeal(member.id);
    await addLine(member.id, deal, 2600);
    const sumAs = (userId: string) =>
      asUser(userId, async (q) => (await q<{ s: string | null }>("select app.deal_lines_net($1, $2) as s", [org, deal])).rows[0].s);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // a member of the business who cannot see the deal gets nothing
      expect(await sumAs(seller.id)).toBeNull();
      // its owner reads it
      expect(await sumAs(member.id)).toBe("2600");
      // a server writer (no session) always
      expect(await asAdmin(async (q) => (await q<{ s: string }>("select app.deal_lines_net($1, $2) as s", [org, deal])).rows[0].s)).toBe("2600");
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a server path run for someone the deal is hidden from keeps the value from the lines (one-time and recurring)", async () => {
    const hidden = await addMember(org, owner.id, "member", "value-lines-hidden");
    const oneTime = await newDeal(member.id);
    await addLine(member.id, oneTime, 27700);
    const recurring = await newDeal(member.id, { billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
    await addLine(member.id, recurring, 3000);
    expect(await value(oneTime)).toEqual({ amount: 27700, auto: true, source: "lines", recurring: null, recurring_auto: null });
    expect(await value(recurring)).toEqual({ amount: 36000, auto: true, source: "lines", recurring: 3000, recurring_auto: true });
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // like a definer function (merge_records through app.merge_move_links): the table owner's rights,
      // the JWT of a member who cannot read these deals
      await asAdmin(async (q) => {
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: hidden.id, role: "authenticated" })]);
        expect((await q<{ ok: boolean }>("select app.can_read_record($1, $2, null) as ok", [org, member.id])).rows[0].ok).toBe(false);
        await q("update public.deals set name = name where id = any ($1)", [[oneTime, recurring]]);
      });
      expect(await value(oneTime)).toEqual({ amount: 27700, auto: true, source: "lines", recurring: null, recurring_auto: null });
      // the recurring deal neither loses its amount nor switches to first_year
      expect(await value(recurring)).toEqual({ amount: 36000, auto: true, source: "lines", recurring: 3000, recurring_auto: true });
      // and the guarded helper still answers that member nothing
      expect(await asUser(hidden.id, async (q) => (await q<{ s: string | null }>("select app.deal_lines_net($1, $2) as s", [org, oneTime])).rows[0].s)).toBeNull();
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("the rule's helpers are not open to anon, and the recompute trigger functions to no client", async () => {
    await asAdmin(async (q) => {
      const r = await q<{ name: string; anon: boolean; auth: boolean }>(
        `select p.oid::regprocedure::text as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname in ('deal_amount_rule', 'deal_lines_net', 'deal_lines_sum', 'deal_recompute_value', 'deal_lines_recompute', 'deal_amount_auto')`,
      );
      const byName = Object.fromEntries(r.rows.map((row) => [row.name.split("(")[0], row]));
      expect(Object.keys(byName).sort()).toEqual([
        "app.deal_amount_auto",
        "app.deal_amount_rule",
        "app.deal_lines_net",
        "app.deal_lines_recompute",
        "app.deal_lines_sum",
        "app.deal_recompute_value",
      ]);
      for (const row of r.rows) expect(row.anon, row.name).toBe(false);
      expect(byName["app.deal_recompute_value"].auth).toBe(false);
      expect(byName["app.deal_lines_recompute"].auth).toBe(false);
      // the internal sum: no client role at all; only the definer trigger functions call it
      expect(byName["app.deal_lines_sum"].auth).toBe(false);
      expect(byName["app.deal_amount_auto"].auth).toBe(false);
      const svc = await q<{ ok: boolean }>("select has_function_privilege('service_role', 'app.deal_lines_sum(uuid, uuid)', 'execute') as ok");
      expect(svc.rows[0].ok).toBe(false);
    });
  });

  it("the migration is safe to run twice and leaves stored values as they were", async () => {
    const deal = await newDeal(member.id, { amount_agorot: 31400 });
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const file = fs.readdirSync(dir).find((name) => name.endsWith("_deal_value_from_lines.sql"));
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file!), "utf8");
    expect(sql).not.toMatch(/^\s*drop\s/im);
    expect(sql).not.toMatch(/delete\s+from/i);
    await asAdmin((q) => q(sql));
    await asAdmin((q) => q(sql));
    expect((await value(deal)).amount).toBe(31400);
    await asAdmin(async (q) => {
      expect(
        await count(q, "select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname in ('deals_amount_source', 'deals_recurring_amount_auto')"),
      ).toBe(2);
      expect(await count(q, "select 1 from pg_trigger where tgrelid = 'public.deal_lines'::regclass and tgname like 'deal_lines_recompute_%'")).toBe(3);
    });
  });
});
