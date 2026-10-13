import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const chargesOf = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ v: boolean | null }>("select app.org_charges_vat($1) as v", [org])).rows[0].v);

/** TAX-01: the business's VAT status, apart from its legal form (public.org_document_settings). */
describe("VAT status of the business", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("tax-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "tax-member");
  });

  it("starts unset: no row, and whether VAT is charged is unknown (null), never a guess", async () => {
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.org_document_settings where organization_id = $1", [org]))).toBe(0);
    expect(await chargesOf(owner.id, org)).toBeNull();
    const row = await asUser(owner.id, async (q) =>
      (
        await q<{ vat_status: string | null; legal_form: string | null; updated_by: string }>(
          "insert into public.org_document_settings (organization_id) values ($1) returning vat_status, legal_form, updated_by",
          [org],
        )
      ).rows[0],
    );
    expect(row).toEqual({ vat_status: null, legal_form: null, updated_by: owner.id });
    expect(await chargesOf(owner.id, org)).toBeNull();
  });

  it("one row per organization", async () => {
    const again = await pgError(asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id) values ($1)", [org])));
    expect(again.code).toBe("23505");
  });

  it("the status alone decides: licensed charges VAT, exempt and nonprofit never do, whatever the legal form", async () => {
    const cases: [string, string | null, boolean][] = [
      ["licensed", "individual", true],
      ["licensed", "company", true],
      ["exempt", "individual", false],
      // a company marked exempt still shows no VAT: the legal form never decides
      ["exempt", "company", false],
      ["nonprofit", "nonprofit", false],
      ["nonprofit", null, false],
    ];
    for (const [status, form, expected] of cases) {
      await asUser(owner.id, (q) =>
        q("update public.org_document_settings set vat_status = $2, legal_form = $3 where organization_id = $1", [org, status, form]),
      );
      expect(await chargesOf(owner.id, org), `${status}/${String(form)}`).toBe(expected);
      // every member gets the same answer, so a quote made by anyone follows the rule
      expect(await chargesOf(member.id, org), `${status}/${String(form)} for a member`).toBe(expected);
    }
  });

  it("an 'other' status needs its name and whether it charges VAT; other statuses may not carry them", async () => {
    const set = (sql: string, params: unknown[] = []) => asUser(owner.id, (q) => q(`update public.org_document_settings set ${sql} where organization_id = $1`, [org, ...params]));
    for (const bad of [
      "vat_status = 'other'",
      "vat_status = 'other', vat_status_other = 'מעמד מיוחד'",
      "vat_status = 'other', other_charges_vat = true",
      "vat_status = 'other', vat_status_other = '  ', other_charges_vat = true",
      `vat_status = 'other', vat_status_other = '${"א".repeat(81)}', other_charges_vat = true`,
      "vat_status = 'exempt', vat_status_other = 'x', other_charges_vat = null",
      "vat_status = 'licensed', vat_status_other = null, other_charges_vat = false",
      "vat_status = null, other_charges_vat = false",
      "vat_status = 'zero'",
      "legal_form = 'llc'",
    ]) {
      expect((await pgError(set(bad))).code, bad).toBe("23514");
    }
    await set("vat_status = 'other', vat_status_other = 'מעמד מיוחד', other_charges_vat = false");
    expect(await chargesOf(owner.id, org)).toBe(false);
    await set("other_charges_vat = true");
    expect(await chargesOf(owner.id, org)).toBe(true);
    await set("vat_status = 'exempt', vat_status_other = null, other_charges_vat = null");
    expect(await chargesOf(owner.id, org)).toBe(false);
  });

  it("app.vat_status_charges() covers every status, and an unknown one is null", async () => {
    const rows = await asUser(member.id, async (q) =>
      (
        await q<{ s: string | null; o: boolean | null; v: boolean | null }>(
          `select s, o, app.vat_status_charges(s, o) as v
             from unnest(array['licensed', 'exempt', 'nonprofit', 'other', 'other', 'other', 'unknown', null]) with ordinality a(s, i)
             join unnest(array[false, true, true, true, false, null, true, true]::boolean[]) with ordinality b(o, j) on i = j
            order by i`,
        )
      ).rows.map((r) => r.v),
    );
    expect(rows).toEqual([true, false, false, true, false, null, null, null]);
  });

  it("every change is in the audit log", async () => {
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'org_document_settings' and action = 'insert'", [org])),
    ).toBe(1);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'org_document_settings' and action = 'update'", [org])),
    ).toBeGreaterThan(5);
  });

  it("a row cannot move to another organization, and members cannot change it", async () => {
    const err = await pgError(
      asUser(owner.id, (q) => q("update public.org_document_settings set organization_id = organization_id where organization_id = $1", [org])),
    );
    expect(err.code).toBe("42501");
    await asUser(member.id, async (q) => {
      expect((await q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org])).rowCount).toBe(0);
    });
  });

  it("someone outside the organization learns nothing and cannot create the row", async () => {
    const stranger = await createUser("tax-stranger");
    await createOrg(stranger.id);
    expect(await chargesOf(stranger.id, org)).toBeNull();
    const fresh = await createOrg(owner.id, "עסק בלי מעמד");
    const err = await pgError(asUser(stranger.id, (q) => q("insert into public.org_document_settings (organization_id) values ($1)", [fresh])));
    expect(err.code).toBe("42501");
  });

  it("a read-only organization keeps its status but cannot change it", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.org_document_settings where organization_id = $1", [org])).toBe(1);
      expect((await q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org])).rowCount).toBe(0);
      expect((await q("delete from public.org_document_settings where organization_id = $1", [org])).rowCount).toBe(0);
    });
    expect(await chargesOf(owner.id, org)).toBe(false);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
  });

  it("the helpers are not open to anonymous callers; the server may use them", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ fn: string; anon: boolean; authn: boolean; service: boolean }>(
          `select p.proname as fn,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as authn,
                  has_function_privilege('service_role', p.oid, 'execute') as service
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname in ('vat_status_charges', 'org_charges_vat')
            order by 1`,
        )
      ).rows,
    );
    expect(grants).toEqual([
      { fn: "org_charges_vat", anon: false, authn: true, service: true },
      { fn: "vat_status_charges", anon: false, authn: true, service: true },
    ]);
    // a server-side caller (later: document functions) reads the status of any organization
    expect(await asService(async (q) => (await q<{ v: boolean | null }>("select app.org_charges_vat($1) as v", [org])).rows[0].v)).toBe(false);
  });
});
