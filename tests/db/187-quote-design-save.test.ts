import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-05 fix: quote_designs grants UPDATE on its five setting columns only, so PostgREST's upsert (ON CONFLICT DO UPDATE SET
 * organization_id = EXCLUDED.organization_id, ...) failed on every save after the first. The app now updates the row, inserts
 * it only when there is none, and updates again if that insert lost a race (src/features/quotes/design-save.ts).
 */
describe("saving the quote design more than once (QUO-05)", () => {
  let owner: U, member: U;
  let org: string;
  const count = async (q: Query) => Number((await q<{ n: string }>("select count(*) as n from public.quote_designs where organization_id = $1", [org])).rows[0].n);

  beforeAll(async () => {
    owner = await createUser("qd-owner");
    org = await createOrg(owner.id, "עסק העיצוב");
    member = await addMember(org, owner.id, "member", "qd-member");
  });

  it("the upsert PostgREST sends is refused (the old failure), with or without a row", async () => {
    const upsert = (q: Query, header: string) =>
      q(
        `insert into public.quote_designs (organization_id, header_text) values ($1, $2)
         on conflict (organization_id) do update set organization_id = excluded.organization_id, header_text = excluded.header_text`,
        [org, header],
      );
    // the DO UPDATE list needs UPDATE on organization_id, which nobody has: Postgres refuses it before it looks at the rows
    expect((await pgError(asUser(owner.id, (q) => upsert(q, "ראשון")))).code).toBe("42501");
    await asUser(owner.id, (q) => q("insert into public.quote_designs (organization_id, header_text) values ($1, 'ראשון')", [org]));
    expect((await pgError(asUser(owner.id, (q) => upsert(q, "שני")))).code).toBe("42501");
  });

  it("update first, insert only when missing: the owner saves twice in a row; a member saves nothing", async () => {
    const otherOwner = await createUser("qd-owner2");
    const other = await createOrg(otherOwner.id, "עסק בלי עיצוב");
    const save = (u: U, orgId: string, header: string) =>
      asUser(u.id, async (q) => {
        const updated = await q("update public.quote_designs set header_text = $2 where organization_id = $1 returning organization_id", [orgId, header]);
        if (updated.rowCount === 0) await q("insert into public.quote_designs (organization_id, header_text) values ($1, $2)", [orgId, header]);
      });
    await save(otherOwner, other, "ראשון");
    await save(otherOwner, other, "שני");
    await save(otherOwner, other, "שלישי");
    expect(
      await asUser(otherOwner.id, async (q) => (await q<{ h: string }>("select header_text as h from public.quote_designs where organization_id = $1", [other])).rows),
    ).toEqual([{ h: "שלישי" }]);
    // the row of the first test is updated the same way
    await save(owner, org, "עודכן");
    expect(await asUser(owner.id, count)).toBe(1);
    // a member: the update reaches no row and the insert is refused
    expect((await pgError(save(member, org, "של חבר"))).code).toBe("42501");
    expect(await asUser(owner.id, async (q) => (await q<{ h: string }>("select header_text as h from public.quote_designs where organization_id = $1", [org])).rows[0].h)).toBe("עודכן");
  });
});
