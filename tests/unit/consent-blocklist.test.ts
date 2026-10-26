import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BLOCKLIST_CHANNEL_LABELS,
  BLOCKLIST_CHANNELS,
  BLOCKLIST_REASON_LABELS,
  BLOCKLIST_REASONS,
  BLOCKLIST_REMOVED_REASON_LABELS,
  BLOCKLIST_REMOVED_REASONS,
  isBlocklistChannel,
  splitAddresses,
} from "@/features/consent-blocklist/model";

// the migration that creates public.consent_blocklist
function blocklistSql(): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const sql = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .filter((text) => text.includes("create table if not exists public.consent_blocklist"))
    .at(-1);
  expect(sql, "a migration creates public.consent_blocklist").toBeDefined();
  return sql ?? "";
}

function checkList(sql: string, constraint: string, column: string): string[] {
  const list = new RegExp(`${constraint} check \\(${column} in \\(([^)]*)\\)\\)`).exec(sql)?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

describe("consent blocklist (CNS-06)", () => {
  it("the app's closed lists are the database's, each with a Hebrew label", () => {
    const sql = blocklistSql();
    expect(checkList(sql, "consent_blocklist_channel", "channel")).toEqual([...BLOCKLIST_CHANNELS]);
    expect(checkList(sql, "consent_blocklist_reason", "reason")).toEqual([...BLOCKLIST_REASONS]);
    expect(checkList(sql, "consent_blocklist_removed_reason", "removed_reason")).toEqual([...BLOCKLIST_REMOVED_REASONS]);
    for (const c of BLOCKLIST_CHANNELS) expect(BLOCKLIST_CHANNEL_LABELS[c]).toBeTruthy();
    for (const r of BLOCKLIST_REASONS) expect(BLOCKLIST_REASON_LABELS[r]).toBeTruthy();
    for (const r of BLOCKLIST_REMOVED_REASONS) expect(BLOCKLIST_REMOVED_REASON_LABELS[r]).toBeTruthy();
    expect(isBlocklistChannel("fax")).toBe(false);
  });

  it("splits pasted text by lines, commas and semicolons, keeping spaces inside a phone", () => {
    expect(splitAddresses(" 050-123 4567\r\na@b.co, c@d.co;\n\n;x ")).toEqual(["050-123 4567", "a@b.co", "c@d.co", "x"]);
    expect(splitAddresses("  \n ,")).toEqual([]);
  });
});
