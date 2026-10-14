import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(async () => {
  await closePool();
});

type U = { id: string };
type Recurring = { billing_kind: string | null; recurring_amount_agorot: string | null; recurring_start_date: string | null; renewal_date: string | null };

const COLUMNS = ["billing_kind", "recurring_amount_agorot", "recurring_start_date", "renewal_date"];

// DEAL-07: deals.billing_kind (null = one-time, monthly, yearly), recurring_amount_agorot,
// recurring_start_date, renewal_date. Constraint deals_recurring_shape: one-time holds no
// recurring field; recurring needs an amount >= 0 and a start date; renewal on or after the start.
describe("recurring revenue on deals (DEAL-07)", () => {
  let owner: U, member: U, viewer: U, other: U;
  let org: string, otherOrg: string;
  let stage: string, pipeline: string;
  let otherStage: string, otherPipeline: string;

  const insert = (userId: string, values: Partial<Record<string, unknown>>, orgId = org) =>
    asUser(userId, async (q) => {
      const cols = ["organization_id", "name", "pipeline_id", "stage_id", ...Object.keys(values)];
      const params = [orgId, "עסקה", orgId === org ? pipeline : otherPipeline, orgId === org ? stage : otherStage, ...Object.values(values)];
      return (
        await q<{ id: string }>(
          `insert into public.deals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          params,
        )
      ).rows[0].id;
    });
  const read = (id: string) =>
    asAdmin(async (q) => (await q<Recurring>("select billing_kind, recurring_amount_agorot, recurring_start_date::text, renewal_date::text from public.deals where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("recurring-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "recurring-member");
    viewer = await addMember(org, owner.id, "viewer", "recurring-viewer");
    other = await createUser("recurring-other");
    otherOrg = await createOrg(other.id);
    const p = await defaultPipeline(org);
    pipeline = p.pipelineId;
    stage = p.stages.find((s) => s.kind === "open")!.id;
    const o = await defaultPipeline(otherOrg);
    otherPipeline = o.pipelineId;
    otherStage = o.stages.find((s) => s.kind === "open")!.id;
  });

  it("a new deal is one-time: every recurring field is empty", async () => {
    const id = await insert(member.id, {});
    expect(await read(id)).toEqual({ billing_kind: null, recurring_amount_agorot: null, recurring_start_date: null, renewal_date: null });
  });

  it("a person saves a monthly and a yearly deal, the renewal date optional", async () => {
    const monthly = await insert(member.id, {
      billing_kind: "monthly",
      recurring_amount_agorot: 50000,
      recurring_start_date: "2026-01-31",
      renewal_date: "2026-02-28",
    });
    expect(await read(monthly)).toEqual({
      billing_kind: "monthly",
      recurring_amount_agorot: "50000",
      recurring_start_date: "2026-01-31",
      renewal_date: "2026-02-28",
    });
    const yearly = await insert(member.id, { billing_kind: "yearly", recurring_amount_agorot: 0, recurring_start_date: "2026-03-01" });
    expect((await read(yearly)).renewal_date).toBeNull();
    // a renewal on the start day itself is allowed
    await asUser(member.id, (q) => q("update public.deals set renewal_date = '2026-03-01' where id = $1", [yearly]));
    expect((await read(yearly)).renewal_date).toBe("2026-03-01");
  });

  it("refuses an unknown kind and a stored 'one_time' (null is the only one-time)", async () => {
    for (const kind of ["weekly", "one_time", ""]) {
      const e = await pgError(insert(member.id, { billing_kind: kind, recurring_amount_agorot: 100, recurring_start_date: "2026-01-01" }));
      expect(e.code).toBe("23514");
    }
  });

  it("a one-time deal holds no recurring field", async () => {
    for (const values of [{ recurring_amount_agorot: 100 }, { recurring_start_date: "2026-01-01" }, { renewal_date: "2026-02-01" }]) {
      const e = await pgError(insert(member.id, values));
      expect(e.code).toBe("23514");
      expect(e.message).toContain("deals_recurring_shape");
    }
  });

  it("a recurring deal needs an amount of zero or more and a start date; renewal not before the start", async () => {
    // DLI-03: an empty recurring amount is no longer refused; it follows the product lines (0 while there are none),
    // and an empty value stays empty: no flag and no source while there is nothing to compute from
    const empty = await insert(member.id, { billing_kind: "monthly", recurring_start_date: "2026-01-01", amount_agorot: null });
    await asAdmin(async (q) => {
      const r = await q<{ recurring_amount_agorot: string; recurring_amount_auto: boolean | null; amount_agorot: string; amount_auto: boolean | null; amount_source: string | null }>(
        "select recurring_amount_agorot::text, recurring_amount_auto, amount_agorot::text, amount_auto, amount_source from public.deals where id = $1",
        [empty],
      );
      expect(r.rows[0]).toEqual({ recurring_amount_agorot: "0", recurring_amount_auto: true, amount_agorot: "0", amount_auto: null, amount_source: null });
    });
    const cases: Array<Record<string, unknown>> = [
      { billing_kind: "monthly", recurring_amount_agorot: 100 },
      { billing_kind: "yearly", recurring_amount_agorot: -1, recurring_start_date: "2026-01-01" },
      { billing_kind: "yearly", recurring_amount_agorot: 100, recurring_start_date: "2026-01-02", renewal_date: "2026-01-01" },
    ];
    for (const values of cases) {
      const e = await pgError(insert(member.id, values));
      expect(e.code).toBe("23514");
    }
  });

  it("switching back to one-time must clear the fields in the same update", async () => {
    const id = await insert(owner.id, { billing_kind: "monthly", recurring_amount_agorot: 1000, recurring_start_date: "2026-05-01" });
    const half = await pgError(asUser(owner.id, (q) => q("update public.deals set billing_kind = null where id = $1", [id])));
    expect(half.code).toBe("23514");
    await asUser(owner.id, (q) =>
      q("update public.deals set billing_kind = null, recurring_amount_agorot = null, recurring_start_date = null, renewal_date = null where id = $1", [id]),
    );
    expect((await read(id)).billing_kind).toBeNull();
  });

  it("the client holds insert and update grants on every new column", async () => {
    await asAdmin(async (q) => {
      for (const column of COLUMNS) {
        for (const privilege of ["INSERT", "UPDATE", "SELECT"]) {
          const r = await q<{ ok: boolean }>("select has_column_privilege('authenticated', 'public.deals', $1, $2) as ok", [column, privilege]);
          expect(r.rows[0].ok, `${privilege} ${column}`).toBe(true);
        }
        const anon = await q<{ ok: boolean }>("select has_column_privilege('anon', 'public.deals', $1, 'UPDATE') as ok", [column]);
        expect(anon.rows[0].ok, `anon UPDATE ${column}`).toBe(false);
      }
    });
  });

  it("RLS still decides who writes: a viewer and another business cannot touch the fields", async () => {
    const id = await insert(owner.id, { billing_kind: "yearly", recurring_amount_agorot: 120000, recurring_start_date: "2026-01-01" });
    // a viewer updates nothing
    const byViewer = await asUser(viewer.id, (q) => q("update public.deals set recurring_amount_agorot = 1 where id = $1 returning id", [id]));
    expect(byViewer.rows).toHaveLength(0);
    // another business neither sees nor changes the deal, also without a where clause
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.deals where id = $1", [id]))).toBe(0);
    const byOther = await asUser(other.id, (q) => q("update public.deals set recurring_amount_agorot = 1 where id = $1 returning id", [id]));
    expect(byOther.rows).toHaveLength(0);
    await asUser(other.id, (q) => q("update public.deals set renewal_date = recurring_start_date where billing_kind is not null"));
    expect(await read(id)).toEqual({ billing_kind: "yearly", recurring_amount_agorot: "120000", recurring_start_date: "2026-01-01", renewal_date: null });
    // and cannot create a recurring deal in this business
    const e = await pgError(
      asUser(other.id, (q) =>
        q(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, billing_kind, recurring_amount_agorot, recurring_start_date) values ($1, 'x', $2, $3, 'monthly', 1, '2026-01-01')",
          [org, pipeline, stage],
        ),
      ),
    );
    expect(e.code).toBe("42501");
  });

  it("changes are audited field by field", async () => {
    const id = await insert(owner.id, {});
    await asUser(owner.id, (q) =>
      q("update public.deals set billing_kind = 'monthly', recurring_amount_agorot = 2500, recurring_start_date = '2026-06-01' where id = $1", [id]),
    );
    await asAdmin(async (q) => {
      const r = await q<{ changes: Record<string, unknown> }>(
        "select changes from public.audit_log where entity_type = 'deals' and entity_id = $1 and action = 'update' order by id desc limit 1",
        [id],
      );
      expect(Object.keys(r.rows[0].changes)).toEqual(expect.arrayContaining(["billing_kind", "recurring_amount_agorot", "recurring_start_date"]));
    });
  });

  it("a sample deal noted before these columns existed is still untouched, and removable", async () => {
    const sampleOwner = await createUser("recurring-sample");
    const sampleOrg = await createOrg(sampleOwner.id);
    await asUser(sampleOwner.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    // an old snapshot has none of the new keys
    await asAdmin((q) =>
      q(
        "update app.sample_records set snapshot = snapshot - array['billing_kind', 'recurring_amount_agorot', 'recurring_start_date', 'renewal_date', 'amount_auto'] where organization_id = $1 and deal_id is not null",
        [sampleOrg],
      ),
    );
    const deals = await asAdmin(async (q) => (await q<{ id: string }>("select deal_id as id from app.sample_records where organization_id = $1 and deal_id is not null", [sampleOrg])).rows);
    expect(deals.length).toBeGreaterThan(0);
    const res = await asUser(sampleOwner.id, (q) => q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [sampleOrg]));
    expect(res.rows[0].r.kept).toBe(0);
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.deals where id = any ($1)", [deals.map((d) => d.id)])).toBe(0);
    });
  });

  it("a sample deal a person made recurring is kept", async () => {
    const sampleOwner = await createUser("recurring-sample-kept");
    const sampleOrg = await createOrg(sampleOwner.id);
    await asUser(sampleOwner.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    const dealId = await asAdmin(
      async (q) => (await q<{ id: string }>("select deal_id as id from app.sample_records where organization_id = $1 and deal_id is not null limit 1", [sampleOrg])).rows[0].id,
    );
    await asUser(sampleOwner.id, (q) =>
      q("update public.deals set billing_kind = 'monthly', recurring_amount_agorot = 100, recurring_start_date = '2026-01-01' where id = $1", [dealId]),
    );
    const res = await asUser(sampleOwner.id, (q) => q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [sampleOrg]));
    expect(res.rows[0].r.kept).toBeGreaterThanOrEqual(1);
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.deals where id = $1", [dealId])).toBe(1);
    });
  });

  it("the migration is safe to run twice", async () => {
    const fs = await import("node:fs");
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const file = fs.readdirSync(dir).find((name) => name.endsWith("_deal_recurring.sql"));
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file!), "utf8");
    // DLI-03 redefines app.deal_value() and the trigger function: re-run it after, so later tests see the latest rule
    const later = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith("_deal_value_from_lines.sql"))!), "utf8");
    // DLI-04 redefines them again
    const latest = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith("_deal_line_billing.sql"))!), "utf8");
    await asAdmin((q) => q(sql));
    await asAdmin((q) => q(sql));
    await asAdmin((q) => q(later));
    await asAdmin((q) => q(latest));
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname in ('deals_billing_kind', 'deals_recurring_shape', 'deals_amount_auto_true')")).toBe(3);
    });
  });
});

type Fixture = {
  name: string;
  kind: string | null;
  recurring: number | null;
  amount: number | null;
  old_amount: number | null;
  old_auto: boolean | null;
  insert: boolean;
  lines?: number | null;
  // DLI-04: the lines' sums per billing mode (app.deal_lines_sums); a case with them runs app.deal_value_rule()
  lines_once?: number | null;
  lines_monthly?: number | null;
  lines_quarterly?: number | null;
  lines_yearly?: number | null;
  old_recurring?: number | null;
  old_recurring_auto?: boolean | null;
  old_source?: string | null;
  expect: { amount: number; auto: true | null; source?: string | null; recurring?: number | null; recurring_auto?: true | null } | { error: string };
};

// the same cases run against dealValueRule() in tests/unit/deal-recurring.test.ts
const FIXTURES = JSON.parse(readFileSync(path.resolve(__dirname, "../unit/fixtures/deal-value.json"), "utf8")) as Fixture[];

describe("first-year value: app.deal_value() matches the shared fixtures", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", async (_name, f) => {
    // DLI-04: the full rule takes the lines' sums per billing mode; DLI-03's entry point (one sum, in the deal's own
    // period) and app.deal_value() (no lines) are the same rule
    type Row = { amount: string; auto: boolean | null; source: string | null; recurring: string | null; recurring_auto: boolean | null };
    const byBilling = "lines_once" in f || "lines_monthly" in f || "lines_quarterly" in f || "lines_yearly" in f;
    const run = byBilling
      ? asAdmin((q) =>
          q<Row>(
            "select amount::text, auto, source, recurring::text, recurring_auto from app.deal_value_rule($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
            [
              f.kind,
              f.recurring,
              f.amount,
              f.old_amount,
              f.old_auto,
              f.insert,
              f.lines_once ?? null,
              f.lines_monthly ?? null,
              f.lines_quarterly ?? null,
              f.lines_yearly ?? null,
              f.old_recurring ?? null,
              f.old_recurring_auto ?? null,
              f.old_source ?? null,
            ],
          ),
        )
      : asAdmin((q) =>
          q<Row>(
            "select amount::text, auto, source, recurring::text, recurring_auto from app.deal_amount_rule($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [f.kind, f.recurring, f.amount, f.old_amount, f.old_auto, f.insert, f.lines ?? null, f.old_recurring ?? null, f.old_recurring_auto ?? null, f.old_source ?? null],
          ),
        );
    if ("error" in f.expect) {
      const e = await pgError(run);
      expect(e.code).toBe("P0001");
      expect(e.hint).toBe(f.expect.error);
    } else {
      const row = (await run).rows[0];
      const shaped: Record<string, unknown> = { amount: Number(row.amount), auto: row.auto };
      if ("source" in f.expect) shaped.source = row.source;
      if ("recurring" in f.expect) shaped.recurring = row.recurring === null ? null : Number(row.recurring);
      if ("recurring_auto" in f.expect) shaped.recurring_auto = row.recurring_auto;
      expect(shaped).toEqual(f.expect);
      // a case without lines answers the same through DEAL-07's entry point
      if (!byBilling && f.lines == null && f.old_recurring == null && f.old_source == null) {
        const old = await asAdmin((q) =>
          q<{ amount: string; auto: boolean | null }>("select amount::text, auto from app.deal_value($1, $2, $3, $4, $5, $6)", [
            f.kind,
            f.recurring,
            f.amount,
            f.old_amount,
            f.old_auto,
            f.insert,
          ]),
        );
        expect({ amount: Number(old.rows[0].amount), auto: old.rows[0].auto }).toEqual({ amount: shaped.amount, auto: shaped.auto });
      }
    }
  });
});

// trigger deals_amount_auto applies the rule to every writer and derives deals.amount_auto
describe("first-year value on deals (DEAL-07, owner 14 October 2026)", () => {
  let owner: U, member: U;
  let org: string, stage: string, wonStage: string, pipeline: string;

  const value = (id: string) =>
    asAdmin(async (q) => {
      const r = (await q<{ amount: string; auto: boolean | null }>("select amount_agorot::text as amount, amount_auto as auto from public.deals where id = $1", [id])).rows[0];
      return { amount: Number(r.amount), auto: r.auto };
    });
  const newDeal = (userId: string, cols: Record<string, unknown>) =>
    asUser(userId, async (q) => {
      const names = ["organization_id", "name", "pipeline_id", "stage_id", ...Object.keys(cols)];
      const params = [org, "חוזה שירות", pipeline, stage, ...Object.values(cols)];
      return (await q<{ id: string }>(`insert into public.deals (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, params)).rows[0].id;
    });
  const monthly = (amount: number | null, recurring = 50000) => ({
    amount_agorot: amount,
    billing_kind: "monthly",
    recurring_amount_agorot: recurring,
    recurring_start_date: "2026-01-01",
  });

  beforeAll(async () => {
    owner = await createUser("first-year-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "first-year-member");
    const p = await defaultPipeline(org);
    pipeline = p.pipelineId;
    stage = p.stages.find((s) => s.kind === "open")!.id;
    wonStage = p.stages.find((s) => s.kind === "won")!.id;
  });

  it("an empty value on a recurring deal is the first-year value, flagged", async () => {
    expect(await value(await newDeal(member.id, monthly(null)))).toEqual({ amount: 600000, auto: true });
    expect(
      await value(await newDeal(member.id, { amount_agorot: null, billing_kind: "yearly", recurring_amount_agorot: 70000, recurring_start_date: "2026-01-01" })),
    ).toEqual({ amount: 70000, auto: true });
  });

  it("one-time: no computation; empty stays empty and the flag is off", async () => {
    expect(await value(await newDeal(member.id, { amount_agorot: null }))).toEqual({ amount: 0, auto: null });
    expect(await value(await newDeal(member.id, {}))).toEqual({ amount: 0, auto: null });
    expect(await value(await newDeal(member.id, { amount_agorot: 5000 }))).toEqual({ amount: 5000, auto: null });
  });

  it("while the flag is on, a change of the recurring amount or the kind recomputes", async () => {
    const id = await newDeal(member.id, monthly(null));
    await asUser(member.id, (q) => q("update public.deals set recurring_amount_agorot = 60000 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 720000, auto: true });
    await asUser(member.id, (q) => q("update public.deals set billing_kind = 'yearly' where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 60000, auto: true });
    // the form sends the old value with the change: still unchanged, still computed
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 60000, recurring_amount_agorot = 65000 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 65000, auto: true });
  });

  it("inline edit: a plain value update turns the flag off, and the value never changes again", async () => {
    const id = await newDeal(member.id, monthly(null));
    const r = await asUser(member.id, (q) => q("update public.deals set amount_agorot = 123400 where id = $1 returning id", [id]));
    expect(r.rows).toHaveLength(1);
    expect(await value(id)).toEqual({ amount: 123400, auto: null });
    await asUser(member.id, (q) => q("update public.deals set recurring_amount_agorot = 99000, billing_kind = 'yearly' where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 123400, auto: null });
  });

  it("clearing the value turns computing back on", async () => {
    const id = await newDeal(member.id, monthly(1000));
    expect(await value(id)).toEqual({ amount: 1000, auto: null });
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = null where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 600000, auto: true });
  });

  it("a move to one-time keeps the value and turns the flag off", async () => {
    const id = await newDeal(member.id, monthly(null));
    await asUser(member.id, (q) =>
      q("update public.deals set billing_kind = null, recurring_amount_agorot = null, recurring_start_date = null, renewal_date = null where id = $1", [id]),
    );
    expect(await value(id)).toEqual({ amount: 600000, auto: null });
  });

  it("the flag is server-derived: a writer's own value for it is ignored", async () => {
    const id = await newDeal(member.id, { amount_agorot: 5000, amount_auto: true });
    expect(await value(id)).toEqual({ amount: 5000, auto: null });
    const auto = await newDeal(member.id, monthly(null));
    await asUser(member.id, (q) => q("update public.deals set amount_auto = null where id = $1", [auto]));
    expect(await value(auto)).toEqual({ amount: 600000, auto: true });
    // false is never stored (constraint deals_amount_auto_true)
    await asAdmin((q) => q("update public.deals set amount_auto = false where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 5000, auto: null });
  });

  it("the won window and a stage move keep a computed value computed", async () => {
    const id = await newDeal(owner.id, monthly(null));
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $2, amount_agorot = 600000, closed_at = now() where id = $1", [id, wonStage]));
    expect(await value(id)).toEqual({ amount: 600000, auto: true });
  });

  it("a typed value turns the flag off even when it equals the first-year value", async () => {
    expect(await value(await newDeal(owner.id, monthly(600000)))).toEqual({ amount: 600000, auto: null });
    const id = await newDeal(owner.id, monthly(null));
    await asUser(owner.id, (q) => q("update public.deals set amount_agorot = 720000, recurring_amount_agorot = 60000 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 720000, auto: null });
    await asUser(owner.id, (q) => q("update public.deals set recurring_amount_agorot = 1 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 720000, auto: null });
  });

  it("duplicate: a computed source is copied with an empty value, so the copy stays automatic", async () => {
    const source = await newDeal(owner.id, monthly(null));
    // what duplicateDealAction sends for a source with amount_auto = true
    const copy = await newDeal(owner.id, monthly(null));
    expect(await value(source)).toEqual({ amount: 600000, auto: true });
    expect(await value(copy)).toEqual({ amount: 600000, auto: true });
    await asUser(owner.id, (q) => q("update public.deals set recurring_amount_agorot = 70000 where id = $1", [copy]));
    expect(await value(copy)).toEqual({ amount: 840000, auto: true });
  });

  it("won window: a value cleared in the window gets the first-year value back, flagged", async () => {
    const id = await newDeal(owner.id, monthly(null));
    await asUser(owner.id, (q) => q("update public.deals set amount_agorot = 5 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 5, auto: null });
    // closeDealWonAction sends typedDealValue(""): null
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $2, amount_agorot = null, closed_at = now() where id = $1", [id, wonStage]));
    expect(await value(id)).toEqual({ amount: 600000, auto: true });
  });

  it("server writers follow the same rule", async () => {
    const id = await newDeal(owner.id, monthly(null));
    await asAdmin((q) => q("update public.deals set recurring_amount_agorot = 10000 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 120000, auto: true });
    await asAdmin((q) => q("update public.deals set amount_agorot = 7 where id = $1", [id]));
    expect(await value(id)).toEqual({ amount: 7, auto: null });
  });

  it("a first-year value too big is refused with a hint", async () => {
    const e = await pgError(newDeal(member.id, monthly(null, 900719925474100)));
    expect(e.code).toBe("P0001");
    expect(e.hint).toBe("deal:amount_too_big");
    // a recurring amount whose 12 months pass bigint is refused the same way, not with an overflow
    const big = await pgError(newDeal(member.id, monthly(null, 922337203685477580)));
    expect(big.hint).toBe("deal:amount_too_big");
    // a typed value is not computed, so it is accepted
    const typed = await newDeal(member.id, monthly(5000, 900719925474100));
    expect(await value(typed)).toEqual({ amount: 5000, auto: null });
  });
});
