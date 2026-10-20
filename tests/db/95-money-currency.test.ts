import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultLeadStatus, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

/**
 * Tables with an amount whose currency is said elsewhere, with the reason.
 * Every other table with an *_agorot column must have a `currency` column (TAX-06).
 */
const NO_CURRENCY_COLUMN: Record<string, string> = {
  // the platform's own price list (shared ground), billed in shekels
  plans: "platform price list",
};

/** TAX-06: a currency column next to every amount; shekels only for now. */
describe("currency next to every amount", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("money-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "money-member");
  });

  it("every public table with an amount in agorot has a currency column (or a reason above)", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ table_name: string; has_currency: boolean }>(
          `select c.table_name,
                  exists (select 1 from information_schema.columns x
                           where x.table_schema = 'public' and x.table_name = c.table_name and x.column_name = 'currency') as has_currency
             from information_schema.columns c
             join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
            where c.table_schema = 'public' and c.column_name like '%\\_agorot'
            group by c.table_name`,
        )
      ).rows,
    );
    const tables = rows.map((row) => row.table_name);
    expect(tables).toEqual(expect.arrayContaining(["deals", "leads"]));
    const missing = rows.filter((row) => !row.has_currency && !(row.table_name in NO_CURRENCY_COLUMN)).map((row) => row.table_name);
    expect(missing).toEqual([]);
  });

  it("a lead's budget is in shekels: the default, and the only value accepted", async () => {
    const status = await defaultLeadStatus(org);
    const lead = await asUser(member.id, async (q) =>
      (
        await q<{ id: string; currency: string }>(
          "insert into public.leads (organization_id, status_id, full_name, budget_agorot) values ($1, $2, 'ליד', 500000) returning id, currency",
          [org, status],
        )
      ).rows[0],
    );
    expect(lead.currency).toBe("ILS");
    // a client may send it (column grant), and only ILS passes
    await asUser(member.id, (q) =>
      q("insert into public.leads (organization_id, status_id, full_name, currency) values ($1, $2, 'ליד 2', 'ILS')", [org, status]),
    );
    expect((await pgError(asUser(member.id, (q) => q("update public.leads set currency = 'USD' where id = $1", [lead.id])))).code).toBe("23514");
    expect((await pgError(asUser(member.id, (q) => q("update public.leads set currency = null where id = $1", [lead.id])))).code).toBe("23502");
    expect(
      (await pgError(asUser(member.id, (q) => q("insert into public.leads (organization_id, status_id, full_name, currency) values ($1, $2, 'x', 'EUR')", [org, status])))).code,
    ).toBe("23514");
  });

  it("a deal is in shekels by default, and USD is refused", async () => {
    const status = await asAdmin(async (q) =>
      (
        await q<{ pipeline_id: string; stage_id: string }>(
          "select p.id as pipeline_id, s.id as stage_id from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default order by s.position limit 1",
          [org],
        )
      ).rows[0],
    );
    const deal = await asUser(member.id, async (q) =>
      (
        await q<{ id: string; currency: string }>(
          "insert into public.deals (organization_id, pipeline_id, stage_id, name, amount_agorot) values ($1, $2, $3, 'עסקה', 100000) returning id, currency",
          [org, status.pipeline_id, status.stage_id],
        )
      ).rows[0],
    );
    expect(deal.currency).toBe("ILS");
    expect((await pgError(asUser(member.id, (q) => q("update public.deals set currency = 'USD' where id = $1", [deal.id])))).code).toBe("23514");
  });

  it("every currency column next to an amount refuses anything but ILS", async () => {
    const tables = await asAdmin(async (q) =>
      (
        await q<{ table_name: string }>(
          `select distinct c.table_name
             from information_schema.columns c
             join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
            where c.table_schema = 'public' and c.column_name = 'currency'
              and exists (select 1 from information_schema.columns a
                           where a.table_schema = 'public' and a.table_name = c.table_name and a.column_name like '%\\_agorot')`,
        )
      ).rows.map((row) => row.table_name),
    );
    expect(tables).toEqual(expect.arrayContaining(["deals", "leads"]));
    // by behaviour, on every such table: a row of this test's own organization, set to USD, refused. The rows are
    // made here (as the server, triggers off; CHECK constraints still apply), so the test passes alone and in any
    // order; a new table needs its own line in SAMPLE_ROWS.
    const status = await defaultLeadStatus(org);
    const pipe = await defaultPipeline(org);
    const SAMPLE_ROWS: Record<string, (q: Query) => Promise<void>> = {
      leads: async (q) => {
        await q("insert into public.leads (organization_id, status_id, full_name) values ($1, $2, 'ליד לבדיקת מטבע')", [org, status]);
      },
      deals: async (q) => {
        await q("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה לבדיקת מטבע', $2, $3)", [org, pipe.pipelineId, pipe.stages[0].id]);
      },
      products: async (q) => {
        await q("insert into public.products (organization_id, name) values ($1, 'מוצר לבדיקת מטבע')", [org]);
      },
      price_list_lines: async (q) => {
        const product = (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'מוצר במחירון') returning id", [org])).rows[0].id;
        const list = (await q<{ id: string }>("insert into public.price_lists (organization_id, name, prices_include_vat) values ($1, 'מחירון לבדיקה', false) returning id", [org])).rows[0].id;
        await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, price_agorot) values ($1, $2, $3, 1000)", [org, list, product]);
      },
      product_costs: async (q) => {
        const product = (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'מוצר עם עלות') returning id", [org])).rows[0].id;
        await q("insert into public.product_costs (organization_id, product_id, cost_agorot) values ($1, $2, 500)", [org, product]);
      },
      deal_lines: async (q) => {
        const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה עם שורה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
        await q("insert into public.deal_lines (organization_id, deal_id, description, price_includes_vat, price_source, quantity, unit_price_agorot) values ($1, $2, 'שורה', false, 'manual', 1, 1000)", [org, deal]);
      },
      // PRD-06 follow-up
      deal_line_costs: async (q) => {
        const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה עם עלות בשורה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
        const line = (
          await q<{ id: string }>(
            "insert into public.deal_lines (organization_id, deal_id, description, price_includes_vat, price_source, quantity, unit_price_agorot) values ($1, $2, 'שורה', false, 'manual', 1, 1000) returning id",
            [org, deal],
          )
        ).rows[0].id;
        await q("insert into public.deal_line_costs (organization_id, deal_line_id, cost_agorot) values ($1, $2, 400)", [org, line]);
      },
      // QUO-01, QUO-02
      quotes: async (q) => {
        const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה עם הצעה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
        await q("insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה לבדיקת מטבע', $2)", [org, deal]);
      },
      quote_lines: async (q) => {
        const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה עם הצעה ושורה', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
        const quote = (await q<{ id: string }>("insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה עם שורה', $2) returning id", [org, deal])).rows[0].id;
        await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, quote]);
      },
      // ORD-01
      orders: async (q) => {
        await q("insert into public.orders (organization_id) values ($1)", [org]);
      },
      order_lines: async (q) => {
        const order = (await q<{ id: string }>("insert into public.orders (organization_id) values ($1) returning id", [org])).rows[0].id;
        await q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, order]);
      },
      // DOC-01
      accounting_documents: async (q) => {
        const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'לקוח למסמך') returning id", [org])).rows[0].id;
        await q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'CUR-1', 1000)", [org, contact]);
      },
      // QUO-04
      quote_template_lines: async (q) => {
        const template = (await q<{ id: string }>("insert into public.quote_templates (organization_id, name) values ($1, 'תבנית לבדיקת מטבע') returning id", [org])).rows[0].id;
        await q("insert into public.quote_template_lines (organization_id, template_id, name, unit_price_agorot) values ($1, $2, 'שורה', 1000)", [org, template]);
      },
    };
    expect(tables.filter((table) => !(table in SAMPLE_ROWS)), "add a sample row for every table with a currency").toEqual([]);
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      for (const table of tables) await SAMPLE_ROWS[table](q);
    });
    for (const table of tables) {
      const error = await pgError(
        asAdmin(async (q) => {
          const res = await q(
            `update public.${table} set currency = 'USD' where ctid = (select ctid from public.${table} where organization_id = $1 limit 1) returning 1`,
            [org],
          );
          if (res.rowCount === 0) throw Object.assign(new Error(`no row in ${table} to try`), { code: "no_row" });
        }),
      );
      expect(error.code, table).toBe("23514");
    }
  });

  it("sample leads noted before the column existed still count as untouched", async () => {
    const other = await createUser("money-sample");
    const org2 = await createOrg(other.id);
    await asUser(other.id, (q) => q("select public.sample_data_add($1)", [org2]));
    // as on the hosted database: notes taken before this migration have no currency key
    await asAdmin((q) => q("update app.sample_records set snapshot = snapshot - 'currency' where organization_id = $1 and lead_id is not null", [org2]));
    const rows = await asUser(other.id, async (q) =>
      (await q<{ record_type: string; removable: boolean }>("select * from public.sample_data_records($1)", [org2])).rows,
    );
    const leads = rows.filter((row) => row.record_type === "lead");
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((row) => row.removable)).toBe(true);
    // a lead that a person changed is still kept (app.sample_records is not readable by clients: pick it as admin)
    const changed = await asAdmin(async (q) =>
      (await q<{ id: string }>("select lead_id as id from app.sample_records where organization_id = $1 and lead_id is not null limit 1", [org2])).rows[0].id,
    );
    await asUser(other.id, (q) => q("update public.leads set budget_agorot = 12345 where id = $1", [changed]));
    const after = await asUser(other.id, async (q) =>
      (await q<{ record_type: string; removable: boolean }>("select * from public.sample_data_records($1)", [org2])).rows,
    );
    expect(after.filter((row) => row.record_type === "lead" && !row.removable)).toHaveLength(1);
  });
});
