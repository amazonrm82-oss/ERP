// TASK-06 part B: sub-tasks (owner, 25 October 2026). A sub-task is an ordinary task with parent_task_id, one level
// only; the database copies the parent's record link and refuses a repeat (migration 020845). These are the screen's rules.

export type SubtaskView = {
  id: string;
  title: string;
  done: boolean;
  // formatted on the server
  dueText: string | null;
  overdue: boolean;
  ownerName: string | null;
};

/** "הושלמו N מתוך M" over the sub-tasks the user sees; null when there are none. */
export function subtaskProgress(subtasks: readonly { done: boolean }[]): { done: number; total: number; open: number; text: string } | null {
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((s) => s.done).length;
  return { done, total: subtasks.length, open: subtasks.length - done, text: `הושלמו ${done} מתוך ${subtasks.length}` };
}

/** The question before completing a parent whose sub-tasks are still open (it asks, it never blocks). */
export function openSubtasksQuestion(open: number): string {
  return open === 1 ? "יש תת-משימה פתוחה אחת. לסיים בכל זאת?" : `יש ${open} תת-משימות פתוחות. לסיים בכל זאת?`;
}

export const SUBTASK_TITLE_MAX = 300;

/** Linking a repeating task to a parent: the repeat is cleared by the person first, never silently. */
export const SUBTASK_NO_REPEAT = "תת-משימה לא חוזרת. בחרו \"בלי חזרה\" ושמרו שוב כדי לקשר למשימת האב.";

/**
 * The question before linking a task to a parent whose record differs: the task moves to the parent's record (the database
 * copies the parent's links). `name` null = a record the user cannot see by name; `hasRecord` false = the parent has none.
 */
export function moveToParentQuestion(name: string | null, hasRecord: boolean): string {
  if (!hasRecord) return "למשימת האב אין רשומה, ולכן המשימה תנותק מהרשומה שלה. להמשיך?";
  return name ? `המשימה תעבור לרשומה של משימת האב: ${name}. להמשיך?` : "המשימה תעבור לרשומה של משימת האב. להמשיך?";
}
