import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// DOC-05 / DOC-17 (owner (270) (1) א: behind a fake provider): the business's connection to its invoice provider and its
// defaults (public.invoice_provider_settings), and who issues (app.can_issue_documents and the PRM-01 key issue_documents).

const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

describe("invoice provider connection (DOC-05, DOC-17)", () => {
  let owner: U, admin: U, manager: U, member: U, issuer: U, viewer: U, outsider: U;
  let org: string, otherOrg: string, bareOrg: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const connect = (u: U, orgId = org, provider = "fake") =>
    run(u, (q) => q("select public.invoice_provider_connect($1, $2)", [orgId, provider]));

  beforeAll(async () => {
    owner = await createUser("inv-owner");
    org = await createOrg(owner.id, "עסק החשבוניות");
    admin = await addMember(org, owner.id, "admin", "inv-admin");
    manager = await addMember(org, owner.id, "manager", "inv-manager");
    member = await addMember(org, owner.id, "member", "inv-member");
    issuer = await addMember(org, owner.id, "member", "inv-issuer");
    viewer = await addMember(org, owner.id, "viewer", "inv-viewer");
    outsider = await createUser("inv-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    bareOrg = await createOrg(owner.id, "עסק בלי מסמכים");
    await asAdmin((q) =>
      q(
        "update public.subscriptions set feature_overrides = '{\"documents\": true, \"granular_permissions\": true, \"quotes\": true}' where organization_id = any($1::uuid[])",
        [[org, otherOrg]],
      ),
    );
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"documents\": false}' where organization_id = $1", [bareOrg]));
    await run(owner, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    await run(outsider, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [otherOrg]));
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, issuer.id, ["issue_documents"]]));
  });

  describe("the connection and its defaults (DOC-05)", () => {
    it("a business that was never connected has no row", async () => {
      expect(await asAdmin((q) => count(q, "select 1 from public.invoice_provider_settings where organization_id = $1", [org]))).toBe(0);
    });

    it("only owners and admins of a writable business with the documents key connect", async () => {
      for (const u of [manager, member, viewer, outsider]) {
        expect((await pgError(connect(u))).code, u.email).toBe("42501");
      }
      expect((await pgError(connect(owner, bareOrg))).hint).toBe("feature:documents");
      expect((await pgError(connect(admin, org, "Bad Name"))).code).toBe("22023");
      await connect(admin);
      const row = await asAdmin((q) => one<{ provider: string; status: string; connected_by: string; last_check_ok: boolean }>(q, "select provider, status, connected_by, last_check_ok from public.invoice_provider_settings where organization_id = $1", [org]));
      expect(row).toEqual({ provider: "fake", status: "connected", connected_by: admin.id, last_check_ok: true });
    });

    it("members read the row; the provider and the status are the server's; owners and admins set the defaults", async () => {
      for (const u of [member, viewer]) {
        expect(await run(u, (q) => count(q, "select 1 from public.invoice_provider_settings where organization_id = $1", [org])), u.email).toBe(1);
      }
      expect(await run(outsider, (q) => count(q, "select 1 from public.invoice_provider_settings where organization_id = $1", [org]))).toBe(0);
      for (const column of ["provider = 'other'", "status = 'disconnected'", "last_check_ok = false", "connected_at = now()"]) {
        expect((await pgError(run(owner, (q) => q(`update public.invoice_provider_settings set ${column} where organization_id = $1`, [org])))).code, column).toBe("42501");
      }
      expect((await run(member, (q) => q("update public.invoice_provider_settings set locale = 'en' where organization_id = $1", [org]))).rowCount).toBe(0);
      expect((await run(admin, (q) => q("update public.invoice_provider_settings set locale = 'en', provider_sends_email = true where organization_id = $1", [org]))).rowCount).toBe(1);
      expect((await pgError(run(admin, (q) => q("update public.invoice_provider_settings set default_doc_type = 'credit_invoice' where organization_id = $1", [org])))).code).toBe("23514");
      expect((await pgError(run(owner, (q) => q("delete from public.invoice_provider_settings where organization_id = $1", [org])))).code).toBe("42501");
    });

    it("a check result and a disconnect are recorded only by owners and admins", async () => {
      expect((await pgError(run(member, (q) => q("select public.invoice_provider_check_recorded($1, false)", [org])))).code).toBe("42501");
      await run(owner, (q) => q("select public.invoice_provider_check_recorded($1, false)", [org]));
      expect(await asAdmin((q) => count(q, "select 1 from public.invoice_provider_settings where organization_id = $1 and last_check_ok = false", [org]))).toBe(1);
      expect((await pgError(run(member, (q) => q("select public.invoice_provider_disconnect($1)", [org])))).code).toBe("42501");
      await run(owner, (q) => q("select public.invoice_provider_disconnect($1)", [org]));
      expect(await asAdmin((q) => count(q, "select 1 from public.invoice_provider_settings where organization_id = $1 and status = 'disconnected' and provider = 'fake'", [org]))).toBe(1);
      await connect(owner);
    });

    it("a closed list: an unknown provider, or the fake while app.settings invoice_provider_fake is not 'on', is refused", async () => {
      expect((await pgError(connect(owner, org, "real_provider"))).hint).toBe("invoice:provider");
      await asAdmin((q) => q("update app.settings set value = '' where key = 'invoice_provider_fake'"));
      try {
        expect((await pgError(connect(owner))).hint).toBe("invoice:provider");
        expect((await pgError(run(owner, (q) => q("select public.invoice_provider_check_recorded($1, true)", [org])))).hint).toBe("invoice:provider");
      } finally {
        await asAdmin((q) => q("update app.settings set value = 'on' where key = 'invoice_provider_fake'"));
      }
      await connect(owner);
    });

    it("a person cannot record a check result for a provider other than the fake", async () => {
      await asAdmin((q) => q("update public.invoice_provider_settings set provider = 'real_provider' where organization_id = $1", [org]));
      try {
        expect((await pgError(run(owner, (q) => q("select public.invoice_provider_check_recorded($1, true)", [org])))).hint).toBe("invoice:provider");
      } finally {
        await asAdmin((q) => q("update public.invoice_provider_settings set provider = 'fake' where organization_id = $1", [org]));
      }
      await run(owner, (q) => q("select public.invoice_provider_check_recorded($1, false)", [org]));
      expect(await asAdmin((q) => count(q, "select 1 from public.invoice_provider_settings where organization_id = $1 and last_check_ok = false", [org]))).toBe(1);
    });

    it("the connect and disconnect are in the audit log", async () => {
      expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'invoice_provider_settings'", [org]))).toBeGreaterThanOrEqual(3);
    });
  });

  describe("who issues (DOC-17)", () => {
    it("owners, admins and holders of issue_documents; not managers, members or viewers without it", async () => {
      const can = (u: U) => run(u, async (q) => (await one<{ c: boolean }>(q, "select app.can_issue_documents($1) as c", [org])).c);
      expect(await can(owner)).toBe(true);
      expect(await can(admin)).toBe(true);
      expect(await can(issuer)).toBe(true);
      expect(await can(manager)).toBe(false);
      expect(await can(member)).toBe(false);
      expect(await can(viewer)).toBe(false);
    });
  });

});
