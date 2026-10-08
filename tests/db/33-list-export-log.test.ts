import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("exporting a list is written to the audit log (LST-08)", () => {
  let owner: { id: string }, manager: { id: string }, rep: { id: string }, viewer: { id: string }, stranger: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("export-owner");
    org = await createOrg(owner.id);
    manager = await addMember(org, owner.id, "manager", "export-manager");
    rep = await addMember(org, owner.id, "member", "export-rep");
    viewer = await addMember(org, owner.id, "viewer", "export-viewer");
    stranger = await createUser("export-stranger");
    await createOrg(stranger.id, "עסק אחר");
  });

  const log = (userId: string, object = "lead", format = "csv", rows = 12, scope = "filtered", filters: unknown = { q: "משה" }) =>
    asUser(userId, (q) => q("select public.log_list_export($1, $2, $3, $4, $5, $6)", [org, object, format, rows, scope, JSON.stringify(filters)]));
  const entries = () =>
    asAdmin(
      async (q) =>
        (await q<{ actor_id: string; entity_type: string; changes: Record<string, unknown> }>("select actor_id, entity_type, changes from public.audit_log where organization_id = $1 and action = 'export' order by id", [org])).rows,
    );

  it("owners, admins and team managers export; each export is one audit entry", async () => {
    await log(owner.id);
    await log(manager.id, "contact", "xlsx", 3, "selected", { ids: 3 });
    expect(await entries()).toEqual([
      { actor_id: owner.id, entity_type: "leads", changes: { format: "csv", rows: 12, scope: "filtered", filters: { q: "משה" } } },
      { actor_id: manager.id, entity_type: "contacts", changes: { format: "xlsx", rows: 3, scope: "selected", filters: { ids: 3 } } },
    ]);
  });

  it("members, viewers, other organizations and signed-out callers may not", async () => {
    for (const userId of [rep.id, viewer.id, stranger.id]) {
      expect((await pgError(log(userId))).code).toBe("42501");
    }
    expect((await pgError(asAnon((q) => q("select public.log_list_export($1, 'lead', 'csv', 1, 'filtered', '{}')", [org])))).code).toBe("42501");
    expect(await entries()).toHaveLength(2);
  });

  it("refuses unknown lists, formats and scopes; keeps no filters that are not an object", async () => {
    expect((await pgError(log(owner.id, "note"))).code).toBe("22023");
    expect((await pgError(log(owner.id, "lead", "pdf"))).code).toBe("22023");
    expect((await pgError(log(owner.id, "lead", "csv", -1))).code).toBe("22023");
    expect((await pgError(log(owner.id, "lead", "csv", 1, "everything"))).code).toBe("22023");
    await log(owner.id, "company", "csv", 0, "filtered", ["not", "an", "object"]);
    expect((await entries()).at(-1)?.changes).toEqual({ format: "csv", rows: 0, scope: "filtered" });
  });

  it("the audit log itself stays closed to clients", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.audit_log (organization_id, action, entity_type) values ($1, 'export', 'leads')", [org])))).code).toBe("42501");
  });
});
