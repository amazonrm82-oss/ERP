import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RPT-02 (owner, 1 November 2026, answer (4) א): a report may be exported as a PDF, made on our server for every export and
 * never stored. public.log_export takes p_format 'pdf' for a report only, and every such export takes one production of
 * max_pdf_per_month through app.pdf_take (QUO-06): the month's quota (limit:max_pdf_per_month), 30 a minute (rate:pdf), one
 * notice at 80%. A refused export leaves no audit entry and counts nothing; CSV and Excel never count.
 */
describe("report PDF export (RPT-02)", () => {
  let owner: U, manager: U, member: U, outsider: U;
  let org: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const produced = () =>
    asAdmin(async (q) => (await q<{ produced: number }>("select produced from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org])).rows[0]?.produced ?? 0);
  const setQuota = (n: number) =>
    asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || jsonb_build_object('max_pdf_per_month', $2::numeric) where organization_id = $1", [org, n]),
    );
  const resetCount = () => asAdmin((q) => q("update app.pdf_months set produced = 0, minute_count = 0, minute_start = null, warned_80_at = null where organization_id = $1", [org]));
  const exportAs = (u: U, report: string, format: string, kind = "report") =>
    asUser(u.id, (q) => q("select public.log_export($1, $2, $3, 3, $4)", [org, kind, kind === "report" ? report : null, format]));
  const pdfEntries = () =>
    asAdmin(
      async (q) =>
        (await one<{ n: number }>(q, "select count(*)::int as n from public.audit_log where organization_id = $1 and action = 'export' and changes ->> 'format' = 'pdf'", [org])).n,
    );

  beforeAll(async () => {
    owner = await createUser("rpdf-owner");
    outsider = await createUser("rpdf-outsider");
    org = await createOrg(owner.id, "דוחות PDF");
    manager = await addMember(org, owner.id, "manager", "rpdf-manager");
    member = await addMember(org, owner.id, "member", "rpdf-member");
    await createOrg(outsider.id, "עסק אחר");
    await setQuota(1000);
  });

  it("a PDF export is logged with its format and counts one production; CSV and Excel count nothing", async () => {
    await resetCount();
    await exportAs(owner, "sources", "csv");
    await exportAs(owner, "sources", "xlsx");
    expect(await produced()).toBe(0);
    await exportAs(owner, "sources", "pdf");
    await exportAs(manager, "funnel", "pdf");
    expect(await produced()).toBe(2);
    const entry = await asAdmin((q) =>
      one<{ changes: Record<string, unknown>; entity_type: string; actor_id: string }>(
        q,
        "select changes, entity_type, actor_id from public.audit_log where organization_id = $1 and action = 'export' and changes ->> 'format' = 'pdf' order by created_at desc, id desc limit 1",
        [org],
      ),
    );
    expect(entry.entity_type).toBe("reports");
    expect(entry.changes).toMatchObject({ kind: "report", format: "pdf", rows: 3 });
  });

  it("never for the full export, and never an unknown format", async () => {
    expect((await pgError(exportAs(owner, "", "pdf", "full"))).code).toBe("22023");
    expect((await pgError(exportAs(owner, "sources", "docx"))).code).toBe("22023");
  });

  it("someone who may not export is refused before anything is counted; an outsider learns nothing of the quota", async () => {
    await resetCount();
    await setQuota(0);
    try {
      for (const u of [member, outsider]) expect((await pgError(exportAs(u, "sources", "pdf"))).code, u.email).toBe("42501");
    } finally {
      await setQuota(1000);
    }
    expect(await produced()).toBe(0);
  });

  it("a full month's quota refuses the PDF (not CSV or Excel) and leaves no audit entry; one notice at 80%", async () => {
    await resetCount();
    await setQuota(5);
    try {
      const before = await pdfEntries();
      for (let i = 0; i < 5; i++) await exportAs(owner, "sources", "pdf");
      expect(await produced()).toBe(5);
      const full = await pgError(exportAs(owner, "sources", "pdf"));
      expect(full.hint).toBe("limit:max_pdf_per_month");
      expect(await produced()).toBe(5);
      expect(await pdfEntries()).toBe(before + 5);
      await exportAs(owner, "sources", "csv");
      await exportAs(owner, "sources", "xlsx");
      const notices = await asAdmin((q) =>
        one<{ n: number }>(q, "select count(*)::int as n from public.notifications where organization_id = $1 and type = 'system' and title like 'קובצי ה-PDF הגיעו ל-80%%'", [org]),
      );
      expect(notices.n).toBe(1);
    } finally {
      await setQuota(1000);
    }
  });

  it("30 a minute per business (rate:pdf), shared with the quote PDFs' counter", async () => {
    await resetCount();
    await asAdmin((q) => q("insert into app.pdf_months (organization_id, month) values ($1, app.automation_run_month($1)) on conflict do nothing", [org]));
    await asAdmin((q) => q("update app.pdf_months set minute_start = now(), minute_count = 30 where organization_id = $1 and month = app.automation_run_month($1)", [org]));
    expect((await pgError(exportAs(owner, "sources", "pdf"))).hint).toBe("rate:pdf");
    await asAdmin((q) => q("update app.pdf_months set minute_start = now() - interval '2 minutes' where organization_id = $1", [org]));
    await exportAs(owner, "sources", "pdf");
    expect(await produced()).toBe(1);
  });

  it("a rate:pdf refusal leaves no audit entry and counts nothing", async () => {
    await resetCount();
    await asAdmin((q) => q("insert into app.pdf_months (organization_id, month) values ($1, app.automation_run_month($1)) on conflict do nothing", [org]));
    await asAdmin((q) => q("update app.pdf_months set minute_start = now(), minute_count = 30 where organization_id = $1 and month = app.automation_run_month($1)", [org]));
    const before = await pdfEntries();
    expect((await pgError(exportAs(owner, "sources", "pdf"))).hint).toBe("rate:pdf");
    expect(await pdfEntries()).toBe(before);
    expect(await produced()).toBe(0);
    await resetCount();
  });

  it("the read-only pre-check answers the quota and the rate without counting; only for those who may export", async () => {
    const check = (u: U) => asUser(u.id, async (q) => (await one<{ c: string | null }>(q, "select public.pdf_quota_check($1) as c", [org])).c);
    await resetCount();
    expect(await check(owner)).toBeNull();
    expect(await check(manager)).toBeNull();
    for (const u of [member, outsider]) expect((await pgError(check(u))).code, u.email).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.pdf_quota_check($1)", [org])))).code).toBe("42501");
    await setQuota(1);
    try {
      await exportAs(owner, "sources", "pdf");
      expect(await check(owner)).toBe("limit:max_pdf_per_month");
      expect(await produced()).toBe(1);
    } finally {
      await setQuota(1000);
    }
    await resetCount();
    await asAdmin((q) => q("update app.pdf_months set minute_start = now(), minute_count = 30 where organization_id = $1 and month = app.automation_run_month($1)", [org]));
    expect(await check(owner)).toBe("rate:pdf");
    expect(await produced()).toBe(0);
    await resetCount();
  });

  it("the report's own refusals still come first (a report of a missing capability is refused, not counted)", async () => {
    await resetCount();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}'::jsonb where organization_id = $1", [org]));
    expect((await pgError(exportAs(owner, "quotes", "pdf"))).hint).toBe("feature:quotes");
    expect(await produced()).toBe(0);
  });
});
