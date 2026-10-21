import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, insertLead, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RVW-46: removing a person (PRV-03) renames a kept deal whose name holds the person's name; the deal's history must not keep
 * the old name: every audit entry of a renamed deal that carries a name change is erased.
 */
describe("a deal renamed by a person's removal keeps no old name in its history (RVW-46)", () => {
  let owner: U, admin: U, member: U;
  let org: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const history = (deal: string) =>
    asAdmin(async (q) => (await q<{ action: string; c: string }>("select action, changes::text as c from public.audit_log where entity_type = 'deals' and entity_id = $1 order by id", [deal])).rows);

  beforeAll(async () => {
    owner = await createUser("pen-owner");
    org = await createOrg(owner.id, "עסק השמות");
    admin = await addMember(org, owner.id, "admin", "pen-admin");
    member = await addMember(org, owner.id, "member", "pen-member");
  });

  it("the renamed deal's name entries are erased; its other entries and an untouched deal stay", async () => {
    const lead = await insertLead(member.id, org, { full_name: "אורית שמש" });
    const { deal_id: deal } = await asUser(member.id, async (q) =>
      (await one<{ r: { deal_id: string } }>(q, "select public.convert_lead($1, true, null, 100000) as r", [lead])).r,
    );
    // a person names the deal after her, then changes its amount (an entry without a name)
    await asUser(member.id, (q) => q("update public.deals set name = 'מטבח לאורית שמש' where id = $1", [deal]));
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 200000 where id = $1", [deal]));
    const other = await asUser(member.id, async (q) => {
      const p = await one<{ pipeline_id: string; stage_id: string }>(q, "select pipeline_id, stage_id from public.deals where id = $1", [deal]);
      const id = (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה אחרת', $2, $3) returning id", [org, p.pipeline_id, p.stage_id])).id;
      await q("update public.deals set name = 'עסקה אחרת לגמרי' where id = $1", [id]);
      return id;
    });
    expect((await history(deal)).filter((e) => e.c.includes("אורית")).length).toBeGreaterThan(0);

    const result = await asMfaUser(admin.id, async (q) =>
      (
        await one<{ r: Record<string, unknown> }>(q, "select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'בקשה', $3, true) as r", [
          org,
          lead,
          JSON.stringify({ [deal]: "עסקה (לקוח נמחק)" }),
        ])
      ).r,
    );
    expect(result).toMatchObject({ deals_renamed: 1 });

    const entries = await history(deal);
    expect(entries.filter((e) => e.c.includes("אורית") || e.c.includes("שמש"))).toEqual([]);
    // the amount change is still there; the name entries are erased, not removed
    expect(entries.some((e) => e.c.includes("amount_agorot"))).toBe(true);
    expect(entries.filter((e) => e.c === '{"erased": true}').length).toBeGreaterThanOrEqual(2);
    // another deal's renames stay as they were
    expect((await history(other)).some((e) => e.c.includes("עסקה אחרת לגמרי"))).toBe(true);
  });
});
