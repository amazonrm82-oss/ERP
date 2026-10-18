import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checklistProgress, DEFAULT_CHECKLIST_TEMPLATES, nextPositions, stepsFromText, templateSchema } from "@/features/task-checklists/templates";

function migration(): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const file = readdirSync(dir).find((name) => name.endsWith("_task_checklists.sql"))!;
  return readFileSync(join(dir, file), "utf8");
}

describe("task checklists (TASK-06)", () => {
  it("counts the ticked steps", () => {
    expect(checklistProgress([])).toBeNull();
    expect(checklistProgress([{ done: true }, { done: false }, { done: false }])).toEqual({ done: 1, total: 3, text: "1 מתוך 3" });
  });

  it("reads one step per line and places new steps last", () => {
    expect(stepsFromText(" א \n\n ב\r\nג ")).toEqual(["א", "ב", "ג"]);
    expect(nextPositions([], 2)).toEqual([0, 1]);
    expect(nextPositions([{ position: 4 }, { position: 1 }], 2)).toEqual([5, 6]);
  });

  it("checks a template like the database does", () => {
    expect(templateSchema.safeParse({ name: "קליטה", steps: "א\nב" }).success).toBe(true);
    expect(templateSchema.safeParse({ name: "קליטה", steps: "\n \n" }).success).toBe(false);
    expect(templateSchema.safeParse({ name: "קליטה", steps: Array.from({ length: 51 }, (_, i) => `שלב ${i}`).join("\n") }).success).toBe(false);
    expect(templateSchema.safeParse({ name: "קליטה", steps: "x".repeat(201) }).success).toBe(false);
    expect(templateSchema.safeParse({ name: " ", steps: "א" }).success).toBe(false);
  });

  it("mirrors the seeded defaults of the migration", () => {
    const sql = migration();
    for (const template of DEFAULT_CHECKLIST_TEMPLATES) {
      expect(sql).toContain(`'${template.name}', array[`);
      for (const step of template.steps) expect(sql).toContain(`'${step}'`);
    }
    // and the limits
    expect(sql).toContain("between 1 and 50");
    expect(sql).toContain("> 100 then");
  });
});
