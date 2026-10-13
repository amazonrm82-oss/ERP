import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { priceHistory } from "@/features/products/price-history";

import { addMember, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string };

// PRD-07: price changes come from the audit log (app.audit_row on products); owners and admins read them.
describe("product price history (PRD-07)", () => {
  let owner: U, admin: U, member: U;
  let org: string, productId: string;

  // the same filter the page sends through PostgREST: changes->price_agorot.not.is.null, ...
  const historyRows = (userId: string) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string; created_at: string; actor_id: string | null; changes: Record<string, unknown> }>(
          `select id, created_at, actor_id, changes from public.audit_log
            where organization_id = $1 and entity_type = 'products' and entity_id = $2 and action = 'update'
              and (changes->'price_agorot' is not null or changes->'price_includes_vat' is not null or changes->'vat_kind' is not null)
            order by created_at desc, id desc limit 50`,
          [org, productId],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("ph-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "ph-admin");
    member = await addMember(org, owner.id, "member", "ph-member");
    productId = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'ייעוץ', 10000) returning id", [org])).rows[0].id,
    );
    await asUser(owner.id, (q) => q("update public.products set price_agorot = 12000 where id = $1", [productId]));
    await asUser(admin.id, (q) => q("update public.products set name = 'ייעוץ אישי' where id = $1", [productId]));
    await asUser(admin.id, (q) => q("update public.products set price_includes_vat = true where id = $1", [productId]));
  });

  it("every price change is in the audit log with who made it, and other edits are filtered out", async () => {
    const rows = await historyRows(owner.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].actor_id).toBe(admin.id);
    expect(rows[0].changes.price_includes_vat).toEqual({ old: false, new: true });
    expect(rows[1].actor_id).toBe(owner.id);
    expect(rows[1].changes.price_agorot).toEqual({ old: 10000, new: 12000 });

    const changes = priceHistory(
      { priceAgorot: 12000, priceIncludesVat: true, vatKind: "taxable" },
      rows.map((r) => ({ id: Number(r.id), createdAt: r.created_at, actorName: r.actor_id, changes: r.changes as never })),
    );
    expect(changes).toHaveLength(2);
    expect(changes[1].before).toContain("100");
    expect(changes[1].after).toContain("120");
  });

  it("admins read it; a member reads nothing (the page hides the section from them)", async () => {
    expect(await historyRows(admin.id)).toHaveLength(2);
    expect(await historyRows(member.id)).toHaveLength(0);
  });
});
