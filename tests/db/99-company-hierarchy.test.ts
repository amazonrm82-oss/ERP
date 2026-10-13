import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, TEST_DB_URL } from "./helpers";

afterAll(async () => {
  await closePool();
});

type U = { id: string };

// CON-07: a company's parent company. Triggers companies_parent_check (a person's pick must be a
// live company they read) and companies_parent_tree (no cycle, at most 10 levels, every writer).
describe("company hierarchy (CON-07)", () => {
  let owner: U, member: U, other: U;
  let org: string, otherOrg: string;

  const newCompany = (userId: string, name: string, parent: string | null = null, orgId?: string) =>
    asUser(userId, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, parent_company_id) values ($1, $2, $3) returning id", [orgId ?? org, name, parent])).rows[0].id,
    );
  const setParent = (userId: string, id: string, parent: string | null) =>
    asUser(userId, (q) => q("update public.companies set parent_company_id = $2 where id = $1", [id, parent]));
  const parentOf = (id: string) =>
    asAdmin(async (q) => (await q<{ p: string | null }>("select parent_company_id as p from public.companies where id = $1", [id])).rows[0].p);
  // a chain of n companies, each under the previous one; returns them top first
  const chain = async (n: number, label: string) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(await newCompany(owner.id, `${label} ${i + 1}`, ids[i - 1] ?? null));
    }
    return ids;
  };

  beforeAll(async () => {
    owner = await createUser("tree-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "tree-member");
    other = await createUser("tree-other");
    otherOrg = await createOrg(other.id);
  });

  it("a member picks a parent they read; the children are listed under it", async () => {
    const parent = await newCompany(owner.id, "חברת אם");
    const child = await newCompany(member.id, "צפון", parent);
    const second = await newCompany(member.id, "דרום");
    await setParent(member.id, second, parent);
    expect(await parentOf(second)).toBe(parent);
    expect(
      await asUser(member.id, (q) => count(q, "select 1 from public.companies where organization_id = $1 and parent_company_id = $2", [org, parent])),
    ).toBe(2);
    // clearing the parent is always allowed
    await setParent(member.id, child, null);
    expect(await parentOf(child)).toBeNull();
  });

  it("a company cannot be its own parent", async () => {
    const id = await newCompany(owner.id, "עצמית");
    const e = await pgError(setParent(owner.id, id, id));
    expect(e.code).toBe("P0001");
    expect(e.hint).toBe("company:parent_cycle");
  });

  it("a company cannot sit under one of its own descendants", async () => {
    const [a, b, c] = await chain(3, "מעגל");
    const direct = await pgError(setParent(owner.id, a, b));
    expect(direct.hint).toBe("company:parent_cycle");
    const deep = await pgError(setParent(owner.id, a, c));
    expect(deep.hint).toBe("company:parent_cycle");
    expect(await parentOf(a)).toBeNull();
  });

  it("server writers are checked for cycles too", async () => {
    const [a, b] = await chain(2, "שרת");
    const e = await pgError(asAdmin((q) => q("update public.companies set parent_company_id = $2 where id = $1", [a, b])));
    expect(e.hint).toBe("company:parent_cycle");
  });

  it("the tree may have 10 levels, not 11", async () => {
    const ids = await chain(10, "עומק");
    expect(await parentOf(ids[9])).toBe(ids[8]);
    const e = await pgError(newCompany(owner.id, "עומק 11", ids[9]));
    expect(e.code).toBe("P0001");
    expect(e.hint).toBe("company:parent_depth");
  });

  it("moving a subtree counts the levels below the moved company", async () => {
    const top = await chain(6, "עליון");
    const sub = await chain(5, "תת");
    // 6 above + 5 levels of the moved subtree = 11
    const e = await pgError(setParent(owner.id, sub[0], top[5]));
    expect(e.hint).toBe("company:parent_depth");
    // 5 + 5 = 10 is fine
    await setParent(owner.id, sub[0], top[4]);
    expect(await parentOf(sub[0])).toBe(top[4]);
  });

  it("a parent in the recycle bin cannot be picked, but an existing link stays", async () => {
    const parent = await newCompany(owner.id, "לסל");
    const child = await newCompany(owner.id, "בת קיימת", parent);
    const later = await newCompany(owner.id, "בת חדשה");
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = now() where id = $1", [parent]));
    const e = await pgError(setParent(owner.id, later, parent));
    expect(e.code).toBe("P0001");
    expect(e.hint).toBe("company:parent_invalid");
    // the existing child keeps its parent and can still be edited, the parent sent unchanged included
    await asUser(owner.id, (q) => q("update public.companies set name = 'בת קיימת 2', parent_company_id = $2 where id = $1", [child, parent]));
    expect(await parentOf(child)).toBe(parent);
    // restoring the parent makes it pickable again
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = null where id = $1", [parent]));
    await setParent(owner.id, later, parent);
    expect(await parentOf(later)).toBe(parent);
  });

  it("a person cannot pick a parent they may not read", async () => {
    const hidden = await newCompany(owner.id, "של הבעלים בלבד");
    const mine = await newCompany(member.id, "של החבר");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const e = await pgError(setParent(member.id, mine, hidden));
      expect(e.hint).toBe("company:parent_invalid");
      const onInsert = await pgError(newCompany(member.id, "חדשה של החבר", hidden));
      expect(onInsert.hint).toBe("company:parent_invalid");
      // the owner reads both and may link them; the member then sees the link but not the parent row
      await setParent(owner.id, mine, hidden);
      expect(await parentOf(mine)).toBe(hidden);
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.companies where id = $1", [hidden]))).toBe(0);
      // editing another field of that company keeps the hidden parent
      await asUser(member.id, (q) => q("update public.companies set city = 'חיפה', parent_company_id = $2 where id = $1", [mine, hidden]));
      expect(await parentOf(mine)).toBe(hidden);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a parent of another organization is refused by the foreign key", async () => {
    const foreign = await newCompany(other.id, "זרה", null, otherOrg);
    const mine = await newCompany(owner.id, "מקומית");
    const e = await pgError(setParent(owner.id, mine, foreign));
    // the person's read check answers first: the other organization's row is not readable
    expect(e.hint).toBe("company:parent_invalid");
    const server = await pgError(asAdmin((q) => q("update public.companies set parent_company_id = $2 where id = $1", [mine, foreign])));
    expect(server.code).toBe("23503");
  });

  it("purging a parent leaves its children without a parent", async () => {
    const parent = await newCompany(owner.id, "למחיקה");
    const child = await newCompany(owner.id, "בת שנשארת", parent);
    await asUser(owner.id, async (q) => {
      await q("update public.companies set deleted_at = now() where id = $1", [parent]);
      const purged = await q("delete from public.companies where id = $1", [parent]);
      expect(purged.rowCount).toBe(1);
    });
    expect(await parentOf(child)).toBeNull();
  });

  it("a merge moves the children to the kept company", async () => {
    const keep = await newCompany(owner.id, "נשארת");
    const dup = await newCompany(owner.id, "כפולה");
    const child = await newCompany(owner.id, "בת של הכפולה", dup);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}')", [org, keep, dup]));
    expect(await parentOf(child)).toBe(keep);
  });

  it("a merge that would close a cycle is refused and changes nothing", async () => {
    // dup -> mid -> keep: keeping the grandchild would put mid under keep while keep is under mid
    const dup = await newCompany(owner.id, "סבתא");
    const mid = await newCompany(owner.id, "אמא", dup);
    const keep = await newCompany(owner.id, "נכדה", mid);
    const e = await pgError(asUser(owner.id, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}')", [org, keep, dup])));
    expect(e.hint).toBe("company:parent_cycle");
    expect(await parentOf(mid)).toBe(dup);
    expect(await parentOf(keep)).toBe(mid);
  });

  it("a merge is judged by the tree it leaves, not by a half-done statement", async () => {
    // C1 … C9 in a chain; Y and K both under C9 (Y first). Merging C9 into K puts K on top and Y
    // under it (2 levels); a row-by-row check would walk from Y up through K's old parent C9.
    const c = await chain(9, "ארוכה");
    const y = await newCompany(owner.id, "Y", c[8]);
    const k = await newCompany(owner.id, "K", c[8]);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}')", [org, k, c[8]]));
    expect(await parentOf(k)).toBeNull();
    expect(await parentOf(y)).toBe(k);
  });

  it("one statement that closes a cycle across several rows is refused", async () => {
    const a = await newCompany(owner.id, "רב-שורות א");
    const b = await newCompany(owner.id, "רב-שורות ב");
    const x = await newCompany(owner.id, "רב-שורות ג");
    const e = await pgError(
      asUser(owner.id, (q) =>
        q(
          `update public.companies set parent_company_id = case id when $1::uuid then $2::uuid when $2::uuid then $1::uuid else $1::uuid end
            where id in ($1, $2, $3)`,
          [a, b, x],
        ),
      ),
    );
    expect(e.hint).toBe("company:parent_cycle");
    expect(await parentOf(a)).toBeNull();
    expect(await parentOf(b)).toBeNull();
    expect(await parentOf(x)).toBeNull();
  });

  it("two updates that together would close a cycle run one after the other", async () => {
    const a = await newCompany(owner.id, "מקביל א");
    const b = await newCompany(owner.id, "מקביל ב");
    const first = new Client({ connectionString: TEST_DB_URL });
    const second = new Client({ connectionString: TEST_DB_URL });
    await first.connect();
    await second.connect();
    try {
      await first.query("begin");
      await first.query("update public.companies set parent_company_id = $2 where id = $1", [a, b]);
      await second.query("begin");
      // waits for the first transaction's advisory lock
      const pending = second.query("update public.companies set parent_company_id = $2 where id = $1", [b, a]).then(
        () => null,
        (error: { hint?: string }) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query("commit");
      const error = await pending;
      expect(error?.hint).toBe("company:parent_cycle");
      await second.query("rollback");
    } finally {
      await first.end();
      await second.end();
    }
    expect(await parentOf(a)).toBe(b);
    expect(await parentOf(b)).toBeNull();
  });
});
