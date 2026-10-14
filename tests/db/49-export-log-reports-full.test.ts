import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("report and full exports are written to the audit log (IMP-02)", () => {
  let owner: { id: string }, admin: { id: string }, manager: { id: string }, rep: { id: string }, viewer: { id: string }, stranger: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("xlog-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "xlog-admin");
    manager = await addMember(org, owner.id, "manager", "xlog-manager");
    rep = await addMember(org, owner.id, "member", "xlog-rep");
    viewer = await addMember(org, owner.id, "viewer", "xlog-viewer");
    stranger = await createUser("xlog-stranger");
    await createOrg(stranger.id, "עסק אחר");
  });

  const log = (userId: string, kind: string, report: string | null, rows: number | null) =>
    asUser(userId, (q) => q("select public.log_export($1, $2, $3, $4)", [org, kind, report, rows]));
  const entries = () =>
    asAdmin(
      async (q) =>
        (await q<{ actor_id: string; entity_type: string; changes: Record<string, unknown> }>(
          "select actor_id, entity_type, changes from public.audit_log where organization_id = $1 and action = 'export' order by id",
          [org],
        )).rows,
    );

  it("a report export (owner, admin, team manager) and the full export (owner) are one entry each", async () => {
    await log(manager.id, "report", "sources", 14);
    await log(owner.id, "full", null, 230);
    expect(await entries()).toEqual([
      { actor_id: manager.id, entity_type: "reports", changes: { kind: "report", report: "sources", rows: 14, format: "csv" } },
      { actor_id: owner.id, entity_type: "full_export", changes: { kind: "full", rows: 230, format: "zip" } },
    ]);
  });

  it("refuses who may not export, and anything else", async () => {
    expect((await pgError(log(admin.id, "full", null, 1))).code).toBe("42501");
    expect((await pgError(log(rep.id, "report", "sources", 1))).code).toBe("42501");
    expect((await pgError(log(stranger.id, "report", "sources", 1))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.log_export($1, 'report', 'sources', 1)", [org])))).code).toBe("42501");
    expect((await pgError(log(owner.id, "list", null, 1))).code).toBe("22023");
    expect((await pgError(log(owner.id, "report", "Sources; drop", 1))).code).toBe("22023");
    expect((await pgError(log(owner.id, "report", "sources", -1))).code).toBe("22023");
    expect((await pgError(log(manager.id, "full", null, 1))).code).toBe("42501");
    expect((await pgError(log(viewer.id, "report", "sources", 1))).code).toBe("42501");
    expect((await pgError(log(owner.id, "report", null, 1))).code).toBe("22023");
    expect((await pgError(log(owner.id, "report", "made_up_report", 1))).code).toBe("22023");
    expect((await pgError(log(owner.id, "report", "sources", null))).code).toBe("22023");
    expect((await pgError(log(owner.id, "report", "sources", 10000001))).code).toBe("22023");
    expect(await entries()).toHaveLength(2);
    // nothing was written into any other organization either
    const elsewhere = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from public.audit_log where action = 'export' and organization_id <> $1 and actor_id = any($2)", [org, [owner.id, admin.id, manager.id, rep.id, viewer.id, stranger.id]])).rows[0].n,
    );
    expect(elsewhere).toBe(0);
  });

  it("a report export records its format (RPT-02); the four-argument call still records csv", async () => {
    const before = (await entries()).length;
    await asUser(admin.id, (q) => q("select public.log_export($1, 'report', 'funnel', 5, 'xlsx')", [org]));
    await asUser(admin.id, (q) => q("select public.log_export($1, 'report', 'funnel', 6, 'csv')", [org]));
    await log(admin.id, "report", "funnel", 7);
    await asUser(owner.id, (q) => q("select public.log_export($1, 'full', null, 8, 'csv')", [org]));
    expect((await entries()).slice(before)).toEqual([
      { actor_id: admin.id, entity_type: "reports", changes: { kind: "report", report: "funnel", rows: 5, format: "xlsx" } },
      { actor_id: admin.id, entity_type: "reports", changes: { kind: "report", report: "funnel", rows: 6, format: "csv" } },
      { actor_id: admin.id, entity_type: "reports", changes: { kind: "report", report: "funnel", rows: 7, format: "csv" } },
      { actor_id: owner.id, entity_type: "full_export", changes: { kind: "full", rows: 8, format: "zip" } },
    ]);
  });

  it("refuses an unknown format, and the rights checks still come first", async () => {
    const before = (await entries()).length;
    for (const format of ["pdf", "XLSX", "", null]) {
      expect((await pgError(asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'sources', 1, $2)", [org, format])))).code, String(format)).toBe("22023");
    }
    expect((await pgError(asUser(rep.id, (q) => q("select public.log_export($1, 'report', 'sources', 1, 'xlsx')", [org])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.log_export($1, 'report', 'sources', 1, 'xlsx')", [org])))).code).toBe("42501");
    expect(await entries()).toHaveLength(before);
  });

  it("is one function, granted as before; the 0050 one is out of the API", async () => {
    const rows = await asAdmin(
      async (q) =>
        (await q<{ sig: string; anon: boolean; auth: boolean }>(
          `select p.oid::regprocedure::text as sig,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.proname like 'log_export%' order by 1`,
        )).rows,
    );
    expect(rows).toEqual([
      { sig: "app.log_export_0050_retired(uuid,text,text,integer)", anon: false, auth: false },
      { sig: "log_export(uuid,text,text,integer,text)", anon: false, auth: true },
    ]);
  });
});
