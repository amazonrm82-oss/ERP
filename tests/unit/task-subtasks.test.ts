import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { catalogFor } from "@/features/list-columns/columns";
import { moveToParentQuestion, openSubtasksQuestion, SUBTASK_NO_REPEAT, subtaskProgress } from "@/features/tasks/subtasks";
import { planHintMessage } from "@/lib/errors";

// TASK-06 part B: sub-tasks (owner, 25 October 2026)
describe("sub-tasks", () => {
  it("counts done out of all: 'הושלמו N מתוך M'", () => {
    expect(subtaskProgress([])).toBeNull();
    expect(subtaskProgress([{ done: true }, { done: false }, { done: false }])).toEqual({ done: 1, total: 3, open: 2, text: "הושלמו 1 מתוך 3" });
    expect(subtaskProgress([{ done: true }])).toMatchObject({ open: 0, text: "הושלמו 1 מתוך 1" });
  });

  it("asks before completing a parent with open sub-tasks", () => {
    expect(openSubtasksQuestion(1)).toBe("יש תת-משימה פתוחה אחת. לסיים בכל זאת?");
    expect(openSubtasksQuestion(3)).toBe("יש 3 תת-משימות פתוחות. לסיים בכל זאת?");
  });

  it("linking to a parent of another record says where the task goes (owner, answer (3) ב)", () => {
    expect(moveToParentQuestion("דנה כהן", true)).toBe("המשימה תעבור לרשומה של משימת האב: דנה כהן. להמשיך?");
    expect(moveToParentQuestion(null, true)).toBe("המשימה תעבור לרשומה של משימת האב. להמשיך?");
    expect(moveToParentQuestion(null, false)).toBe("למשימת האב אין רשומה, ולכן המשימה תנותק מהרשומה שלה. להמשיך?");
    expect(SUBTASK_NO_REPEAT).toContain("בלי חזרה");
  });

  it("the tasks table offers the 'משימת אב' column", () => {
    expect(catalogFor("task", [])).toContainEqual({ key: "parent", label: "משימת אב" });
  });

  it("every hint the migration raises has a Hebrew message", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006020845_task_subtasks.sql"), "utf8");
    const hints = [...new Set([...sql.matchAll(/hint = '(task:[a-z_]+|import_undo:subtasks)'/g)].map((m) => m[1]))];
    expect(hints.sort()).toEqual(["import_undo:subtasks", "task:parent", "task:subtask_callback", "task:subtask_depth", "task:subtask_links", "task:subtask_recurrence"]);
    for (const hint of hints) expect(planHintMessage(hint)).toMatch(/[א-ת]/);
  });
});
