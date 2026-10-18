import { z } from "zod";

import { requiredText } from "@/lib/validation";

// TASK-06: the steps inside a task, and the business's checklist templates.

/** The database's limits (migration task_checklists): keep in step. */
export const CHECKLIST_STEP_MAX = 200;
export const CHECKLIST_STEPS_PER_TASK = 100;
export const TEMPLATE_STEPS_MAX = 50;
export const TEMPLATE_NAME_MAX = 80;

/** The defaults every business starts with; mirror of app.seed_checklist_templates() (unit test reads the migration). */
export const DEFAULT_CHECKLIST_TEMPLATES: ReadonlyArray<{ name: string; steps: readonly string[] }> = [
  {
    name: "קליטת לקוח",
    steps: ["שיחת היכרות ותיאום ציפיות", "שליחת הסכם או הצעה חתומה", "קבלת פרטי חיוב", "פתיחת הלקוח במערכות ובכלים", "שיחת מעקב אחרי שבוע"],
  },
  {
    name: "הכנה לפגישה",
    steps: ["בדיקת ההיסטוריה עם הלקוח", "הכנת הצעה או מצגת", "אישור מועד ומקום", "שליחת תזכורת ללקוח"],
  },
];

export type ChecklistStep = { id: string; title: string; done: boolean; position: number };

/** "2 מתוך 5" for a task's steps; null when it has none. */
export function checklistProgress(steps: readonly { done: boolean }[]): { done: number; total: number; text: string } | null {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, text: `${done} מתוך ${steps.length}` };
}

/** One step per line: trimmed, blank lines dropped. */
export function stepsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const stepTitleSchema = requiredText(CHECKLIST_STEP_MAX, "יש לכתוב את השלב.", `שלב ארוך מדי (עד ${CHECKLIST_STEP_MAX} תווים).`);

export const templateSchema = z.object({
  name: requiredText(TEMPLATE_NAME_MAX, "יש לתת שם לתבנית.", `השם ארוך מדי (עד ${TEMPLATE_NAME_MAX} תווים).`),
  steps: z
    .preprocess((value) => (typeof value === "string" ? value : ""), z.string())
    .transform(stepsFromText)
    .pipe(
      z
        .array(z.string().max(CHECKLIST_STEP_MAX, `כל שלב עד ${CHECKLIST_STEP_MAX} תווים.`))
        .min(1, "יש לכתוב לפחות שלב אחד, שלב בכל שורה.")
        .max(TEMPLATE_STEPS_MAX, `עד ${TEMPLATE_STEPS_MAX} שלבים בתבנית.`),
    ),
});

/** Where new steps go: after the last one. */
export function nextPositions(existing: readonly { position: number }[], count: number): number[] {
  const start = existing.reduce((max, s) => Math.max(max, s.position), -1) + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}
