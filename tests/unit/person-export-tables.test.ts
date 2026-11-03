import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXPORT_TABLES } from "@/features/imports/export-build";
import { PERSON_EXPORT_LEFT_OUT, PERSON_EXPORT_README, PERSON_EXPORT_TABLES } from "@/features/privacy-export/build";

// RVW-62: every table of the full export that reaches a person (a lead, contact or deal of theirs, or one of their
// documents, payments, quotes, orders, tasks, meetings, activities or promises) is in the person's export (PRV-02), or
// left out on purpose with a reason. A new table that links to a person fails here until it is decided. The columns
// come from src/lib/database.types.ts, which test 07 keeps equal to the schema.

const LINK_COLUMNS = [
  "lead_id",
  "contact_id",
  "related_contact_id",
  "delivery_contact_id",
  "deal_id",
  "document_id",
  "accounting_document_id",
  "payment_id",
  "quote_id",
  "order_id",
  "promise_id",
  "activity_id",
  "task_id",
  "meeting_id",
];

const types = fs.readFileSync(path.join(process.cwd(), "src/lib/database.types.ts"), "utf8");

/** The Row type's columns of a public table, read from database.types.ts; null when it cannot be found. */
function columnsOf(table: string): string[] | null {
  const entry = types.match(new RegExp(`^ {6}${table}: (?:ReadOnlyTable|Table)<\\s*(\\w+)`, "m"));
  if (!entry) return null;
  const body = types.match(new RegExp(`export type ${entry[1]} = (?:[\\w &]+& )?\\{([\\s\\S]*?)\\n\\};`));
  if (!body) return null;
  return [...body[1].matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
}

describe("the person export covers every table of the full export that reaches a person (RVW-62)", () => {
  const person = new Set<string>(PERSON_EXPORT_TABLES);

  it("each such table is exported for the person or left out with a reason", () => {
    const unreadable: string[] = [];
    const undecided: string[] = [];
    for (const { table } of EXPORT_TABLES) {
      const columns = columnsOf(table);
      if (!columns) {
        unreadable.push(table);
        continue;
      }
      if (!columns.some((c) => LINK_COLUMNS.includes(c))) continue;
      if (!person.has(table) && !(table in PERSON_EXPORT_LEFT_OUT)) undecided.push(table);
    }
    expect(unreadable, "tables whose Row type this test cannot read").toEqual([]);
    expect(undecided, "add to PERSON_EXPORT_TABLES (and collect.ts) or to PERSON_EXPORT_LEFT_OUT with a reason").toEqual([]);
  });

  it("the left-out list names tables of the full export, each with a reason, none of them exported", () => {
    const full = new Set(EXPORT_TABLES.map((t) => t.table as string));
    for (const [table, reason] of Object.entries(PERSON_EXPORT_LEFT_OUT)) {
      expect(full.has(table), table).toBe(true);
      expect(person.has(table), table).toBe(false);
      expect(reason.length, table).toBeGreaterThan(10);
    }
  });

  it("the README names every section", () => {
    const listed = new Set(
      PERSON_EXPORT_README.split("\n")
        .filter((l) => l.startsWith("- "))
        .flatMap((l) => l.slice(2, l.indexOf(":")).split(",").map((s) => s.trim())),
    );
    for (const table of PERSON_EXPORT_TABLES) {
      if (table === "leads" || table === "contacts") expect(listed.has("people")).toBe(true);
      else expect(listed.has(table), table).toBe(true);
    }
  });
});
