import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Hold = {
  contact_id: string | null;
  company_id: string | null;
  reason: string;
  created_by: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
};

/**
 * COL-05: "לא למכור עד הסדרת חוב" on a contact or a company: set with a required reason by owners, admins and managers, or a
 * holder of the record_payments key; read by whoever reads the record; one active hold per record; lifted, never deleted;
 * audited; a merge carries it; a purge and an erasure take it and its entries.
 */
describe("customer holds (COL-05)", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const hold = (id: string) =>
    asAdmin((q) => one<Hold>(q, "select contact_id, company_id, reason, created_by, cleared_at, cleared_by from public.customer_holds where id = $1", [id]));
  const newContact = (u: U, name: string, orgId = org, company: string | null = null) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, $2, $3, $4) returning id", [
            orgId,
            name,
            u.id,
            company,
          ])
        ).id,
    );
  const newCompany = (u: U, name: string) =>
    run(
      u,
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])).id,
    );
  const setHold = (u: U, subject: { contact?: string; company?: string }, reason: string | null = "חוב פתוח מחודש מאי", orgId = org) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.customer_holds (organization_id, contact_id, company_id, reason) values ($1, $2, $3, $4) returning id",
            [orgId, subject.contact ?? null, subject.company ?? null, reason],
          )
        ).id,
    );
  const lift = (u: U, id: string) => run(u, async (q) => (await q("update public.customer_holds set cleared_at = now() where id = $1", [id])).rowCount);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));

  beforeAll(async () => {
    owner = await createUser("ch-owner");
    org = await createOrg(owner.id, "עסק הגבייה");
    admin = await addMember(org, owner.id, "admin", "ch-admin");
    manager = await addMember(org, owner.id, "manager", "ch-manager");
    member = await addMember(org, owner.id, "member", "ch-member");
    keyHolder = await addMember(org, owner.id, "member", "ch-key");
    viewer = await addMember(org, owner.id, "viewer", "ch-viewer");
    outsider = await createUser("ch-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setFeatures({ collection: true, granular_permissions: true });
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));
  });

  it("owners, admins, managers and the key's holder set a hold; a member, a viewer and an outsider cannot; the plan decides", async () => {
    for (const u of [owner, admin, manager, keyHolder]) {
      const contact = await newContact(owner, `לקוח ${u.email}`);
      const id = await setHold(u, { contact });
      expect(await hold(id), u.email).toMatchObject({ created_by: u.id, cleared_at: null, cleared_by: null });
    }
    const contact = await newContact(owner, "לקוח נוסף");
    for (const u of [member, viewer, outsider]) expect((await pgError(setHold(u, { contact }))).code, u.email).toBe("42501");
    await setFeatures({ collection: false, granular_permissions: true });
    try {
      expect((await pgError(setHold(owner, { contact }))).code).toBe("42501");
    } finally {
      await setFeatures({ collection: true, granular_permissions: true });
    }
  });

  it("a reason is required (1..500, trimmed); exactly one of contact or company; one active hold per record", async () => {
    const contact = await newContact(owner, "רון");
    for (const reason of [null, "", "   "]) expect((await pgError(setHold(owner, { contact }, reason))).code, String(reason)).toMatch(/^(23502|23514)$/);
    expect((await pgError(setHold(owner, { contact }, "x".repeat(501)))).code).toBe("23514");
    const company = await newCompany(owner, "חברה");
    expect((await pgError(setHold(owner, { contact, company }))).code).toBe("23514");
    // neither: refused (the constraint, or the read rule of the returned row)
    expect((await pgError(setHold(owner, {}))).code).toMatch(/^(23514|42501)$/);
    const id = await setHold(owner, { contact }, "  חוב  ");
    expect((await hold(id)).reason).toBe("חוב");
    expect((await pgError(setHold(admin, { contact }))).hint).toBe("customer_hold:exists");
    // after lifting, a new one may be set
    expect(await lift(admin, id)).toBe(1);
    await setHold(manager, { contact }, "שוב חוב");
    // a company is held on its own
    await setHold(owner, { company });
    expect((await pgError(setHold(owner, { company }))).hint).toBe("customer_hold:exists");
  });

  it("lifted by the same people, with the server's time and person; never deleted, never changed, never back", async () => {
    const contact = await newContact(owner, "שירה");
    const id = await setHold(keyHolder, { contact });
    expect(await lift(member, id)).toBe(0);
    expect(await lift(viewer, id)).toBe(0);
    for (const u of [owner, admin])
      expect((await pgError(run(u, (q) => q("delete from public.customer_holds where id = $1", [id])))).code, u.email).toBe("42501");
    // nothing but cleared_at may be sent; the server refuses its own change of the facts
    expect((await pgError(run(owner, (q) => q("update public.customer_holds set reason = 'אחר' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asAdmin((q) => q("update public.customer_holds set reason = 'אחר' where id = $1", [id])))).hint).toBe("customer_hold:frozen");
    expect(await lift(keyHolder, id)).toBe(1);
    const lifted = await hold(id);
    expect(lifted.cleared_by).toBe(keyHolder.id);
    expect(lifted.cleared_at).not.toBeNull();
    expect((await pgError(run(owner, (q) => q("update public.customer_holds set cleared_at = null where id = $1", [id])))).hint).toBe("customer_hold:lifted");
    // set and lift are in the audit log
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'customer_holds' and entity_id = $1", [id])),
    ).toBeGreaterThanOrEqual(2);
  });

  it("reading follows the record; nobody outside the business reads a hold", async () => {
    const contact = await newContact(member, "נעמה");
    const id = await setHold(owner, { contact });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await run(member, (q) => count(q, "select 1 from public.customer_holds where id = $1", [id]))).toBe(1);
      expect(await run(keyHolder, (q) => count(q, "select 1 from public.customer_holds where id = $1", [id]))).toBe(0);
      expect((await pgError(setHold(keyHolder, { contact: await newContact(member, "עוד אחד") }))).code).toBe("42501");
      expect(await lift(keyHolder, id)).toBe(0);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    expect(await run(outsider, (q) => count(q, "select 1 from public.customer_holds where organization_id = $1", [org]))).toBe(0);
    expect(
      await asAnon((q) => q("select 1 from public.customer_holds")).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      ),
    ).toBe("42501");
    // a contact in the bin takes no new hold; another business's contact cannot be held from here
    const binned = await newContact(owner, "בסל");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(setHold(owner, { contact: binned }))).code).toBe("42501");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"collection\": true}' where organization_id = $1", [otherOrg]));
    const theirs = await newContact(outsider, "שלהם", otherOrg);
    expect((await pgError(setHold(owner, { contact: theirs }))).code).toBe("42501");
  });

  it("a merge carries the duplicate's hold, or lifts it when the kept contact is held; a purge and an erasure take it", async () => {
    const keep = await newContact(owner, "יעל");
    const dup = await newContact(owner, "יעל כפולה");
    const id = await setHold(owner, { contact: dup }, "יעל חייבת 500");
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await hold(id)).toMatchObject({ contact_id: keep, cleared_at: null });

    const keep2 = await newContact(owner, "אבי");
    const dup2 = await newContact(owner, "אבי כפול");
    const kept = await setHold(owner, { contact: keep2 }, "אבי חייב");
    const moved = await setHold(owner, { contact: dup2 }, "כפול חייב");
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep2, dup2]));
    expect((await hold(kept)).cleared_at).toBeNull();
    expect(await hold(moved)).toMatchObject({ contact_id: keep2 });
    expect((await hold(moved)).cleared_at).not.toBeNull();

    // a company merge carries the company's hold
    const company = await newCompany(owner, "חברה שמורה");
    const company2 = await newCompany(owner, "חברה כפולה");
    const onCompany = await setHold(owner, { company: company2 });
    await run(owner, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}'::jsonb)", [org, company, company2]));
    expect((await hold(onCompany)).company_id).toBe(company);

    // purge and erasure: the hold goes with the record and its entries are erased
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [keep]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [keep])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.customer_holds where id = $1", [id]))).toBe(0);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, keep]));
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.audit_log where entity_type = 'customer_holds' and entity_id = $1 and changes::text like '%יעל%'", [id]),
      ),
    ).toBe(0);
  });
});
