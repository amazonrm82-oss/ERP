"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { TaskInsert, TaskStatus } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { zoneDate, zonedIso, zoneTime } from "@/lib/format";
import { INVALID_ARGS } from "@/lib/action-args";
import { addDays } from "@/lib/calendar-grid";
import { recordPage } from "@/lib/record-types";
import { subjectSchema, SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";
import { nextWorkingDay } from "@/features/calendar-days/business-days";
import { movedToWorkingDayNotice } from "@/features/calendar-days/rest-day-note";
import { calendarSettingsFromRow, type CalendarSettings } from "@/features/calendar-days/holidays";
import { stepsForNewTask } from "@/features/task-checklists/server";

import { REPEAT_FIELD_NAMES, repeatFormSchema } from "./recurrence";
import { TASK_FIELD_NAMES, taskSchema } from "./schema";

// A task with a date but no time is due at the start of the working day.
const DEFAULT_DUE_TIME = "09:00";

function revalidateTasks(orgId: string) {
  revalidatePath(paths.org(orgId));
  revalidatePath(paths.tasks(orgId));
}

function dueAt(date: string | null, time: string | null, timeZone?: string): string | null {
  return date ? zonedIso(date, `${time ?? DEFAULT_DUE_TIME}:00`, timeZone) : null;
}

function remindAt(due: string | null, remind: string): string | null {
  return due && remind !== "" ? new Date(Date.parse(due) - Number(remind) * 60_000).toISOString() : null;
}

function schedule(data: { due_date: string | null; due_time: string | null; remind: string }) {
  const due = dueAt(data.due_date, data.due_time);
  return { due_at: due, remind_at: remindAt(due, data.remind) };
}

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

/**
 * HEB-02: the business's rest days (the defaults while nobody saved them) and its time zone, read with the user's session.
 * Reads the same columns as getCalendarSettings() in src/features/calendar-days/queries.ts; keep the two in step.
 */
async function readCalendar(
  supabase: Supabase,
  orgId: string,
): Promise<{ calendar: CalendarSettings; timeZone: string | undefined } | { error: string }> {
  const [settings, org] = await Promise.all([
    supabase
      .from("org_calendar_settings")
      .select("rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions")
      .eq("organization_id", orgId)
      .maybeSingle(),
    supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
  ]);
  const error = settings.error ?? org.error;
  if (error) return { error: dbErrorMessage(error) };
  return { calendar: calendarSettingsFromRow(settings.data), timeZone: org.data?.timezone || undefined };
}

const TEAM_CHOICE = "team:";

/** The team of a "team:<id>" choice; undefined when the choice is not a team, null when its id is not valid. */
function teamChoice(value: unknown): string | null | undefined {
  if (typeof value !== "string" || !value.startsWith(TEAM_CHOICE)) return undefined;
  const id = z.uuid().safeParse(value.slice(TEAM_CHOICE.length));
  return id.success ? id.data : null;
}

/** The task form: its fields and its repeat rule (TASK-04), with the errors of both. */
function parseTaskForm(formData: FormData) {
  const input = pick(formData, [...TASK_FIELD_NAMES, ...REPEAT_FIELD_NAMES]);
  // TASK-07: "team:<id>" in the assignee list = for that team, no owner (the database checks the team is the user's to give)
  const team = teamChoice(input.owner_id);
  if (team !== undefined) input.owner_id = null;
  const task = taskSchema.safeParse(input);
  const repeat = repeatFormSchema.safeParse(input);
  if (team === null) {
    return { success: false as const, error: new z.ZodError([{ code: "custom", path: ["owner_id"], message: "יש לבחור אחראי או צוות מהרשימה.", input: undefined }]) };
  }
  if (task.success && repeat.success) {
    return { success: true as const, data: { ...task.data, recurrence: repeat.data, team_id: team ?? null } };
  }
  return { success: false as const, error: new z.ZodError([...(task.error?.issues ?? []), ...(repeat.error?.issues ?? [])]) };
}

/** New task. Without an assignee it is the creator's (the database assigns it). */
export async function createTaskAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseTaskForm(formData);
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // an assignee from another organization fails the composite foreign key
  const { data: created, error } = await context.supabase.from("tasks").insert({
    organization_id: orgId,
    title: parsed.data.title,
    task_type: parsed.data.task_type,
    priority: parsed.data.priority,
    recurrence: parsed.data.recurrence,
    ...schedule(parsed.data),
    ...(parsed.data.owner_id ? { owner_id: parsed.data.owner_id } : {}),
    // TASK-07: a team and no owner; the first in the team to take it becomes its owner
    ...(parsed.data.team_id ? { team_id: parsed.data.team_id } : {}),
  }).select("id").single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את המשימה. נסו שוב."), { values: formValues(formData) });
  }

  // TASK-06: the steps of a picked template; the task stays even when they fail, and the user is told
  const templateId = String(formData.get("checklist_template") ?? "");
  let message: string | undefined;
  if (templateId) {
    const steps = await stepsForNewTask(context.supabase, orgId, created.id, templateId);
    if (!steps.ok) message = `המשימה נוספה, אבל השלבים מהתבנית לא נוספו: ${steps.message}`;
  }

  revalidateTasks(orgId);
  return ok(undefined, message);
}

export async function updateTaskAction(
  orgId: string,
  taskId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseTaskForm(formData);
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // recurrence is always sent: "בלי חזרה" stops the series (TASK-04)
  const { data, error } = await context.supabase
    .from("tasks")
    .update({
      title: parsed.data.title,
      task_type: parsed.data.task_type,
      priority: parsed.data.priority,
      recurrence: parsed.data.recurrence,
      ...schedule(parsed.data),
      ...(parsed.data.owner_id ? { owner_id: parsed.data.owner_id } : {}),
    })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את המשימה. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  revalidateTasks(orgId);
  return { ok: true };
}

async function setTaskStatus(orgId: string, taskId: string, status: TaskStatus): Promise<ActionResult> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  // completed_at is stamped (and cleared) by the database from the status
  const { data, error } = await context.supabase
    .from("tasks")
    .update({ status })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id, lead_id, contact_id, company_id, deal_id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לעדכן את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTasks(orgId);
  // the record's own "משימות" card shows it too (FXU-01)
  const row = data[0];
  const linked = row.deal_id
    ? recordPage("deal", orgId, row.deal_id)
    : row.lead_id
      ? recordPage("lead", orgId, row.lead_id)
      : row.contact_id
        ? recordPage("contact", orgId, row.contact_id)
        : row.company_id
          ? recordPage("company", orgId, row.company_id)
          : null;
  if (linked) revalidatePath(linked);
  return ok();
}

export async function completeTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  return setTaskStatus(orgId, taskId, "done");
}

export async function reopenTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  return setTaskStatus(orgId, taskId, "open");
}

const QUICK_WHEN = { none: null, tomorrow: 1, week: 7 } as const;

/**
 * A task on a record, from the record's own card (FXU-01): one line, and
 * "מחר" or "בעוד שבוע" set the date (at the start of the working day). The task
 * is the creator's and is linked to the record, so it appears on both.
 */
export async function addRecordTaskAction(orgId: string, subject: TimelineSubject, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }
  const parsed = taskSchema.safeParse({ title: formData.get("title"), due_date: null, due_time: null, owner_id: null, task_type: null, remind: null, priority: null });
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const whenKey = String(formData.get("when") ?? "none");
  const days = whenKey in QUICK_WHEN ? QUICK_WHEN[whenKey as keyof typeof QUICK_WHEN] : null;
  // HEB-02: "tomorrow" or "in a week" that is a rest day of the business becomes the next working day
  let day: string | null = null;
  let moved = false;
  let timeZone: string | undefined;
  if (days !== null) {
    const read = await readCalendar(context.supabase, orgId);
    if ("error" in read) {
      return fail(read.error, { values: formValues(formData) });
    }
    timeZone = read.timeZone;
    const plain = addDays(zoneDate(new Date(), timeZone), days);
    day = nextWorkingDay(read.calendar, plain);
    moved = day !== plain;
  }
  const due = day === null ? null : dueAt(day, null, timeZone);

  const row: TaskInsert = { organization_id: orgId, title: parsed.data.title, task_type: "todo", due_at: due };
  row[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  // RLS: the user can write in the organization and can see the record (composite keys keep it inside)
  const { error } = await context.supabase.from("tasks").insert(row);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את המשימה. נסו שוב."), { values: formValues(formData) });
  }
  revalidateTasks(orgId);
  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return moved && day ? { ok: true, message: movedToWorkingDayNotice(day) } : ok();
}

const SNOOZE_DAYS = { tomorrow: 1, week: 7 } as const;
export type SnoozeWhen = keyof typeof SNOOZE_DAYS;

/**
 * Put a task off in one tap (TASK-05): to tomorrow or a week from today, at the
 * time of day it had (the start of the working day if it had none). A reminder
 * moves with it, the same time before.
 */
export async function snoozeTaskAction(orgId: string, taskId: string, when: SnoozeWhen): Promise<ActionResult> {
  if (typeof when !== "string" || !(when in SNOOZE_DAYS)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  const { data: task, error: readError } = await context.supabase
    .from("tasks")
    .select("due_at, remind_at")
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) {
    return fail(dbErrorMessage(readError));
  }
  if (!task) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  // HEB-02: a day the business does not work moves to the next working day (in the business's zone)
  const read = await readCalendar(context.supabase, orgId);
  if ("error" in read) {
    return fail(read.error);
  }
  const time = task.due_at ? zoneTime(new Date(task.due_at), read.timeZone) : DEFAULT_DUE_TIME;
  const plain = addDays(zoneDate(new Date(), read.timeZone), SNOOZE_DAYS[when]);
  const day = nextWorkingDay(read.calendar, plain);
  const due = dueAt(day, time, read.timeZone);
  const remind = task.due_at && task.remind_at && due ? new Date(Date.parse(due) - (Date.parse(task.due_at) - Date.parse(task.remind_at))).toISOString() : null;

  const { data, error } = await context.supabase
    .from("tasks")
    .update({ due_at: due, remind_at: remind })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לדחות את המשימה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTasks(orgId);
  return day !== plain ? { ok: true, message: movedToWorkingDayNotice(day) } : ok();
}

const outcomeSchema = z.string().trim().max(500, { error: "התוצאה ארוכה מדי (עד 500 תווים)." });

/** What came of a completed task, in a line (TASK-03). Empty clears it. */
export async function setTaskOutcomeAction(orgId: string, taskId: string, outcome: string): Promise<ActionResult> {
  const parsed = outcomeSchema.safeParse(outcome);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? INVALID_ARGS);
  }
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase
    .from("tasks")
    .update({ outcome: parsed.data || null })
    .eq("organization_id", orgId)
    .eq("id", taskId)
    .eq("status", "done")
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את התוצאה. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTasks(orgId);
  return ok();
}

const TAKE_REFUSED: Record<string, string> = {
  taken: "מישהו אחר מהצוות כבר לקח את המשימה.",
  closed: "המשימה כבר נסגרה.",
  lead: "זו משימת חזרה לליד: לוקחים את הליד עצמו, והמשימה עוברת איתו.",
};

/** TASK-07: "לקחתי" on a team task. The first in the team wins; the database decides (public.take_task). */
export async function takeTaskAction(orgId: string, taskId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("take_task", { p_org: orgId, p_task: taskId });
  if (error) {
    return fail(error.code === "42501" ? NOT_FOUND_OR_FORBIDDEN : dbErrorMessage(error, "לא הצלחנו לקחת את המשימה. נסו שוב."));
  }
  const answer = (data ?? {}) as { ok?: boolean; reason?: string };
  revalidateTasks(orgId);
  if (answer.ok !== true) {
    return fail(TAKE_REFUSED[answer.reason ?? ""] ?? "לא הצלחנו לקחת את המשימה. נסו שוב.");
  }
  return { ok: true, message: "המשימה עכשיו באחריותך." };
}
