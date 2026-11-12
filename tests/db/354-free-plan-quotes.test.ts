import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Usage = { usage: Array<{ key: string; limit: number | null; used: number }> };

/**
 * Owner, 12 November 2026, answers (331) א and (330) א (migration free_plan_quotes): the hidden free plan sends 3 quotes a
 * month (max_quotes_per_month, counted when a quote leaves draft, per business and month of its own time zone; a version or
 * a duplicate counts only when sent) and reads "כסף שמחכה" without its row actions (money_waiting_actions off). The sold
 * plans have no quote cap and keep the actions; a plan that does not hold the keys falls back to 0 and off.
 * (336) ב: a new version of a sent quote is not counted, only a new chain (an addendum counts, lead's choice).
 * (335) ב, (337) א: a quote's PDF is never counted in max_pdf_per_month, in any plan; the free plan's quota is 0, so a
 * report PDF stays refused there.
 */
describe("the free plan: quotes a month and money waiting to read only", () => {
  let owner: U;
  let proOwner: U;
  let org: string;
  let proOrg: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const setUp = async (u: U, o: string) => {
    await asUser(u.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [o],
      ),
    );
    return asUser(u.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [o])).id);
  };
  const newQuote = (u: U, o: string, contact: string) =>
    asUser(u.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [o, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שורה', 10000)", [o, id]);
      return id;
    });
  const send = (u: U, o: string, id: string) =>
    asUser(u.id, async (q) => (await one<{ r: { number: string } }>(q, "select public.quote_send($1, $2) as r", [o, id])).r.number);
  const status = (id: string) => asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [id])).s);
  const usage = (u: U, o: string) =>
    asUser(u.id, async (q) => (await one<{ u: Usage }>(q, "select public.org_plan_usage($1) as u", [o])).u.usage.find((row) => row.key === "max_quotes_per_month"));
  const feature = (o: string, key: string) =>
    asAdmin(async (q) => (await one<{ f: boolean }>(q, "select app.org_has_feature($1, $2) as f", [o, key])).f);
  // the month turns: this business's counter row moves to last month (as if the calendar moved on)
  const nextMonth = (o: string) =>
    asAdmin((q) => q("update app.quote_months set month = (month - interval '1 month')::date where organization_id = $1", [o]));

  let contact: string;
  let proContact: string;

  beforeAll(async () => {
    owner = await createUser("fq-owner");
    org = await createOrg(owner.id, "עסק בחבילה החינמית");
    await asAdmin((q) => q("update public.subscriptions set plan_key = 'free', status = 'active' where organization_id = $1", [org]));
    contact = await setUp(owner, org);
    proOwner = await createUser("fq-pro");
    proOrg = await createOrg(proOwner.id, "עסק בניסיון");
    proContact = await setUp(proOwner, proOrg);
  });

  it("the plans hold the keys: free 3 quotes and read only, the sold plans no cap and the actions", async () => {
    const plans = await asAdmin(async (q) =>
      (
        await q<{ key: string; cap: unknown; quotes: unknown; actions: unknown; money: unknown }>(
          `select key, limits -> 'max_quotes_per_month' as cap, features -> 'quotes' as quotes,
                  features -> 'money_waiting_actions' as actions, features -> 'money_waiting' as money
             from public.plans order by key`,
        )
      ).rows,
    );
    const by = Object.fromEntries(plans.map((p) => [p.key, p]));
    expect(by.free).toMatchObject({ cap: 3, quotes: true, actions: false, money: true });
    expect(await asAdmin(async (q) => (await one<{ p: unknown }>(q, "select limits -> 'max_pdf_per_month' as p from public.plans where key = 'free'", [])).p)).toBe(0);
    for (const key of ["personal", "basic", "pro", "business"]) {
      expect(by[key], key).toMatchObject({ cap: null, actions: true });
    }
    const fallback = await asAdmin(async (q) => (await one<{ d: { features: Record<string, unknown>; limits: Record<string, unknown> } }>(q, "select app.plan_key_defaults() as d", [])).d);
    expect(fallback.features.money_waiting_actions).toBe(false);
    expect(fallback.limits.max_quotes_per_month).toBe(0);
  });

  it("three quotes a month are sent; the fourth is refused and counts nothing; the next month sends again", async () => {
    expect(await usage(owner, org)).toEqual({ key: "max_quotes_per_month", limit: 3, used: 0 });
    const numbers: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      numbers.push(Number(await send(owner, org, await newQuote(owner, org, contact))));
    }
    expect(numbers[1]).toBe(numbers[0] + 1);
    expect(numbers[2]).toBe(numbers[0] + 2);
    expect(await usage(owner, org)).toEqual({ key: "max_quotes_per_month", limit: 3, used: 3 });

    const fourth = await newQuote(owner, org, contact);
    const err = await pgError(send(owner, org, fourth));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:max_quotes_per_month");
    expect(await status(fourth)).toBe("draft");
    expect(await usage(owner, org)).toEqual({ key: "max_quotes_per_month", limit: 3, used: 3 });

    // a draft is never counted: a version of a sent quote and a duplicate are made at the cap
    const sentOne = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.quotes where organization_id = $1 and status = 'sent' order by number limit 1", [org])).id);
    const version = await asUser(owner.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, sentOne])).v);
    const copy = await asUser(owner.id, async (q) => (await one<{ c: { quote: string } }>(q, "select public.quote_duplicate($1, $2) as c", [org, sentOne])).c.quote);
    expect(await status(version)).toBe("draft");
    expect(await status(copy)).toBe("draft");
    expect((await usage(owner, org))?.used).toBe(3);
    // (336) ב: a version of a sent quote is sent at the cap and counts nothing
    await send(owner, org, version);
    expect(await status(version)).toBe("sent");
    expect((await usage(owner, org))?.used).toBe(3);
    // a duplicate starts a new chain: refused at the cap
    expect((await pgError(send(owner, org, copy))).hint).toBe("limit:max_quotes_per_month");

    await nextMonth(org);
    expect((await usage(owner, org))?.used).toBe(0);
    // the refused send left no gap in the running numbers (the version took the next one)
    expect(Number(await send(owner, org, fourth))).toBe(numbers[2] + 2);
    await send(owner, org, copy);
    // an addendum of an accepted quote is a new quote: counted
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [fourth]));
    const addendum = await asUser(owner.id, async (q) => (await one<{ a: string }>(q, "select public.quote_new_addendum($1, $2) as a", [org, fourth])).a);
    await asUser(owner.id, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'תוספת', 5000)", [org, addendum]));
    await send(owner, org, addendum);
    expect((await usage(owner, org))?.used).toBe(3);
    expect((await pgError(send(owner, org, await newQuote(owner, org, contact)))).hint).toBe("limit:max_quotes_per_month");
  });

  it("(335) ב: each sent quote gets its PDF outside the PDF quota; a report PDF stays refused", async () => {
    const pdfOrg = await createOrg(owner.id, "עסק חינמי עם PDF");
    await asAdmin((q) => q("update public.subscriptions set plan_key = 'free', status = 'active' where organization_id = $1", [pdfOrg]));
    const c = await setUp(owner, pdfOrg);
    const produced = () =>
      asAdmin(async (q) => (await q<{ p: number }>("select produced as p from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [pdfOrg])).rows[0]?.p ?? 0);
    expect(await asAdmin(async (q) => (await one<{ l: string | null }>(q, "select app.org_limit($1, 'max_pdf_per_month')::text as l", [pdfOrg])).l)).toBe("0");
    const storeCall = (id: string) =>
      asService(async (q) =>
        (await one<{ r: { status: string } }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעת מחיר.pdf') as r", [pdfOrg, id, owner.id, "a".repeat(64)])).r,
      );
    const fileOf = (id: string) =>
      asAdmin((q) => one<{ id: string; storage_path: string; unconfirmed_since: Date | null }>(q, "select id, storage_path, unconfirmed_since from public.files where quote_id = $1", [id]));
    const quotes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await newQuote(owner, pdfOrg, c);
      await send(owner, pdfOrg, id);
      quotes.push(id);
      expect((await storeCall(id)).status).toBe("upload");
      const file = await fileOf(id);
      await asAdmin(async (q) => {
        await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [file.storage_path]);
        await q("update storage.objects set metadata = jsonb_build_object('size', 20000::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [file.storage_path]);
      });
      expect((await storeCall(id)).status).toBe("stored");
      expect((await fileOf(id)).unconfirmed_since).toBeNull();
    }
    expect(await produced()).toBe(0);
    // a report PDF is still refused by the quota of 0
    const report = await pgError(asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'sources', 3, 'pdf')", [pdfOrg])));
    expect(report.hint).toBe("limit:max_pdf_per_month");
    expect(await asUser(owner.id, async (q) => (await one<{ r: string | null }>(q, "select public.pdf_quota_check($1) as r", [pdfOrg])).r)).toBe("limit:max_pdf_per_month");
  });

  it("(337) א: a paid plan does not count a quote's PDF either, and removing a waiting row gives nothing back", async () => {
    const id = await newQuote(proOwner, proOrg, proContact);
    await send(proOwner, proOrg, id);
    const produced = () =>
      asAdmin(async (q) => (await q<{ p: number }>("select produced as p from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [proOrg])).rows[0]?.p ?? 0);
    // a report PDF is counted (one production)
    await asUser(proOwner.id, (q) => q("select public.log_export($1, 'report', 'sources', 3, 'pdf')", [proOrg]));
    const before = await produced();
    expect(before).toBeGreaterThanOrEqual(1);
    // even with the PDF quota used up, the quote's PDF is made
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = jsonb_build_object('max_pdf_per_month', $2::numeric) where organization_id = $1", [proOrg, before]));
    try {
      const answer = await asService(async (q) =>
        (await one<{ r: { status: string } }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעת מחיר.pdf') as r", [proOrg, id, proOwner.id, "b".repeat(64)])).r,
      );
      expect(answer.status).toBe("upload");
      expect(await produced()).toBe(before);
      await asUser(proOwner.id, (q) => q("delete from public.files where quote_id = $1 and unconfirmed_since is not null", [id]));
      expect(await produced()).toBe(before);
      // a report PDF is refused at the full quota
      expect((await pgError(asUser(proOwner.id, (q) => q("select public.log_export($1, 'report', 'sources', 3, 'pdf')", [proOrg])))).hint).toBe("limit:max_pdf_per_month");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [proOrg]));
    }
  });

  it("an override lifts the cap for one business", async () => {
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"max_quotes_per_month\": null}' where organization_id = $1", [org]));
    try {
      expect(await usage(owner, org)).toBeUndefined();
      await send(owner, org, await newQuote(owner, org, contact));
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
    }
  });

  it("other plans are not capped: more than three quotes a month, and no usage row", async () => {
    for (let i = 0; i < 5; i += 1) {
      await send(proOwner, proOrg, await newQuote(proOwner, proOrg, proContact));
    }
    expect(await usage(proOwner, proOrg)).toBeUndefined();
  });

  it("a plan that does not hold the key sends no quote (the restrictive fallback)", async () => {
    await asAdmin((q) => q("update public.plans set limits = limits - 'max_quotes_per_month' where key = 'pro'"));
    try {
      expect((await pgError(send(proOwner, proOrg, await newQuote(proOwner, proOrg, proContact)))).hint).toBe("limit:max_quotes_per_month");
    } finally {
      await asAdmin((q) => q("update public.plans set limits = limits || '{\"max_quotes_per_month\": null}' where key = 'pro'"));
    }
  });

  it("money waiting: the free plan reads the report without the row actions; other plans keep them", async () => {
    expect(await feature(org, "money_waiting")).toBe(true);
    expect(await feature(org, "money_waiting_actions")).toBe(false);
    expect(await feature(proOrg, "money_waiting_actions")).toBe(true);
    const report = await asUser(owner.id, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.report_money_waiting($1) as r", [org])).r);
    expect(report).toHaveProperty("leads");
    // the record actions themselves stay: the free plan's owner still adds a task on a record
    const task = await asUser(owner.id, async (q) =>
      (await q("insert into public.tasks (organization_id, title, contact_id) values ($1, 'לחזור ללקוח', $2) returning id", [org, contact])).rowCount,
    );
    expect(task).toBe(1);
  });

  it("the quota's helpers are not callable by any API role", async () => {
    for (const fn of ["app.quotes_month_take(uuid)", "app.quotes_sent_this_month(uuid)", "app.quotes_month_quota()"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const ok = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok);
        expect(ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
