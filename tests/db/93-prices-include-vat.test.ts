import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const modeOf = (userId: string, org: string) =>
  asUser(userId, async (q) =>
    (await q<{ v: boolean }>("select prices_include_vat as v from public.org_document_settings where organization_id = $1", [org])).rows[0]?.v,
  );

/** TAX-04: prices typed and shown before VAT (default) or including VAT. */
describe("prices including VAT", () => {
  let owner: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let viewer: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("prices-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "prices-admin");
    member = await addMember(org, owner.id, "member", "prices-member");
    viewer = await addMember(org, owner.id, "viewer", "prices-viewer");
  });

  it("starts before VAT, also on a row made before the setting existed", async () => {
    await asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    expect(await modeOf(owner.id, org)).toBe(false);
    // members and viewers read it (they make and read quotes)
    expect(await modeOf(member.id, org)).toBe(false);
    expect(await modeOf(viewer.id, org)).toBe(false);
  });

  it("owners and admins change it; members and viewers cannot", async () => {
    const set = (userId: string, value: boolean) =>
      asUser(userId, async (q) =>
        (await q("update public.org_document_settings set prices_include_vat = $2 where organization_id = $1 returning id", [org, value])).rowCount,
      );
    expect(await set(admin.id, true)).toBe(1);
    expect(await modeOf(member.id, org)).toBe(true);
    expect(await set(member.id, false)).toBe(0);
    expect(await set(viewer.id, false)).toBe(0);
    expect(await modeOf(owner.id, org)).toBe(true);
    expect(await set(owner.id, false)).toBe(1);
    // never null
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = null where organization_id = $1", [org])))).code).toBe("23502");
  });

  it("can be given on the first save, and the change is audited", async () => {
    const other = await createUser("prices-owner2");
    const org2 = await createOrg(other.id);
    await asUser(other.id, (q) => q("insert into public.org_document_settings (organization_id, prices_include_vat) values ($1, true)", [org2]));
    expect(await modeOf(other.id, org2)).toBe(true);
    await asUser(other.id, (q) => q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org2]));
    const audited = await asAdmin(async (q) =>
      (
        await q<{ n: number }>(
          "select count(*)::int as n from public.audit_log where organization_id = $1 and entity_type = 'org_document_settings' and action = 'update' and changes ? 'prices_include_vat'",
          [org2],
        )
      ).rows[0].n,
    );
    expect(audited).toBeGreaterThanOrEqual(1);
  });

  it("a read-only organization keeps its setting and cannot change it", async () => {
    const other = await createUser("prices-owner3");
    const org3 = await createOrg(other.id);
    await asUser(other.id, (q) => q("insert into public.org_document_settings (organization_id) values ($1)", [org3]));
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org3]));
    const changed = await asUser(other.id, async (q) =>
      (await q("update public.org_document_settings set prices_include_vat = true where organization_id = $1 returning id", [org3])).rowCount,
    );
    expect(changed).toBe(0);
    expect(await modeOf(other.id, org3)).toBe(false);
  });
});
