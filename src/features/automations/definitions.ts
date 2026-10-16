// What the automation builder offers, and how a rule reads in Hebrew.
// The database engine (migration 0009) is the source of truth for behavior.

export type Entity = "lead" | "contact" | "company" | "deal" | "task";
export type TriggerType =
  | "created"
  | "field_changed"
  | "task_completed"
  | "deal_won"
  | "deal_lost"
  | "no_activity"
  | "stuck_in_stage"
  | "birthday"
  | "task_due_soon"
  | "date_reached";

export type TriggerOption = {
  key: string;
  label: string;
  entity: Entity;
  type: TriggerType;
  // field_changed: which field; the "to" value is optional
  field?: "status_id" | "stage_id";
  // extra number the user enters
  number?: { key: "days" | "minutes"; label: string; default: number };
  // AUT-03: X days before or after a date field (field, days and direction are chosen in the builder)
  date?: true;
};

export const TRIGGERS: TriggerOption[] = [
  { key: "lead:created", label: "ליד חדש נוצר", entity: "lead", type: "created" },
  { key: "lead:status", label: "סטטוס של ליד השתנה", entity: "lead", type: "field_changed", field: "status_id" },
  { key: "lead:no_activity", label: "ליד בלי פעילות", entity: "lead", type: "no_activity", number: { key: "days", label: "ימים בלי פעילות", default: 3 } },
  { key: "contact:created", label: "איש קשר חדש נוצר", entity: "contact", type: "created" },
  { key: "contact:birthday", label: "יום הולדת לאיש קשר", entity: "contact", type: "birthday" },
  { key: "contact:no_activity", label: "איש קשר בלי פעילות", entity: "contact", type: "no_activity", number: { key: "days", label: "ימים בלי פעילות", default: 30 } },
  { key: "company:created", label: "חברה חדשה נוצרה", entity: "company", type: "created" },
  { key: "deal:created", label: "עסקה חדשה נוצרה", entity: "deal", type: "created" },
  { key: "deal:stage", label: "עסקה עברה שלב", entity: "deal", type: "field_changed", field: "stage_id" },
  { key: "deal:won", label: "עסקה נסגרה בהצלחה", entity: "deal", type: "deal_won" },
  { key: "deal:lost", label: "עסקה אבדה", entity: "deal", type: "deal_lost" },
  { key: "deal:stuck", label: "עסקה תקועה באותו שלב", entity: "deal", type: "stuck_in_stage", number: { key: "days", label: "ימים באותו שלב", default: 14 } },
  { key: "deal:no_activity", label: "עסקה פתוחה בלי פעילות", entity: "deal", type: "no_activity", number: { key: "days", label: "ימים בלי פעילות", default: 7 } },
  { key: "task:created", label: "משימה חדשה נוצרה", entity: "task", type: "created" },
  { key: "task:completed", label: "משימה הושלמה", entity: "task", type: "task_completed" },
  { key: "task:due_soon", label: "משימה מתקרבת למועד", entity: "task", type: "task_due_soon", number: { key: "minutes", label: "דקות לפני המועד", default: 60 } },
  // AUT-03
  { key: "lead:date", label: "תאריך בליד", entity: "lead", type: "date_reached", date: true },
  { key: "contact:date", label: "תאריך באיש קשר", entity: "contact", type: "date_reached", date: true },
  { key: "company:date", label: "תאריך בחברה", entity: "company", type: "date_reached", date: true },
  { key: "deal:date", label: "תאריך בעסקה", entity: "deal", type: "date_reached", date: true },
  { key: "task:date", label: "תאריך במשימה", entity: "task", type: "date_reached", date: true },
];

export type ConditionOption = {
  key: string;
  label: string;
  entities: Entity[];
  field: string;
  op: "eq" | "gte" | "has_tag" | "empty";
  // where the value comes from in the builder
  input: "source" | "status" | "tag" | "pipeline" | "shekels" | "task_type" | "none";
};

export const CONDITIONS: ConditionOption[] = [
  { key: "source", label: "המקור הוא", entities: ["lead", "contact", "deal"], field: "source_id", op: "eq", input: "source" },
  { key: "status", label: "הסטטוס הוא", entities: ["lead"], field: "status_id", op: "eq", input: "status" },
  { key: "tag", label: "יש תגית", entities: ["lead", "contact", "company", "deal"], field: "tag_ids", op: "has_tag", input: "tag" },
  { key: "pipeline", label: "בתהליך המכירה", entities: ["deal"], field: "pipeline_id", op: "eq", input: "pipeline" },
  { key: "amount", label: "השווי לפחות (₪)", entities: ["deal"], field: "amount_agorot", op: "gte", input: "shekels" },
  { key: "no_owner", label: "אין אחראי", entities: ["lead", "contact", "company", "deal", "task"], field: "owner_id", op: "empty", input: "none" },
  { key: "task_type", label: "סוג המשימה הוא", entities: ["task"], field: "task_type", op: "eq", input: "task_type" },
];

export type ActionType =
  | "create_task"
  | "notify"
  | "assign_owner"
  | "add_tag"
  | "set_lead_status"
  | "move_deal_stage"
  | "set_field"
  | "create_deal"
  | "create_note";

export const ACTION_LABELS: Record<ActionType, string> = {
  create_task: "יצירת משימה",
  notify: "התראה במערכת",
  assign_owner: "הקצאת אחראי",
  add_tag: "הוספת תגית",
  set_lead_status: "שינוי סטטוס ליד",
  move_deal_stage: "העברת עסקה לשלב",
  set_field: "עדכון שדה",
  create_deal: "יצירת עסקה",
  create_note: "הוספת הערה",
};

export function actionsFor(entity: Entity): ActionType[] {
  const all: ActionType[] = [
    "create_task",
    "create_deal",
    "create_note",
    "notify",
    "assign_owner",
    "add_tag",
    "set_lead_status",
    "move_deal_stage",
    "set_field",
  ];
  return all.filter(
    (type) =>
      // AUT-02: a lead becomes a deal by conversion
      (type !== "create_deal" || entity !== "lead") &&
      (type !== "add_tag" || entity !== "task") &&
      (type !== "set_lead_status" || entity === "lead") &&
      (type !== "move_deal_stage" || entity === "deal"),
  );
}

/**
 * AUT-01: the built-in fields a "set_field" step may write (the engine, app.run_automation_actions, accepts the
 * same list). Status, stage, owner and tags have their own actions; custom fields are "cf:<key>".
 */
export const BUILTIN_SET_FIELDS: Array<{ key: "source_id" | "task_type"; label: string; entities: Entity[] }> = [
  { key: "source_id", label: "מקור", entities: ["lead", "contact", "deal"] },
  { key: "task_type", label: "סוג המשימה", entities: ["task"] },
];

export const TASK_TYPES = [
  { value: "todo", label: "משימה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "follow_up", label: "מעקב" },
] as const;

export function triggerOf(entity: string, type: string, config: Record<string, unknown>): TriggerOption | undefined {
  return TRIGGERS.find((t) => t.entity === entity && t.type === type && (!t.field || t.field === config.field));
}
