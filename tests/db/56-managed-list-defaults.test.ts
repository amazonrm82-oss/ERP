import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_REASONS } from "@/features/disqualify-reasons/schema";
import { DEFAULT_TYPES } from "@/features/record-type-options/schema";

import { asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

// Owner's rule (12 October 2026): every managed list starts with default values.
// New organizations get them in create_organization(); organizations that
// existed before get them from the migration, only where the list is empty.

const MIGRATION = "managed_list_defaults.sql";

/** The statement of the migration that fills the lists of the organizations that exist (the last `do` block). */
function backfillStatement(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith(MIGRATION));
  if (!file) throw new Error(`no migration *${MIGRATION}`);
  const sql = readFileSync(path.join(dir, file), "utf8");
  return sql.slice(sql.lastIndexOf("\ndo $$") + 1);
}

type Lists = { contact: string[]; company: string[]; reasons: string[] };

const listsOf = (org: string): Promise<Lists> =>
  asAdmin(async (q) => {
    const types = (object: string) =>
      q<{ name: string }>("select name from public.record_type_options where organization_id = $1 and object_type = $2 order by position, created_at", [
        org,
        object,
      ]).then((r) => r.rows.map((row) => row.name));
    const reasons = (await q<{ name: string }>("select name from public.disqualify_reasons where organization_id = $1 order by position, created_at", [org])).rows.map(
      (row) => row.name,
    );
    return { contact: await types("contact"), company: await types("company"), reasons };
  });

describe("managed lists start with default values", () => {
  let owner: { id: string };

  beforeAll(async () => {
    owner = await createUser("ld-owner");
  });

  it("a new organization gets the default contact types, company types and 'not relevant' reasons, in order", async () => {
    const org = await createOrg(owner.id, "עסק חדש");
    expect(await listsOf(org)).toEqual({ contact: [...DEFAULT_TYPES], company: [...DEFAULT_TYPES], reasons: [...DEFAULT_REASONS] });
    const positions = await asAdmin(async (q) =>
      (await q<{ position: number }>("select position from public.disqualify_reasons where organization_id = $1 order by position", [org])).rows.map((r) => r.position),
    );
    expect(positions).toEqual(DEFAULT_REASONS.map((_, i) => i));
    // the owner created them: the audit log says so
    const actors = await asAdmin(async (q) =>
      (await q<{ actor_id: string | null }>("select distinct actor_id from public.audit_log where organization_id = $1 and entity_type in ('record_type_options', 'disqualify_reasons')", [org]))
        .rows,
    );
    expect(actors).toEqual([{ actor_id: owner.id }]);
    // the owner can rename and delete them like any other row
    expect(
      await asUser(owner.id, async (q) => (await q("update public.record_type_options set name = 'לקוח קבוע' where organization_id = $1 and name = 'לקוח' and object_type = 'contact'", [org])).rowCount),
    ).toBe(1);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.disqualify_reasons where organization_id = $1 and name = 'אחר'", [org])).rowCount)).toBe(1);
  });

  it("the migration fills only empty lists, and adds nothing when it runs again", async () => {
    const empty = await createOrg(owner.id, "עסק שרוקן");
    const custom = await createOrg(owner.id, "עסק עם רשימות משלו");
    await asAdmin(async (q) => {
      // an organization from before the rule: everything empty
      await q("delete from public.record_type_options where organization_id = $1", [empty]);
      await q("delete from public.disqualify_reasons where organization_id = $1", [empty]);
      // an organization that kept its own lists: one reason, one hidden contact type, no company types
      await q("delete from public.record_type_options where organization_id = $1", [custom]);
      await q("delete from public.disqualify_reasons where organization_id = $1", [custom]);
      await q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'סיבה שלנו')", [custom]);
      await q("insert into public.record_type_options (organization_id, object_type, name, is_active) values ($1, 'contact', 'סוג מוסתר', false)", [custom]);
    });

    const backfill = backfillStatement();
    expect(backfill).toMatch(/^do \$\$/);
    await asAdmin((q) => q(backfill));

    expect(await listsOf(empty)).toEqual({ contact: [...DEFAULT_TYPES], company: [...DEFAULT_TYPES], reasons: [...DEFAULT_REASONS] });
    // per list and per object type: the company types were empty, the rest were not
    expect(await listsOf(custom)).toEqual({ contact: ["סוג מוסתר"], company: [...DEFAULT_TYPES], reasons: ["סיבה שלנו"] });
    // a migration has no user: the audit entries of the seed have no actor
    const seeded = await asAdmin(async (q) =>
      (
        await q<{ n: number }>(
          "select count(*)::int as n from public.audit_log where organization_id = $1 and entity_type = 'disqualify_reasons' and action = 'insert' and actor_id is null",
          [empty],
        )
      ).rows[0].n,
    );
    expect(seeded).toBe(DEFAULT_REASONS.length);

    const before = await asAdmin(async (q) =>
      (await q<{ n: number }>("select (select count(*) from public.record_type_options) + (select count(*) from public.disqualify_reasons) as n")).rows[0].n,
    );
    await asAdmin((q) => q(backfill));
    const after = await asAdmin(async (q) =>
      (await q<{ n: number }>("select (select count(*) from public.record_type_options) + (select count(*) from public.disqualify_reasons) as n")).rows[0].n,
    );
    expect(after).toBe(before);
  });

  it("the seed cannot be called from the API", async () => {
    const org = await createOrg(owner.id, "עסק נוסף");
    await expect(asUser(owner.id, (q) => q("select app.seed_list_defaults($1)", [org]))).rejects.toThrow(/permission denied/);
  });
});
