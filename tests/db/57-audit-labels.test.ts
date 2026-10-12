import { afterAll, describe, expect, it } from "vitest";

import { ENTITY_LABELS, FIELD_LABELS, HIDDEN_FIELDS } from "@/features/audit/labels";

import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// RVW-17: the audit log screen shows a Hebrew name for every kind of entry. A table that
// gets an audit trigger needs an entry in ENTITY_LABELS, or its rows show the table name
// in English and the "type" filter cannot pick it.
describe("audit log labels (RVW-17)", () => {
  const audited = () =>
    asAdmin(async (q) =>
      (
        await q<{ table_name: string }>(
          `select distinct c.relname as table_name
             from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
             join pg_proc p on p.oid = t.tgfoid
             join pg_namespace pn on pn.oid = p.pronamespace
            where not t.tgisinternal and n.nspname = 'public' and pn.nspname = 'app' and p.proname = 'audit_row'
            order by 1`,
        )
      ).rows.map((r) => r.table_name),
    );

  it("every audited table has a Hebrew name", async () => {
    const tables = await audited();
    expect(tables).toEqual(expect.arrayContaining(["meetings", "meeting_participants", "team_members"]));
    expect(tables.filter((t) => !(t in ENTITY_LABELS))).toEqual([]);
  });

  it("every field of meetings, meeting participants and team members has a Hebrew label", async () => {
    // what app.audit_row() leaves out of a change list
    const ignored = new Set(["updated_at", "updated_by", "stage_entered_at", "phone_e164", "last_lead_assigned_at", "reminded_at"]);
    const columns = await asAdmin(async (q) =>
      (
        await q<{ table_name: string; column_name: string }>(
          `select table_name, column_name from information_schema.columns
            where table_schema = 'public' and table_name = any($1) order by 1, 2`,
          [["meetings", "meeting_participants", "team_members"]],
        )
      ).rows,
    );
    expect(columns.length).toBeGreaterThan(0);
    const missing = columns
      .filter((c) => !ignored.has(c.column_name) && !HIDDEN_FIELDS.has(c.column_name) && !(c.column_name in FIELD_LABELS))
      .map((c) => `${c.table_name}.${c.column_name}`);
    expect(missing).toEqual([]);
  });
});
