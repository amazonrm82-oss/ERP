import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchNorm } from "../../src/lib/search-norm";
import { asAdmin, asAnon, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

afterAll(closePool);

// FXC-11: the lists search the same normalized text as the global search. public.search_text(<table>) applies
// app.search_norm to the row; the app folds the term with searchNorm() (src/lib/search-norm.ts) and filters
// `search_text like '%term%'`.
describe("one normalized search for the lists (FXC-11)", () => {
  let owner: { id: string };
  let org: string;

  // what the app sends: the term folded in TypeScript, matched as a substring of the row's search_text
  const find = (table: string, term: string) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `select t.id from public.${table} t where t.organization_id = $1 and public.search_text(t) like '%' || $2 || '%' order by t.id`,
          [org, searchNorm(term)],
        )
      ).rows.map((r) => r.id),
    );

  beforeAll(async () => {
    owner = await createUser("ls-owner");
    org = await createOrg(owner.id, "עסק חיפוש");
  });

  it("searchNorm folds exactly like app.search_norm", async () => {
    const samples = [
      "דָּן כֹּהֵן",
      "שָׁלוֹם",
      'אחים כ"ץ בע"מ',
      "ג׳ורג׳ ו״ש",
      "O'Brien \"Ltd\"",
      "MiXeD Case ABC",
      "ךםןףץ ךםןףץ",
      "מָקוֹם־טוֹב",
      "דָּוִד 052-1234567 david@example.com",
      "",
      "   רווחים   ",
      "emoji 😀 and ü é ß",
      "a_b%c",
      "ИВАН Петров",
      // "İ" is left out: lower() follows the locale; hosted (en_US.UTF-8) gives "i" + U+0307 like JavaScript, the
      // C.UTF-8 test database a plain "i" (see src/lib/search-norm.ts)
    ];
    const sql = await asAdmin(async (q) =>
      (await q<{ v: string }>("select app.search_norm(x) as v from unnest($1::text[]) with ordinality as t(x, n) order by n", [samples])).rows.map((r) => r.v),
    );
    expect(samples.map((s) => searchNorm(s))).toEqual(sql);
  });

  it("a lead is found by its name without niqqud, with or without final letters, by company and by email", async () => {
    const dan = await insertLead(owner.id, org, { full_name: "דָּן כֹּהֵן", company_name: 'אחים כ"ץ', email: "Dan@Example.com" });
    const sharon = await insertLead(owner.id, org, { full_name: "שרון לוי" });
    expect(await find("leads", "דן")).toEqual([dan]);
    expect(await find("leads", "כהן")).toEqual([dan]);
    expect(await find("leads", "כץ")).toEqual([dan]);
    expect(await find("leads", 'כ"ץ')).toEqual([dan]);
    expect(await find("leads", "dan@example")).toEqual([dan]);
    // a final letter typed in the middle of a word, or its regular form at the end
    expect(await find("leads", "שרונ")).toEqual([sharon]);
    // an exact substring: a near miss is not a list match (the top bar keeps those)
    expect(await find("leads", "שרוו")).toEqual([]);
  });

  it("every list type searches its own fields, normalized", async () => {
    const pipe = await defaultPipeline(org);
    const ids = await asAdmin(async (q) => {
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, last_name, email) values ($1, 'יוֹסֵף', 'מִזְרָחִי', 'yosef@ex.com') returning id", [org])).rows[0].id;
      const company = (await q<{ id: string }>("insert into public.companies (organization_id, name, tax_id, city) values ($1, 'מַאֲפִיַּת הַכְּפָר', '514000000', 'רָמַת גַּן') returning id", [org])).rows[0].id;
      const deal = (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עִסְקַת חֹרֶף', $2, $3) returning id", [org, pipe.pipelineId, pipe.stages[0].id])).rows[0].id;
      const task = (await q<{ id: string }>("insert into public.tasks (organization_id, title) values ($1, 'לְהִתְקַשֵּׁר לְיוֹסֵף') returning id", [org])).rows[0].id;
      const product = (await q<{ id: string }>("insert into public.products (organization_id, name, sku, barcode, price_agorot) values ($1, 'שֻׁלְחָן עֵץ', 'TBL-01', '7290000000001', 10000) returning id", [org])).rows[0].id;
      return { contact, company, deal, task, product };
    });
    expect(await find("contacts", "יוסף מזרחי")).toEqual([ids.contact]);
    expect(await find("contacts", "YOSEF@")).toEqual([ids.contact]);
    // niqqud and its spelling: מַאֲפִיַּת is מאפית without the points (a fuller spelling is not folded)
    expect(await find("companies", "מאפית הכפר")).toEqual([ids.company]);
    expect(await find("companies", "מאפיית")).toEqual([]);
    expect(await find("companies", "514000")).toEqual([ids.company]);
    // the city, which the companies list searched before
    expect(await find("companies", "רמת גן")).toEqual([ids.company]);
    expect(await find("deals", "עסקת חרף")).toEqual([ids.deal]);
    expect(await find("tasks", "להתקשר")).toEqual([ids.task]);
    expect(await find("products", "שולחן")).toEqual([]);
    expect(await find("products", "שלחן עץ")).toEqual([ids.product]);
    expect(await find("products", "tbl-01")).toEqual([ids.product]);
    expect(await find("products", "7290000")).toEqual([ids.product]);
  });

  it("leads, contacts, deals and companies inline to exactly the expression of a trigram index", async () => {
    // the planner may only use an expression index for the very same expression; on these tiny tables it prefers
    // another index anyway, so compare the inlined filter of the plan with the index's own expression
    const bare = (text: string) => text.replace(/[()\s]/g, "");
    for (const [table, index] of [
      ["leads", "leads_search_idx"],
      ["contacts", "contacts_search_idx"],
      ["deals", "deals_search_idx"],
      ["companies", "companies_list_search_idx"],
    ] as const) {
      const { plan, expression } = await asAdmin(async (q) => {
        const rows = (
          await q<{ "QUERY PLAN": string }>(
            `explain select t.id from public.${table} t where t.deleted_at is null and public.search_text(t) like '%שלום עולמ%'`,
          )
        ).rows;
        const expr = (await q<{ e: string }>("select pg_get_expr(i.indexprs, i.indrelid) as e from pg_index i where i.indexrelid = $1::regclass", [`public.${index}`])).rows[0].e;
        return { plan: rows.map((r) => r["QUERY PLAN"]).join("\n"), expression: expr };
      });
      expect(expression, index).toContain("search_norm");
      expect(bare(plan), table).toContain(`${bare(expression)}~~`);
    }
  });

  it("with many companies, the list's search uses companies_list_search_idx (rolled back afterwards)", async () => {
    const ROLLBACK = new Error("roll back the sample companies");
    let plan = "";
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.companies (organization_id, name, city)
         select $1, 'חברה ' || g || ' ' || md5(g::text), 'עיר ' || (g % 50) from generate_series(1, 20000) g`,
        [org],
      );
      await q("analyze public.companies");
      plan = (
        await q<{ "QUERY PLAN": string }>(
          `explain select t.id from public.companies t
            where t.organization_id = $1 and t.deleted_at is null and public.search_text(t) like '%מאפית הכפר%'`,
          [org],
        )
      ).rows.map((r) => r["QUERY PLAN"]).join("\n");
      throw ROLLBACK;
    }).catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
    expect(plan).toContain("companies_list_search_idx");
    expect(await find("companies", "חברה 1 ")).toEqual([]);
  });

  it("is security invoker, inlinable (no SET clause), and closed to anon", async () => {
    const fns = await asAdmin(async (q) =>
      (
        await q<{ arg: string; definer: boolean; config: string[] | null; anon: boolean; authed: boolean }>(
          `select pg_get_function_identity_arguments(p.oid) as arg, p.prosecdef as definer, p.proconfig as config,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as authed
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'search_text' order by 1`,
        )
      ).rows,
    );
    expect(fns.map((f) => f.arg)).toEqual(["companies", "contacts", "deals", "leads", "products", "tasks"]);
    for (const f of fns) {
      expect(f, f.arg).toMatchObject({ definer: false, config: null, anon: false, authed: true });
    }
    await expect(asAnon((q) => q("select public.search_text(l) from public.leads l limit 1"))).rejects.toThrow();
  });

  it("the migration is safe to run twice", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sql = readFileSync(path.join(__dirname, "../../supabase/migrations/20261006020055_list_search.sql"), "utf8");
    await asAdmin(async (q) => {
      await q(sql);
      await q(sql);
    });
    expect(await find("leads", "דן")).toHaveLength(1);
  });
});
