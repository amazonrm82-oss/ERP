import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

/** PRK-01: a custom field is marked personal or sensitive by owners and admins, like its other settings. */
describe("field privacy marks (PRK-01)", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;
  let field: string;
  const mark = () =>
    asAdmin(async (q) => (await q<{ c: string | null }>("select privacy_class as c from public.field_definitions where id = $1", [field])).rows[0].c);

  beforeAll(async () => {
    owner = await createUser("prk1-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "prk1-member");
    field = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type, privacy_class) values ($1, 'contact', 'f_health', 'מצב רפואי', 'text', 'sensitive') returning id",
          [org],
        )
      ).rows[0].id,
    );
  });

  it("starts as written, and owners and admins change it", async () => {
    expect(await mark()).toBe("sensitive");
    await asUser(owner.id, (q) => q("update public.field_definitions set privacy_class = 'personal' where id = $1", [field]));
    expect(await mark()).toBe("personal");
    await asUser(owner.id, (q) => q("update public.field_definitions set privacy_class = null where id = $1", [field]));
    expect(await mark()).toBeNull();
  });

  it("only the closed list is accepted", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("update public.field_definitions set privacy_class = 'secret' where id = $1", [field])))).code).toBe("23514");
  });

  it("a member does not change it", async () => {
    expect(await asUser(member.id, async (q) => (await q("update public.field_definitions set privacy_class = 'sensitive' where id = $1", [field])).rowCount)).toBe(0);
    expect(await mark()).toBeNull();
  });

  it("every change is in the audit log", async () => {
    const changes = await asAdmin(async (q) =>
      (await q<{ c: unknown }>("select changes as c from public.audit_log where organization_id = $1 and entity_type = 'field_definitions' and action = 'update'", [org])).rows,
    );
    expect(JSON.stringify(changes)).toContain("privacy_class");
  });
});
