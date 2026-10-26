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
  | "date_reached"
  | "payment_received"
  | "payment_confirmed"
  // AUT-04: commercial triggers
  | "quote_viewed"
  | "quote_accepted"
  | "quote_declined"
  | "quote_expired"
  | "document_recorded"
  | "meeting_scheduled"
  | "meeting_cancelled"
  | "meeting_no_show"
  // AUT-04 follow-up: a tax invoice or proforma passed its due date with a balance left
  | "debt_overdue"
  // AUT-03 (rest): a public form created or matched the record; a fixed schedule; the card's manual button
  | "form_submitted"
  | "schedule"
  | "manual";

/** AUT-04: the plan flags a trigger may need (app.automation_trigger_feature). */
export type TriggerFeature = "payments" | "quotes" | "documents";

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
  // PAY-07: an optional minimum amount in shekels (stored as trigger_config.min_agorot); AUT-04: also "quote accepted", before VAT
  minAmount?: true;
  // AUT-04 follow-up: days after the due date (stored as trigger_config.days_overdue, 0..365)
  overdue?: true;
  // AUT-03: field_changed on any field chosen in the builder (built-in or custom), optionally to a value
  anyField?: true;
  // AUT-03: an optional form (trigger_config.form_id)
  form?: true;
  // AUT-03: a fixed schedule (trigger_config {frequency, time, days?})
  schedule?: true;
  // AUT-03: run from the record's card by a person
  manual?: true;
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
  // PAY-07: a payment recorded on the deal or the contact (a payment on a deal with a contact starts both kinds of rules);
  // offered only with the `payments` plan flag (Lookups.payments)
  { key: "deal:payment", label: "התקבל תשלום בעסקה", entity: "deal", type: "payment_received", minAmount: true },
  { key: "contact:payment", label: "התקבל תשלום מאיש קשר", entity: "contact", type: "payment_received", minAmount: true },
  // PAY-07 (owner, 21 October 2026, answer 3): a payment inserted as confirmed, or moved from recorded to confirmed
  { key: "deal:payment_confirmed", label: "תשלום בעסקה אושר", entity: "deal", type: "payment_confirmed", minAmount: true },
  { key: "contact:payment_confirmed", label: "תשלום של איש קשר אושר", entity: "contact", type: "payment_confirmed", minAmount: true },
  // AUT-04: a quote's status changed (from the customer's page, the expiry job or the staff), on its deal and its contact
  { key: "deal:quote_viewed", label: "הצעת מחיר בעסקה נצפתה", entity: "deal", type: "quote_viewed" },
  { key: "contact:quote_viewed", label: "הצעת מחיר לאיש קשר נצפתה", entity: "contact", type: "quote_viewed" },
  { key: "deal:quote_accepted", label: "הצעת מחיר בעסקה אושרה", entity: "deal", type: "quote_accepted", minAmount: true },
  { key: "contact:quote_accepted", label: "הצעת מחיר לאיש קשר אושרה", entity: "contact", type: "quote_accepted", minAmount: true },
  { key: "deal:quote_declined", label: "הצעת מחיר בעסקה נדחתה", entity: "deal", type: "quote_declined" },
  { key: "contact:quote_declined", label: "הצעת מחיר לאיש קשר נדחתה", entity: "contact", type: "quote_declined" },
  { key: "deal:quote_expired", label: "תוקף הצעת מחיר בעסקה פג", entity: "deal", type: "quote_expired" },
  { key: "contact:quote_expired", label: "תוקף הצעת מחיר לאיש קשר פג", entity: "contact", type: "quote_expired" },
  // AUT-04: a document issued outside the system was recorded (DOC-01)
  { key: "deal:document", label: "נרשם מסמך בעסקה", entity: "deal", type: "document_recorded" },
  { key: "contact:document", label: "נרשם מסמך לאיש קשר", entity: "contact", type: "document_recorded" },
  // AUT-04: meetings linked to the record (of a weekly series only the first is "scheduled"; blocked time never)
  { key: "lead:meeting_scheduled", label: "נקבעה פגישה עם הליד", entity: "lead", type: "meeting_scheduled" },
  { key: "contact:meeting_scheduled", label: "נקבעה פגישה עם איש הקשר", entity: "contact", type: "meeting_scheduled" },
  { key: "company:meeting_scheduled", label: "נקבעה פגישה עם החברה", entity: "company", type: "meeting_scheduled" },
  { key: "deal:meeting_scheduled", label: "נקבעה פגישה בעסקה", entity: "deal", type: "meeting_scheduled" },
  { key: "lead:meeting_cancelled", label: "פגישה עם הליד בוטלה", entity: "lead", type: "meeting_cancelled" },
  { key: "contact:meeting_cancelled", label: "פגישה עם איש הקשר בוטלה", entity: "contact", type: "meeting_cancelled" },
  { key: "company:meeting_cancelled", label: "פגישה עם החברה בוטלה", entity: "company", type: "meeting_cancelled" },
  { key: "deal:meeting_cancelled", label: "פגישה בעסקה בוטלה", entity: "deal", type: "meeting_cancelled" },
  { key: "lead:meeting_no_show", label: "הליד לא הגיע לפגישה", entity: "lead", type: "meeting_no_show" },
  { key: "contact:meeting_no_show", label: "איש הקשר לא הגיע לפגישה", entity: "contact", type: "meeting_no_show" },
  { key: "company:meeting_no_show", label: "פגישה עם החברה: הלקוח לא הגיע", entity: "company", type: "meeting_no_show" },
  { key: "deal:meeting_no_show", label: "פגישה בעסקה: הלקוח לא הגיע", entity: "deal", type: "meeting_no_show" },
  // AUT-04 follow-up: a tax invoice or proforma of the deal / contact is past its due date with a balance left
  { key: "deal:debt_overdue", label: "חוב בעסקה עבר את מועדו", entity: "deal", type: "debt_overdue", overdue: true },
  { key: "contact:debt_overdue", label: "חוב של איש קשר עבר את מועדו", entity: "contact", type: "debt_overdue", overdue: true },
  // AUT-03 (rest): any field of the record changed (status and stage keep their own triggers above)
  { key: "lead:field", label: "שדה בליד השתנה", entity: "lead", type: "field_changed", anyField: true },
  { key: "contact:field", label: "שדה באיש קשר השתנה", entity: "contact", type: "field_changed", anyField: true },
  { key: "company:field", label: "שדה בחברה השתנה", entity: "company", type: "field_changed", anyField: true },
  { key: "deal:field", label: "שדה בעסקה השתנה", entity: "deal", type: "field_changed", anyField: true },
  // AUT-03: a public form created the lead or contact, or a repeat inquiry matched it
  { key: "lead:form", label: "נשלח טופס (ליד)", entity: "lead", type: "form_submitted", form: true },
  { key: "contact:form", label: "נשלח טופס (איש קשר)", entity: "contact", type: "form_submitted", form: true },
  // AUT-03: a fixed schedule over the records the conditions match
  { key: "lead:schedule", label: "לפי לוח זמנים: לידים", entity: "lead", type: "schedule", schedule: true },
  { key: "contact:schedule", label: "לפי לוח זמנים: אנשי קשר", entity: "contact", type: "schedule", schedule: true },
  { key: "company:schedule", label: "לפי לוח זמנים: חברות", entity: "company", type: "schedule", schedule: true },
  { key: "deal:schedule", label: "לפי לוח זמנים: עסקאות פתוחות", entity: "deal", type: "schedule", schedule: true },
  { key: "task:schedule", label: "לפי לוח זמנים: משימות פתוחות", entity: "task", type: "schedule", schedule: true },
  // AUT-03: a person runs the rule from the record's card
  { key: "lead:manual", label: "כפתור בכרטיס הליד", entity: "lead", type: "manual", manual: true },
  { key: "contact:manual", label: "כפתור בכרטיס איש הקשר", entity: "contact", type: "manual", manual: true },
  { key: "company:manual", label: "כפתור בכרטיס החברה", entity: "company", type: "manual", manual: true },
  { key: "deal:manual", label: "כפתור בכרטיס העסקה", entity: "deal", type: "manual", manual: true },
];

/** The most days after the due date a debt rule may wait (app.scheduled_debt_overdue). */
export const DEBT_OVERDUE_MAX_DAYS = 365;

/** The plan flag a trigger type needs, or null for a core trigger (mirrors app.automation_trigger_feature). */
export function triggerFeature(type: TriggerType): TriggerFeature | null {
  if (type === "payment_received" || type === "payment_confirmed") return "payments";
  if (type === "quote_viewed" || type === "quote_accepted" || type === "quote_declined" || type === "quote_expired") return "quotes";
  if (type === "document_recorded") return "documents";
  return null;
}

/** Why a trigger cannot be saved without its plan flag. */
export const FEATURE_MISSING: Record<TriggerFeature, string> = {
  payments: "תשלומים אינם כלולים בתוכנית של העסק.",
  quotes: "הצעות מחיר אינן כלולות בתוכנית של העסק.",
  documents: "מסמכים אינם כלולים בתוכנית של העסק.",
};

/** Every plan flag a trigger type needs (mirrors app.automation_trigger_flags): debt needs documents and payments. */
export function triggerFlags(type: TriggerType): TriggerFeature[] {
  if (type === "debt_overdue") return ["documents", "payments"];
  const feature = triggerFeature(type);
  return feature ? [feature] : [];
}

/** Whether the builder offers a trigger: one that needs plan flags only with all of them; a saved rule keeps its own. */
export function triggerOffered(trigger: TriggerOption, lookups: Partial<Record<TriggerFeature, boolean>>, current?: string): boolean {
  return triggerFlags(trigger.type).every((flag) => !!lookups[flag]) || trigger.key === current;
}

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
  | "create_note"
  | "create_quote";

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
  create_quote: "יצירת הצעת מחיר מתבנית",
};

export function actionsFor(entity: Entity): ActionType[] {
  const all: ActionType[] = [
    "create_task",
    "create_deal",
    "create_note",
    "create_quote",
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
      // AUT-02: a quote is made on a deal or a contact
      (type !== "create_quote" || entity === "deal" || entity === "contact") &&
      (type !== "add_tag" || entity !== "task") &&
      (type !== "set_lead_status" || entity === "lead") &&
      (type !== "move_deal_stage" || entity === "deal"),
  );
}

/**
 * AUT-01: the built-in fields a "set_field" step may write (the engine, app.run_automation_actions, accepts the
 * same list; tests/unit/automation-set-field.test.ts reads the migration). Status, stage, owner and tags have their
 * own actions; custom fields are "cf:<key>". Part B (owner, 18 October 2026): the preferred channel and language and
 * the expected close date; never a name or a phone (an automation does not rewrite identity).
 */
export type BuiltinSetField = "source_id" | "task_type" | "preferred_channel" | "preferred_locale" | "expected_close_date";
/** Whether the builder offers an action: a quote step only with the plan's quotes flag; a saved rule keeps its own. */
export function actionOffered(type: ActionType, lookups: { quotes?: boolean }, current?: string): boolean {
  return type !== "create_quote" || !!lookups.quotes || type === current;
}

export const BUILTIN_SET_FIELDS: Array<{ key: BuiltinSetField; label: string; entities: Entity[] }> = [
  { key: "source_id", label: "מקור", entities: ["lead", "contact", "deal"] },
  { key: "task_type", label: "סוג המשימה", entities: ["task"] },
  { key: "preferred_channel", label: "ערוץ מועדף", entities: ["lead", "contact"] },
  { key: "preferred_locale", label: "שפה מועדפת", entities: ["lead", "contact"] },
  { key: "expected_close_date", label: "תאריך סגירה צפוי", entities: ["deal"] },
];

export const TASK_TYPES = [
  { value: "todo", label: "משימה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "follow_up", label: "מעקב" },
] as const;

/**
 * The builder's trigger of a stored rule. A field_changed rule on status or stage reads as its own trigger; any other
 * field reads as "a field changed" (AUT-03).
 */
export function triggerOf(entity: string, type: string, config: Record<string, unknown>): TriggerOption | undefined {
  const same = TRIGGERS.filter((t) => t.entity === entity && t.type === type);
  return same.find((t) => t.field && t.field === config.field) ?? same.find((t) => !t.field);
}
