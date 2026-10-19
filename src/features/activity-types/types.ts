// TASK-08: the business's activity and task types, one list (owner, 18 and 19 October 2026). Each type is a name of the
// business under one of the six base kinds, which keep driving the reports and "last contact". Pure code: the log form,
// the task form, the settings page and the unit tests share it. The database mirrors the closed lists in migration
// 20261006020545_activity_types.sql (a unit test reads it).

export const ACTIVITY_BASES = ["note", "call", "meeting", "whatsapp", "email", "sms"] as const;
export type ActivityBase = (typeof ACTIVITY_BASES)[number];

/** The base kinds under their built-in Hebrew names, in the order the forms show them. */
export const BASE_LABELS: Record<ActivityBase, string> = {
  note: "הערה",
  call: "שיחה",
  meeting: "פגישה",
  whatsapp: "WhatsApp",
  email: "אימייל",
  sms: "SMS",
};

/** The defaults every business starts with (app.seed_activity_types): one per base kind, key = the base. */
export const DEFAULT_ACTIVITY_TYPES: ReadonlyArray<{ key: ActivityBase; name: string }> = ACTIVITY_BASES.map((base) => ({
  key: base,
  name: BASE_LABELS[base],
}));

/** Icons a type may carry (keys of the activity_types.icon check); null = the base kind's icon. */
export const ACTIVITY_TYPE_ICONS = [
  "pencil",
  "phone",
  "calendar",
  "chat",
  "mail",
  "users",
  "building",
  "home",
  "check",
  "tag",
  "bolt",
  "form",
  "bell",
  "chart",
] as const;
export type ActivityTypeIcon = (typeof ACTIVITY_TYPE_ICONS)[number];

export const ICON_LABELS: Record<ActivityTypeIcon, string> = {
  pencil: "עיפרון",
  phone: "טלפון",
  calendar: "יומן",
  chat: "הודעה",
  mail: "מעטפה",
  users: "אנשים",
  building: "בניין",
  home: "בית",
  check: "וי",
  tag: "תגית",
  bolt: "ברק",
  form: "טופס",
  bell: "פעמון",
  chart: "גרף",
};

export const BASE_ICONS: Record<ActivityBase, ActivityTypeIcon> = {
  note: "pencil",
  call: "phone",
  meeting: "calendar",
  whatsapp: "chat",
  email: "mail",
  sms: "chat",
};

// the database refuses more (trigger activity_types_cap, hint 'activity_types:max')
export const ACTIVITY_TYPES_PER_ORG = 50;
export const ACTIVITY_TYPE_NAME_MAX = 60;

export function isActivityBase(value: unknown): value is ActivityBase {
  return typeof value === "string" && (ACTIVITY_BASES as readonly string[]).includes(value);
}

export function isActivityTypeIcon(value: unknown): value is ActivityTypeIcon {
  return typeof value === "string" && (ACTIVITY_TYPE_ICONS as readonly string[]).includes(value);
}

/** A type of the business's list. */
export type ActivityTypeOption = {
  id: string;
  baseType: ActivityBase;
  name: string;
  icon: ActivityTypeIcon | null;
  key: string | null;
  isActive: boolean;
};

/** The icon a type shows: its own, else its base kind's. */
export function typeIcon(type: Pick<ActivityTypeOption, "baseType" | "icon">): ActivityTypeIcon {
  return type.icon ?? BASE_ICONS[type.baseType];
}

/**
 * The type an entry or a task shows: by its id, else (saved before the list) the default of its base kind. Null when it
 * has neither (a deleted default): the caller falls back to the built-in name.
 */
export function storedType(typeId: string | null, base: string | null, types: ReadonlyArray<ActivityTypeOption>): ActivityTypeOption | null {
  if (typeId) {
    const own = types.find((type) => type.id === typeId);
    if (own) return own;
  }
  if (!base) return null;
  return types.find((type) => type.key === base) ?? null;
}

/** The name and icon of a logged entry of one of the six kinds. */
export function entryLabel(typeId: string | null, base: ActivityBase, types: ReadonlyArray<ActivityTypeOption>): { name: string; icon: ActivityTypeIcon } {
  const type = storedType(typeId, base, types);
  return type ? { name: type.name, icon: typeIcon(type) } : { name: BASE_LABELS[base], icon: BASE_ICONS[base] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The log form: what a person picks when logging an activity
// ---------------------------------------------------------------------------------------------------------------------

/** One choice of the log form. `value` is the base kind alone, or `t:<id>` for a type of the list. */
export type LogChoice = { value: string; label: string; base: ActivityBase; typeId: string | null };

const TYPE_PREFIX = "t:";

/**
 * The log form's choices: the active types of the list, in its order; then each base kind that has no active type, under its
 * built-in name, so no kind can ever be lost by hiding or deleting its types.
 */
export function logChoices(types: ReadonlyArray<ActivityTypeOption>): LogChoice[] {
  const active = types.filter((type) => type.isActive);
  const choices: LogChoice[] = active.map((type) => ({ value: TYPE_PREFIX + type.id, label: type.name, base: type.baseType, typeId: type.id }));
  for (const base of ACTIVITY_BASES) {
    if (!active.some((type) => type.baseType === base)) choices.push({ value: base, label: BASE_LABELS[base], base, typeId: null });
  }
  return choices;
}

/** The choice a log form starts on: the note type, else the first one. */
export function defaultLogChoice(choices: ReadonlyArray<LogChoice>): string {
  return (choices.find((choice) => choice.base === "note") ?? choices[0])?.value ?? "note";
}

/** Reads a submitted choice: a base kind, or a type id (its kind is read from the list on the server). */
export function parseChoice(value: unknown): { base: ActivityBase } | { typeId: string } | null {
  if (typeof value !== "string") return null;
  if (isActivityBase(value)) return { base: value };
  if (value.startsWith(TYPE_PREFIX)) {
    const id = value.slice(TYPE_PREFIX.length);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? { typeId: id.toLowerCase() } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The task form: "משימה" and "מעקב" stay two fixed choices beside the list (owner, 19 October 2026)
// ---------------------------------------------------------------------------------------------------------------------

export const FIXED_TASK_CHOICES = [
  { value: "todo", label: "משימה" },
  { value: "follow_up", label: "מעקב" },
] as const;

/** The four codes tasks have always stored (task_type); a type of the list sets one from its base kind. */
export const TASK_CODE_LABELS: Record<string, string> = { todo: "משימה", call: "שיחה", meeting: "פגישה", follow_up: "מעקב" };

/** The code a type of the list gives a task (mirrors app.task_activity_type_check). */
export function taskCodeFor(base: ActivityBase): "call" | "meeting" | "todo" {
  return base === "call" ? "call" : base === "meeting" ? "meeting" : "todo";
}

/** What a task is, for its form and its row. */
export type TaskKind = { taskType: string; activityTypeId: string | null };

/** The value of the task form's select for a stored task. */
export function taskChoiceValue(task: TaskKind, types: ReadonlyArray<ActivityTypeOption>): string {
  if (task.activityTypeId && types.some((type) => type.id === task.activityTypeId)) return TYPE_PREFIX + task.activityTypeId;
  if (task.taskType === "todo" || task.taskType === "follow_up") return task.taskType;
  // a call or meeting saved before the list: the default of its kind, while it is there
  const fallback = types.find((type) => type.key === task.taskType && type.isActive);
  return fallback ? TYPE_PREFIX + fallback.id : task.taskType;
}

/**
 * The task form's choices: the two fixed ones, the active types of the list, and the task's own value when it is not
 * among them (a hidden type, or a bare "call" / "meeting" code whose default was deleted), so saving keeps it.
 */
export function taskChoices(types: ReadonlyArray<ActivityTypeOption>, current?: string | null): Array<{ value: string; label: string }> {
  const choices: Array<{ value: string; label: string }> = [
    ...FIXED_TASK_CHOICES,
    ...types.filter((type) => type.isActive).map((type) => ({ value: TYPE_PREFIX + type.id, label: type.name })),
  ];
  if (current && !choices.some((choice) => choice.value === current)) {
    const hidden = current.startsWith(TYPE_PREFIX) ? types.find((type) => TYPE_PREFIX + type.id === current) : undefined;
    const label = hidden?.name ?? TASK_CODE_LABELS[current];
    if (label) choices.push({ value: current, label });
  }
  return choices;
}

/**
 * The columns a task form's choice writes. A fixed code clears the list's type; a type of the list is sent alone, and the
 * database sets task_type from its base kind (sending a task_type with an unchanged type would clear it). Null when the
 * value is not a known shape.
 */
export function parseTaskChoice(value: unknown): { task_type?: string; activity_type_id: string | null } | null {
  const raw = value === null || value === undefined || value === "" ? "todo" : value;
  if (typeof raw !== "string") return null;
  if (Object.hasOwn(TASK_CODE_LABELS, raw)) return { task_type: raw, activity_type_id: null };
  const parsed = parseChoice(raw);
  return parsed && "typeId" in parsed ? { activity_type_id: parsed.typeId } : null;
}

/** The name a task row shows for its kind, or null for a plain "משימה". */
export function taskKindLabel(task: TaskKind, types: ReadonlyArray<ActivityTypeOption>): string | null {
  if (task.activityTypeId) {
    const own = types.find((type) => type.id === task.activityTypeId);
    if (own) return own.name;
  }
  if (task.taskType === "todo") return null;
  if (task.taskType === "call" || task.taskType === "meeting") return types.find((type) => type.key === task.taskType)?.name ?? TASK_CODE_LABELS[task.taskType];
  return TASK_CODE_LABELS[task.taskType] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// TASK-08 follow-ups: the tasks table, its export and the calendar; the one-step call and WhatsApp logs
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A task's type as the tasks table, its export and the calendar name it: the business's own type while it is in the list,
 * hidden ones too (owner's decision, like hidden contact types); else (no type, or a deleted one) today's built-in name of
 * the code the task stores.
 */
export function taskTypeName(task: TaskKind, types: ReadonlyArray<ActivityTypeOption>): string {
  if (task.activityTypeId) {
    const own = types.find((type) => type.id === task.activityTypeId);
    if (own) return own.name;
  }
  return TASK_CODE_LABELS[task.taskType] ?? task.taskType;
}

/**
 * The type a one-step log (the call button, the WhatsApp button) records: the business's active seeded default of that
 * kind (key = the kind), else its first active type of that kind in the list's order, else none (the entry is logged
 * with its kind alone). `types` in the list's order.
 */
export function quickLogTypeId(base: ActivityBase, types: ReadonlyArray<Pick<ActivityTypeOption, "id" | "baseType" | "key" | "isActive">>): string | null {
  const active = types.filter((type) => type.isActive && type.baseType === base);
  return (active.find((type) => type.key === base) ?? active[0])?.id ?? null;
}
