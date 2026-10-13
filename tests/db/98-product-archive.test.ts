import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(async () => {
  // the stand-in for later document lines must not outlive this file (its FK blocks deleting products)
  await asAdmin((q) => q("drop schema if exists prd02_stand_in cascade"));
  await closePool();
});

type U = { id: string };

// PRD-02: archive and restore; removal only while nothing refers to the product.
describe("product archive and removal (PRD-02)", () => {
  let owner: U, member: U;
  let org: string;

  const newProduct = (name: string) =>
    asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, $2) returning id", [org, name])).rows[0].id);
  const archivedAt = (id: string) =>
    asAdmin(async (q) => (await q<{ archived_at: Date | null }>("select archived_at from public.products where id = $1", [id])).rows[0].archived_at);

  beforeAll(async () => {
    owner = await createUser("archive-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "archive-member");
    // A stand-in for the document lines of later waves, outside the public schema so
    // that the schema-wide tests do not see it. It references products exactly as every
    // real lines table must: composite foreign key, no on delete action.
    await asAdmin(async (q) => {
      await q("create schema if not exists prd02_stand_in");
      await q(`create table if not exists prd02_stand_in.document_lines (
                 id uuid primary key default gen_random_uuid(),
                 organization_id uuid not null,
                 product_id uuid,
                 foreign key (organization_id, product_id) references public.products (organization_id, id))`);
    });
  });

  it("the server stamps the archive time; archiving again keeps it; null restores", async () => {
    const id = await newProduct("לארכיון");
    await asUser(owner.id, (q) => q("update public.products set archived_at = '2001-01-01' where id = $1", [id]));
    const first = await archivedAt(id);
    expect(first).not.toBeNull();
    expect(Date.now() - first!.getTime()).toBeLessThan(5 * 60 * 1000);
    await asUser(owner.id, (q) => q("update public.products set archived_at = '2030-01-01' where id = $1", [id]));
    expect((await archivedAt(id))!.getTime()).toBe(first!.getTime());
    await asUser(owner.id, (q) => q("update public.products set archived_at = null where id = $1", [id]));
    expect(await archivedAt(id)).toBeNull();
    // the change is audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'products' and entity_id = $1 and changes ? 'archived_at'", [id]))).toBe(2);
  });

  it("a member cannot archive, restore or remove", async () => {
    const id = await newProduct("של הבעלים");
    await asUser(member.id, async (q) => {
      expect((await q("update public.products set archived_at = now() where id = $1", [id])).rowCount).toBe(0);
      expect((await q("delete from public.products where id = $1", [id])).rowCount).toBe(0);
    });
    expect(await archivedAt(id)).toBeNull();
  });

  it("a product nothing refers to can be removed, archived or not", async () => {
    const plain = await newProduct("בלי מסמכים");
    const archived = await newProduct("בארכיון בלי מסמכים");
    await asUser(owner.id, async (q) => {
      await q("update public.products set archived_at = now() where id = $1", [archived]);
      expect((await q("delete from public.products where id = $1", [plain])).rowCount).toBe(1);
      expect((await q("delete from public.products where id = $1", [archived])).rowCount).toBe(1);
    });
  });

  it("a product on a document line cannot be removed, only archived", async () => {
    const id = await newProduct("במסמך");
    await asAdmin((q) => q("insert into prd02_stand_in.document_lines (organization_id, product_id) values ($1, $2)", [org, id]));
    const error = await pgError(asUser(owner.id, (q) => q("delete from public.products where id = $1", [id])));
    expect(error.code).toBe("23503");
    await asUser(owner.id, async (q) => {
      expect((await q("update public.products set archived_at = now() where id = $1", [id])).rowCount).toBe(1);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.products where id = $1", [id]))).toBe(1);
    // a line cannot point at another organization's product either
    const otherOwner = await createUser("archive-other");
    const other = await createOrg(otherOwner.id, "עסק אחר");
    expect((await pgError(asAdmin((q) => q("insert into prd02_stand_in.document_lines (organization_id, product_id) values ($1, $2)", [other, id])))).code).toBe("23503");
  });
});
