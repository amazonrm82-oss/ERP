import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BOARD_DEFAULT_FIELDS,
  BOARD_FIELDS,
  BOARD_PREFERENCE,
  MAX_BOARD_FIELDS,
  boardCatalog,
  boardNeeds,
  daysInStageLabel,
  daysSince,
  resolveBoardFields,
} from "@/features/deals/board-fields";

// DEAL-09: which fields a deal card on the board shows
const catalog = boardCatalog([
  { key: "budget", label: "תקציב" },
  { key: "region", label: "אזור" },
]);
const saved = (...keys: string[]) => keys.map((key) => ({ key, width: "normal" }));

describe("board card fields (DEAL-09)", () => {
  it("offers the built-in fields, then the deal custom fields as cf:<key>", () => {
    expect(catalog.map((c) => c.key)).toEqual([...BOARD_FIELDS.map((f) => f.key), "cf:budget", "cf:region"]);
    expect(new Set(catalog.map((c) => c.key)).size).toBe(catalog.length);
    for (const key of BOARD_DEFAULT_FIELDS) expect(BOARD_FIELDS.some((f) => f.key === key)).toBe(true);
  });

  it("shows what the card showed before when nothing usable was saved", () => {
    expect(resolveBoardFields(null, catalog)).toEqual(["amount", "stuck", "contact"]);
    expect(resolveBoardFields(undefined, catalog)).toEqual(BOARD_DEFAULT_FIELDS);
    expect(resolveBoardFields({ key: "amount" }, catalog)).toEqual(BOARD_DEFAULT_FIELDS);
    expect(resolveBoardFields([{ key: "amount" }], catalog)).toEqual(BOARD_DEFAULT_FIELDS);
  });

  it("keeps the saved order, drops unknown and repeated keys, and caps the count", () => {
    expect(resolveBoardFields(saved("cf:region", "owner", "gone", "cf:deleted", "owner", "amount"), catalog)).toEqual(["cf:region", "owner", "amount"]);
    const many = saved(...catalog.map((c) => c.key));
    expect(catalog.length).toBeGreaterThan(MAX_BOARD_FIELDS);
    expect(resolveBoardFields(many, catalog)).toEqual(catalog.slice(0, MAX_BOARD_FIELDS).map((c) => c.key));
  });

  it("an empty choice stays empty (only the name is shown)", () => {
    expect(resolveBoardFields([], catalog)).toEqual([]);
  });

  it("reads company names, next tasks and custom fields only when a card shows them", () => {
    expect(boardNeeds(BOARD_DEFAULT_FIELDS)).toEqual({ company: false, nextTask: false, custom: false });
    expect(boardNeeds(["company", "next_task", "cf:budget"])).toEqual({ company: true, nextTask: true, custom: true });
  });

  it("counts whole days in the stage", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(daysSince("2026-10-13T08:00:00Z", now)).toBe(0);
    expect(daysSince("2026-10-12T11:00:00Z", now)).toBe(1);
    expect(daysSince("2026-10-01T12:00:00Z", now)).toBe(12);
    expect(daysSince("2026-10-20T12:00:00Z", now)).toBe(0);
    expect(daysSince("not a date", now)).toBe(0);
    const fmt = (n: number) => String(n);
    expect(daysInStageLabel(0, fmt)).toBe("נכנסה לשלב היום");
    expect(daysInStageLabel(1, fmt)).toBe("יום אחד בשלב");
    expect(daysInStageLabel(5, fmt)).toBe("5 ימים בשלב");
  });

  it("the card draws every built-in field", () => {
    const source = readFileSync(join(process.cwd(), "src/features/deals/components/deal-card-fields.tsx"), "utf8");
    for (const field of BOARD_FIELDS) expect(source).toContain(`case "${field.key}":`);
  });

  it("the database accepts the board's list key (latest list_preferences check)", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const last = readdirSync(dir)
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .filter((sql) => sql.includes("add constraint list_preferences_object_type_check"))
      .at(-1);
    expect(last).toBeDefined();
    expect(last).toContain(`'${BOARD_PREFERENCE}'`);
  });
});
