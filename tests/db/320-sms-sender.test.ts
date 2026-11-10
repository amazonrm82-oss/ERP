import { afterAll, beforeAll, describe, expect, it } from "vitest";

import cases from "../unit/fixtures/sms-sender-names.json";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

const ruleOf = (value: string) =>
  asAdmin(async (q) => (await q<{ ok: boolean }>("select app.sms_sender_name_ok($1) as ok", [value])).rows[0].ok);

const saveAs = (user: string, org: string, value: string | null) =>
  asUser(user, async (q) => {
    const updated = await q("update public.org_message_settings set sms_sender_name = $2 where organization_id = $1 returning id", [org, value]);
    if (updated.rowCount === 0) {
      await q("insert into public.org_message_settings (organization_id, sms_sender_name) values ($1, $2)", [org, value]);
    }
  });
const stored = (org: string) =>
  asAdmin(async (q) => (await q<{ v: string | null }>("select sms_sender_name as v from public.org_message_settings where organization_id = $1", [org])).rows[0]?.v ?? null);

/** SMS-01: the business's SMS sender name on org_message_settings, by the shared rule. */
describe("SMS sender name (SMS-01)", () => {
  let owner: { id: string }, member: { id: string }, viewer: { id: string }, ownerB: { id: string };
  let org: string, orgB: string;

  beforeAll(async () => {
    owner = await createUser("sms-sender-owner");
    org = await createOrg(owner.id, "עסק SMS");
    member = await addMember(org, owner.id, "member", "sms-sender-member");
    viewer = await addMember(org, owner.id, "viewer", "sms-sender-viewer");
    ownerB = await createUser("sms-sender-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
  });
  afterAll(() => closePool());

  it("app.sms_sender_name_ok runs the shared fixture exactly as smsSenderNameOk", async () => {
    for (const value of cases.ok) expect(await ruleOf(value), value).toBe(true);
    for (const value of cases.bad) expect(await ruleOf(value), JSON.stringify(value)).toBe(false);
    expect(await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.sms_sender_name_ok(null) as ok")).rows[0].ok)).toBe(false);
  });

  it("an owner saves a valid name, clears it, and the check refuses an invalid one for every writer", async () => {
    await saveAs(owner.id, org, "MyShop");
    expect(await stored(org)).toBe("MyShop");
    // SMS-01b (211) א: a number only when it is the business's own phone
    await asAdmin((q) => q("update public.organizations set phone = '050-1234567' where id = $1", [org]));
    await saveAs(owner.id, org, "0501234567");
    expect(await stored(org)).toBe("0501234567");
    expect((await pgError(saveAs(owner.id, org, "My Shop"))).code).toBe("23514");
    expect((await pgError(saveAs(owner.id, org, "123456"))).code).toBe("23514");
    // the server is held to the rule too
    expect(
      (await pgError(asAdmin((q) => q("update public.org_message_settings set sms_sender_name = 'חנות' where organization_id = $1", [org])))).code,
    ).toBe("23514");
    await saveAs(owner.id, org, null);
    expect(await stored(org)).toBeNull();
  });

  it("a member or a viewer cannot change it, and another business's owner cannot touch it", async () => {
    await saveAs(owner.id, org, "Mexuz");
    for (const user of [member.id, viewer.id]) {
      const updated = await asUser(user, (q) => q("update public.org_message_settings set sms_sender_name = 'Hacked' where organization_id = $1", [org]));
      expect(updated.rowCount).toBe(0);
    }
    const outsider = await asUser(ownerB.id, (q) => q("update public.org_message_settings set sms_sender_name = 'Hacked' where organization_id = $1", [org]));
    expect(outsider.rowCount).toBe(0);
    expect((await pgError(asUser(ownerB.id, (q) => q("insert into public.org_message_settings (organization_id, sms_sender_name) values ($1, 'Hacked')", [org])))).code).toBe("42501");
    expect(await stored(org)).toBe("Mexuz");
    // members of the business read it; another business's owner reads nothing
    const read = await asUser(member.id, (q) => q<{ v: string }>("select sms_sender_name as v from public.org_message_settings where organization_id = $1", [org]));
    expect(read.rows[0]?.v).toBe("Mexuz");
    const outside = await asUser(ownerB.id, (q) => q("select 1 from public.org_message_settings where organization_id = $1", [org]));
    expect(outside.rowCount).toBe(0);
    expect(orgB).toBeTruthy();
  });

  it("a change is audited", async () => {
    await saveAs(owner.id, org, "Audited1");
    const n = await asAdmin(
      async (q) =>
        (
          await q<{ n: number }>(
            "select count(*)::int as n from public.audit_log where organization_id = $1 and entity_type = 'org_message_settings' and changes::text like '%Audited1%'",
            [org],
          )
        ).rows[0].n,
    );
    expect(n).toBeGreaterThan(0);
  });
});
