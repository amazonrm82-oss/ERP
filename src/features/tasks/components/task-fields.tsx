import { SelectField, TextField } from "@/components/ui/field";
import { taskChoices, type ActivityTypeOption } from "@/features/activity-types/types";
import { restDays } from "@/features/calendar-days/holidays";

import type { RepeatValues } from "../recurrence";
import { BusinessDaysPicker, type BusinessDaysContext } from "./business-days-picker";
import { RecurrenceFields } from "./recurrence-fields";
import { RestDayWarning } from "./rest-day-warning";

export type AssigneeOption = { userId: string; name: string };

export type TaskValues = {
  title?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  owner_id?: string | null;
  task_type?: string | null;
  remind?: string | null;
  priority?: string | null;
} & RepeatValues;

// the four codes a task stores (task_type), under their built-in names; the table, filters, export and calendar still
// show these (TASK-08 part one names tasks by the business's types in the task list and its forms)
export const TASK_TYPE_OPTIONS = [
  { value: "todo", label: "משימה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "follow_up", label: "מעקב" },
] as const;

// TASK-01: the stored number is the sort order, high first
export const PRIORITY_OPTIONS = [
  { value: "1", label: "גבוהה" },
  { value: "2", label: "רגילה" },
  { value: "3", label: "נמוכה" },
] as const;
export const PRIORITY_LABEL: Record<number, string> = { 1: "גבוהה", 2: "רגילה", 3: "נמוכה" };

export const REMIND_OPTIONS = [
  { value: "", label: "בלי תזכורת" },
  { value: "0", label: "בזמן היעד" },
  { value: "15", label: "רבע שעה לפני" },
  { value: "60", label: "שעה לפני" },
  { value: "1440", label: "יום לפני" },
] as const;

/** The reminder option matching a saved due time and reminder time, or "" when it matches none. */
export function remindOption(dueAt: string | null, remindAt: string | null): string {
  if (!dueAt || !remindAt) {
    return "";
  }
  const minutes = String(Math.round((Date.parse(dueAt) - Date.parse(remindAt)) / 60_000));
  return REMIND_OPTIONS.some((option) => option.value === minutes) ? minutes : "";
}

type Props = {
  values: TaskValues;
  errors: Record<string, string>;
  assignees: AssigneeOption[];
  defaultOwnerId: string;
  /** HEB-03: the quick "in N business days" choice next to the date; left out where the settings are not at hand */
  businessDays?: BusinessDaysContext;
  /** TASK-07: teams the task may go to with no owner (new tasks only); the first in the team to take it owns it */
  teams?: Array<{ id: string; name: string }>;
  /** TASK-08: the business's activity and task types, offered beside the fixed "משימה" and "מעקב" */
  kinds?: ActivityTypeOption[];
};

/** Title, due date and time, reminder, repeat, assignee. Shared by the new-task form and the edit form. */
export function TaskFields({ values, errors, assignees, defaultOwnerId, businessDays, teams = [], kinds = [] }: Props) {
  const owner = values.owner_id || defaultOwnerId;
  return (
    <>
      <TextField
        label="מה צריך לעשות"
        name="title"
        required
        maxLength={300}
        autoComplete="off"
        defaultValue={values.title ?? ""}
        error={errors.title}
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField label="תאריך יעד" name="due_date" type="date" defaultValue={values.due_date ?? ""} error={errors.due_date} />
        <TextField
          label="שעה"
          name="due_time"
          type="time"
          hint="בלי שעה: 09:00"
          defaultValue={values.due_time ?? ""}
          error={errors.due_time}
        />
      </div>
      {businessDays ? (
        <>
          {/* key: a new starting date (a failed save, another task) starts the warning over */}
          <RestDayWarning key={values.due_date ?? ""} calendar={businessDays.calendar} initial={values.due_date ?? ""} />
          <BusinessDaysPicker calendar={businessDays.calendar} today={businessDays.today} />
        </>
      ) : null}
      <SelectField key={`priority-${values.priority ?? "2"}`} label="עדיפות" name="priority" defaultValue={values.priority ?? "2"} error={errors.priority}>
        {PRIORITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      {/* key: a select only takes defaultValue on mount */}
      <SelectField key={`type-${values.task_type ?? "todo"}`} label="סוג" name="task_type" defaultValue={values.task_type ?? "todo"} error={errors.task_type}>
        {taskChoices(kinds, values.task_type).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <SelectField key={`remind-${values.remind ?? ""}`} label="תזכורת" name="remind" defaultValue={values.remind ?? ""} error={errors.remind}>
        {REMIND_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <RecurrenceFields values={values} errors={errors} restWeekdays={businessDays ? restDays(businessDays.calendar) : undefined} />
      <SelectField
        key={`owner-${owner}`}
        label="באחריות"
        name="owner_id"
        defaultValue={owner}
        error={errors.owner_id}
        hint={teams.length > 0 ? "משימה לצוות: כל הצוות רואה אותה, ומי שלוקח ראשון הופך לאחראי." : undefined}
      >
        {teams.length > 0 ? (
          <>
            <optgroup label="אנשים">
              {assignees.map((assignee) => (
                <option key={assignee.userId} value={assignee.userId}>
                  {assignee.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="לצוות: מי שלוקח ראשון">
              {teams.map((team) => (
                <option key={team.id} value={`team:${team.id}`}>
                  צוות {team.name}
                </option>
              ))}
            </optgroup>
          </>
        ) : (
          assignees.map((assignee) => (
            <option key={assignee.userId} value={assignee.userId}>
              {assignee.name}
            </option>
          ))
        )}
      </SelectField>
    </>
  );
}
