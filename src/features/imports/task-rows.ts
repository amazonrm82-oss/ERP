// IMP-03: one row of a tasks file -> the columns of public.tasks and the keys of the records it is
// linked to, or the reason it cannot be imported. Pure (no database): the server resolves the
// owner and the links with the user's session. Used by task-server.ts and its unit tests.

import { TASK_TYPE_VALUES } from "@/features/tasks/schema";
import type { TaskStatus } from "@/lib/database.types";

import { choiceOf, companyKey, parseDateTimeCell, parseTimeCell, personKey, type PersonKey } from "./record-cells";

export const TASK_TITLE_MAX = 300;
export const TASK_DESCRIPTION_MAX = 5000;
/** The time a task with a due date and no time is due, as in the task form. */
export const DEFAULT_DUE_TIME = "09:00";

type TaskType = (typeof TASK_TYPE_VALUES)[number];

const TYPE_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "todo", label: "משימה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "follow_up", label: "מעקב" },
];
const TYPE_SYNONYMS: Record<string, TaskType> = {
  task: "todo",
  "to do": "todo",
  כללי: "todo",
  טלפון: "call",
  "שיחת טלפון": "call",
  "phone call": "call",
  פגישה: "meeting",
  "follow up": "follow_up",
  followup: "follow_up",
  "מעקב אחרי": "follow_up",
};

const PRIORITY_OPTIONS: Array<{ value: "1" | "2" | "3"; label: string }> = [
  { value: "1", label: "גבוהה" },
  { value: "2", label: "רגילה" },
  { value: "3", label: "נמוכה" },
];
const PRIORITY_SYNONYMS: Record<string, "1" | "2" | "3"> = {
  גבוה: "1",
  דחוף: "1",
  דחופה: "1",
  high: "1",
  urgent: "1",
  רגיל: "2",
  בינונית: "2",
  normal: "2",
  medium: "2",
  נמוך: "3",
  low: "3",
};

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "open", label: "פתוחה" },
  { value: "done", label: "בוצעה" },
];
const STATUS_SYNONYMS: Record<string, TaskStatus> = {
  פתוח: "open",
  "לא בוצעה": "open",
  todo: "open",
  "to do": "open",
  לא: "open",
  בוצע: "done",
  הושלמה: "done",
  הושלם: "done",
  הסתיימה: "done",
  completed: "done",
  complete: "done",
  כן: "done",
  yes: "done",
};

export type ParsedTaskRow = {
  values: {
    title: string;
    description: string | null;
    task_type: TaskType;
    priority: number;
    status: TaskStatus;
  };
  // the due day and time as written, in the business's zone (null = no due date)
  dueDate: string | null;
  dueTime: string | null;
  owner: string | null;
  lead: PersonKey | null;
  contact: PersonKey | null;
  company: { name: string; domain: string | null } | null;
  // a deal by its exact name
  deal: string | null;
};

/** Checks one row. `raw` holds the non-empty cells by target key. */
export function parseTaskRow(raw: Record<string, string>): ParsedTaskRow | string {
  const title = raw.title?.trim() ?? "";
  if (!title) return "חסרה כותרת: מה צריך לעשות.";
  if (Array.from(title).length > TASK_TITLE_MAX) return `הכותרת ארוכה מדי (עד ${TASK_TITLE_MAX} תווים).`;
  const description = raw.description?.trim() || null;
  if (description && Array.from(description).length > TASK_DESCRIPTION_MAX) return `הפירוט ארוך מדי (עד ${TASK_DESCRIPTION_MAX.toLocaleString("en-US")} תווים).`;

  let taskType: TaskType = "todo";
  if (raw.task_type) {
    const value = choiceOf(raw.task_type, TYPE_OPTIONS, TYPE_SYNONYMS);
    if (!value) return `הסוג "${raw.task_type}" לא מוכר. אפשר: משימה, שיחה, פגישה או מעקב.`;
    taskType = value;
  }
  let priority = 2;
  if (raw.priority) {
    const value = choiceOf(raw.priority, PRIORITY_OPTIONS, PRIORITY_SYNONYMS);
    if (!value) return `העדיפות "${raw.priority}" לא מוכרת. אפשר: גבוהה, רגילה או נמוכה.`;
    priority = Number(value);
  }
  let status: TaskStatus = "open";
  if (raw.status) {
    const value = choiceOf(raw.status, STATUS_OPTIONS, STATUS_SYNONYMS);
    if (!value) return `המצב "${raw.status}" לא מוכר. אפשר: פתוחה או בוצעה.`;
    status = value;
  }

  let dueDate: string | null = null;
  let dueTime: string | null = null;
  if (raw.due_date) {
    const parsed = parseDateTimeCell(raw.due_date);
    if (!parsed) return `תאריך היעד "${raw.due_date}" אינו תקין (למשל 31/12/2026 או 31/12/2026 14:30).`;
    dueDate = parsed.date;
    dueTime = parsed.time;
  }
  if (raw.due_time) {
    const time = parseTimeCell(raw.due_time);
    if (!time) return `השעה "${raw.due_time}" אינה תקינה (למשל 14:30).`;
    if (!dueDate) return "כדי לקבוע שעה צריך גם תאריך יעד.";
    // a separate time column wins over a time inside the date cell
    dueTime = time;
  }

  const lead = raw.lead ? personKey(raw.lead) : null;
  if (raw.lead && !lead) return `בליד צריך להיות טלפון או אימייל, ולא "${raw.lead}".`;
  const contact = raw.contact ? personKey(raw.contact) : null;
  if (raw.contact && !contact) return `באיש הקשר צריך להיות אימייל או טלפון, ולא "${raw.contact}".`;

  return {
    values: { title, description, task_type: taskType, priority, status },
    dueDate,
    dueTime,
    owner: raw.owner?.trim() || null,
    lead,
    contact,
    company: raw.company ? companyKey(raw.company) : null,
    // exactly as stored, only trimmed (public.deal_name_matches compares the whole name)
    deal: raw.deal?.trim() || null,
  };
}
