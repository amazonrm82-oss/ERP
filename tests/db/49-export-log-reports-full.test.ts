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
});
