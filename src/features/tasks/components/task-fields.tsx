import { SelectField, TextField } from "@/components/ui/field";

export type AssigneeOption = { userId: string; name: string };

export type TaskValues = { title?: string | null; due_date?: string | null; due_time?: string | null; owner_id?: string | null; task_type?: string | null };

export const TASK_TYPE_OPTIONS = [
  { value: "todo", label: "משימה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "follow_up", label: "מעקב" },
] as const;

type Props = { values: TaskValues; errors: Record<string, string>; assignees: AssigneeOption[]; defaultOwnerId: string };

/** Title, due date and time, assignee. Shared by the new-task form and the edit form. */
export function TaskFields({ values, errors, assignees, defaultOwnerId }: Props) {
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
      {/* key: a select only takes defaultValue on mount */}
      <SelectField key={`type-${values.task_type ?? "todo"}`} label="סוג" name="task_type" defaultValue={values.task_type ?? "todo"} error={errors.task_type}>
        {TASK_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <SelectField key={`owner-${owner}`} label="באחריות" name="owner_id" defaultValue={owner} error={errors.owner_id}>
        {assignees.map((assignee) => (
          <option key={assignee.userId} value={assignee.userId}>
            {assignee.name}
          </option>
        ))}
      </SelectField>
    </>
  );
}
