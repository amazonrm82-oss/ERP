import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// FXD-06: every foreign key in schemas public and app has an index a lookup by the referenced row can use, so a
// delete, a merge or a join never scans the referring table. A key counts as covered when an index starts with
// exactly its columns, or with its key column (alone, or behind organization_id). A partial index counts only when
// its condition is "<key column> IS NOT NULL" (for each key column): the lookup (where x = $1) cannot use an index
// limited to, say, live records (deleted_at IS NULL).
// Left out on purpose:
// * keys to auth.users with ON DELETE SET NULL, which only record who did something (deleting an account is rare,
//   and an index on every such column would slow every write);
// * the EXCEPTIONS below.
const EXCEPTIONS: Record<string, string> = {
  // a few rows per business at most (one per suspension); its partial index serves the open-suspension lookups
  "app.org_suspensions org_suspensions_organization_id_fkey": "tiny table",
  // a few rows per business at most (one per trial-end step); its partial index serves the job's lookups
  "app.trial_end_transitions trial_end_transitions_organization_id_fkey": "tiny table",
};

type Fk = { name: string; relid: number; conkey: number[]; keycols: number[]; keynames: string[]; orgCol: number | null };
type Index = { relid: number; keys: number[]; pred: string | null };

function covers(index: Index, fk: Fk): boolean {
  if (index.pred !== null) {
    // only "<key column> IS NOT NULL" for each key column (in any order) keeps every row the lookup may find
    const allowed = new Set(fk.keynames.map((col) => `(${col} IS NOT NULL)`));
    const parts = index.pred.replace(/^\((.*)\)$/, "$1").split(" AND ").map((p) => (p.startsWith("(") ? p : `(${p})`));
    if (fk.keynames.length === 0 || !parts.every((p) => allowed.has(p))) return false;
  }
  const lead = index.keys.slice(0, fk.conkey.length);
  if (lead.length === fk.conkey.length && fk.conkey.every((k) => lead.includes(k)) && lead.every((k) => fk.conkey.includes(k))) return true;
  if (fk.keycols.length > 0) {
    if (fk.keycols.includes(index.keys[0])) return true;
    // organization_id first serves the lookup only when the key itself holds organization_id
    if (fk.orgCol !== null && fk.conkey.includes(fk.orgCol) && index.keys[0] === fk.orgCol && fk.keycols.includes(index.keys[1])) return true;
    return false;
  }
  return fk.conkey.includes(index.keys[0]);
}

async function uncoveredKeys(): Promise<string[]> {
  return asAdmin(async (q) => {
    const fks = (
      await q<{ name: string; relid: number; conkey: number[]; keycols: number[]; keynames: string[]; org_col: number | null }>(
        `select n.nspname || '.' || t.relname || ' ' || c.conname as name, c.conrelid::int as relid, c.conkey::int[] as conkey,
                array(select a.attnum::int from unnest(c.conkey) k(attnum)
                        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                       where a.attname <> 'organization_id') as keycols,
                array(select a.attname::text from unnest(c.conkey) k(attnum)
                        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
                       where a.attname <> 'organization_id') as keynames,
                (select a.attnum::int from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'organization_id') as org_col
           from pg_constraint c
           join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
           join pg_class ft on ft.oid = c.confrelid join pg_namespace fn on fn.oid = ft.relnamespace
          where c.contype = 'f' and n.nspname in ('public', 'app')
            and not (fn.nspname = 'auth' and ft.relname = 'users' and c.confdeltype = 'n')
          order by 1`,
      )
    ).rows;
    const indexes = (
      await q<{ relid: number; keys: number[]; pred: string | null }>(
        `select i.indrelid::int as relid, (i.indkey::int2[])::int[] as keys, pg_get_expr(i.indpred, i.indrelid) as pred
           from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
          where n.nspname in ('public', 'app')`,
      )
    ).rows;
    return fks
      .map((row): Fk => ({ name: row.name, relid: row.relid, conkey: row.conkey, keycols: row.keycols, keynames: row.keynames, orgCol: row.org_col }))
      .filter((fk) => !indexes.some((index) => index.relid === fk.relid && covers(index, fk)))
      .map((fk) => fk.name);
  });
}

describe("foreign keys have indexes (FXD-06)", () => {
  it("no foreign key is left without a covering index; partial indexes count only for '<key> IS NOT NULL'", async () => {
    const uncovered = await uncoveredKeys();
    // a new table's foreign key needs a full index: (organization_id, x_id) for a composite key
    expect(uncovered.filter((name) => !(name in EXCEPTIONS))).toEqual([]);
    // an exception that got its index is no longer one
    expect(Object.keys(EXCEPTIONS).filter((name) => !uncovered.includes(name))).toEqual([]);
  });

  it("the nightly purge and the record's notifications have their partial indexes", async () => {
    const names = await asAdmin(async (q) =>
      (await q<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public' and indexname = any($1) order by 1", [
        ["companies_bin_idx", "contacts_bin_idx", "deals_bin_idx", "leads_bin_idx", "notifications_entity_idx", "tasks_bin_idx", "tasks_reminder_due_idx"],
      ])).rows.map((r) => r.indexname),
    );
    expect(names).toEqual(["companies_bin_idx", "contacts_bin_idx", "deals_bin_idx", "leads_bin_idx", "notifications_entity_idx", "tasks_bin_idx", "tasks_reminder_due_idx"]);
  });
});
