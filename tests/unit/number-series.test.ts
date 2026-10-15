import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { seriesSchema } from "@/features/numbering/schema";
import {
  displayNumber,
  isSeriesKind,
  jumpGapText,
  jumpProblem,
  nextNumber,
  PREFIX_MAX,
  PREFIX_PATTERN,
  SERIES_KINDS,
  seriesFrom,
  START_MAX,
  START_MIN,
  startLocked,
} from "@/features/numbering/series";

// QUO-03: the screen's rules mirror the table's checks (the file name changes when the migration is renumbered)
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = readdirSync(dir).find((name) => name.endsWith("_number_sequences.sql"));
const sql = readFileSync(new URL(file ?? "missing", dir), "utf8");

describe("running number series (QUO-03)", () => {
  it("the kinds, the prefix rule and the start range equal the database constraints", () => {
    const kinds = /number_sequences_kind_check check \(kind in \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect([...kinds.matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...SERIES_KINDS]);
    // the allocator's own list of kinds too
    expect(sql).toContain(`p_kind not in (${SERIES_KINDS.map((k) => `'${k}'`).join(", ")})`);
    expect(sql).toContain(`char_length(prefix) <= ${PREFIX_MAX} and prefix ~ '${PREFIX_PATTERN.source}'`);
    expect(sql).toContain(`check (start_number between ${START_MIN} and ${START_MAX})`);
  });

  it("shows the next number the way app.next_document_number gives it", () => {
    const fresh = seriesFrom("quote", null);
    expect(fresh).toEqual({ kind: "quote", prefix: "", startNumber: 1, lastNumber: null });
    expect(nextNumber(fresh)).toBe(1);
    expect(startLocked(fresh)).toBe(false);
    const used = seriesFrom("order", { prefix: "ORD-", start_number: 1000, last_number: 1004 });
    expect(nextNumber(used)).toBe(1005);
    expect(startLocked(used)).toBe(true);
    expect(displayNumber(used.prefix, nextNumber(used))).toBe("ORD-1005");
    expect(isSeriesKind("quote")).toBe(true);
    expect(isSeriesKind("invoice")).toBe(false);
  });

  it("checks the form: trimmed prefix, allowed characters, whole start in range, start optional", () => {
    expect(seriesSchema.parse({ prefix: "  QT- ", start_number: "1001" })).toEqual({ prefix: "QT-", start_number: 1001 });
    expect(seriesSchema.parse({ prefix: "הצ.2026/", start_number: null })).toEqual({ prefix: "הצ.2026/" });
    expect(seriesSchema.parse({ prefix: "", start_number: "1" })).toEqual({ prefix: "", start_number: 1 });
    expect(seriesSchema.parse({ prefix: "Q1-", start_number: "1" })).toEqual({ prefix: "Q1-", start_number: 1 });
    expect(seriesSchema.safeParse({ prefix: "Q-1", start_number: "1" }).error?.issues[0]?.message).toContain("לא יכולה להסתיים בספרה");
    for (const bad of [
      { prefix: "Q 1", start_number: "1" },
      { prefix: "Q<", start_number: "1" },
      // never a digit at the end: "Q-1" + 35 would print like "Q-" + 135
      { prefix: "Q-1", start_number: "1" },
      { prefix: "2026", start_number: "1" },
      { prefix: "ABCDEFGHIJKLM", start_number: "1" },
      { prefix: "Q", start_number: "0" },
      { prefix: "Q", start_number: "1.5" },
      { prefix: "Q", start_number: String(START_MAX + 1) },
      { prefix: "Q", start_number: "abc" },
    ]) {
      expect(seriesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("allows a jump only forward, after the first number and within range (number_sequence_jump's rule)", () => {
    expect(jumpProblem({ lastNumber: null }, 50)).toContain("עדיין לא ניתן מספר");
    expect(jumpProblem({ lastNumber: 1004 }, 1005)).toContain("גבוה מ-1005");
    expect(jumpProblem({ lastNumber: 1004 }, 1004)).not.toBeNull();
    expect(jumpProblem({ lastNumber: 1004 }, 900)).not.toBeNull();
    expect(jumpProblem({ lastNumber: 1004 }, 1006.5)).not.toBeNull();
    expect(jumpProblem({ lastNumber: 1004 }, START_MAX + 1)).not.toBeNull();
    expect(jumpProblem({ lastNumber: 1004 }, 1006)).toBeNull();
    expect(jumpProblem({ lastNumber: 1004 }, START_MAX)).toBeNull();
    expect(jumpGapText("", 1004, 2000)).toBe("המספרים בין \u20661004\u2069 ל-\u20662000\u2069 יישארו ריקים לתמיד.");
    expect(jumpGapText("Q-", 1004, 2000)).toBe("המספרים בין \u2066Q-1004\u2069 ל-\u2066Q-2000\u2069 יישארו ריקים לתמיד.");
    // the database function says the same
    expect(sql).toContain("if p_next <= v_last + 1 then");
    expect(sql).toContain(`p_next > ${START_MAX} then`);
  });
});
