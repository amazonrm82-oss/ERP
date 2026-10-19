import type { Lookups } from "./queries";
import type { Rule } from "./schema";

export type Template = {
  key: string;
  title: string;
  description: string;
  // why it cannot be added yet (missing integration or field), when that is the case
  unavailable?: string;
  // what the business lacks when build answers null (default: a lead status the template names)
  missing?: string;
  build?: (lookups: Lookups) => Rule | null;
};

const statusNamed = (lookups: Lookups, name: string) => lookups.statuses.find((s) => s.name === name)?.id;

/** The ready-made rules from the spec (section 10.1), adapted to what is connected today. */
export const TEMPLATES: Template[] = [
  {
    key: "new_lead_callback",
    title: "ליד חדש: לחזור תוך 15 דקות",
    description: "כל ליד חדש מקבל משימת שיחה לאחראי, עם מועד בעוד 15 דקות, והאחראי מקבל התראה. (שליחת WhatsApp אוטומטית תתווסף כשיחובר WhatsApp.)",
    build: () => ({
      name: "ליד חדש: לחזור תוך 15 דקות",
      trigger: "lead:created",
      conditions: [],
      actions: [
        { type: "create_task", title: "להתקשר ל{{name}}", due_amount: 15, due_unit: "minutes", assign: "owner", task_type: "call" },
        { type: "notify", to: "owner", title: "ליד חדש: {{name}}" },
      ],
    }),
  },
  {
    key: "no_answer_attempts",
    title: "ליד שלא ענה: עוד 3 ניסיונות ב-5 ימים",
    description: 'כשליד עובר לסטטוס "לא ענה", נוצרות שלוש משימות שיחה: מחר, בעוד 3 ימים ובעוד 5 ימים.',
    build: (lookups) => {
      const noAnswer = statusNamed(lookups, "לא ענה");
      if (!noAnswer) return null;
      const attempt = (n: number, days: number) =>
        ({ type: "create_task", title: `ניסיון ${n}: להתקשר ל{{name}}`, due_amount: days, due_unit: "days", assign: "owner", task_type: "call" }) as const;
      return {
        name: "ליד שלא ענה: עוד 3 ניסיונות",
        trigger: "lead:status",
        trigger_to: noAnswer,
        conditions: [],
        actions: [attempt(1, 1), attempt(2, 3), attempt(3, 5)],
      };
    },
  },
  {
    key: "stuck_deal",
    title: "עסקה תקועה: התראה למנהל",
    description: "עסקה פתוחה שלא זזה שלב 14 ימים: התראה לאחראי ולמנהלי המערכת.",
    build: () => ({
      name: "עסקה תקועה 14 ימים",
      trigger: "deal:stuck",
      trigger_number: 14,
      conditions: [],
      actions: [
        { type: "notify", to: "owner", title: "העסקה {{name}} לא זזה שבועיים" },
        { type: "notify", to: "admins", title: "עסקה תקועה: {{name}}" },
      ],
    }),
  },
  {
    key: "meeting_reminder",
    title: "תזכורת לפגישה",
    description: 'שעה לפני משימה מסוג "פגישה", מי שאחראי עליה מקבל תזכורת.',
    build: () => ({
      name: "תזכורת לפגישה",
      trigger: "task:due_soon",
      trigger_number: 60,
      conditions: [{ key: "task_type", value: "meeting" }],
      actions: [{ type: "notify", to: "owner", title: "תזכורת: {{name}} בעוד שעה" }],
    }),
  },
  {
    key: "birthday",
    title: "ברכת יום הולדת",
    description: "ביום ההולדת של איש קשר נוצרת משימה לאחראי לשלוח ברכה. (שליחה אוטומטית תתווסף כשיחובר WhatsApp או אימייל.)",
    build: () => ({
      name: "ברכת יום הולדת",
      trigger: "contact:birthday",
      conditions: [],
      actions: [{ type: "create_task", title: "לשלוח ברכת יום הולדת ל{{name}}", due_amount: 0, due_unit: "minutes", assign: "owner", task_type: "todo" }],
    }),
  },
  {
    key: "review_after_won",
    title: "בקשת חוות דעת אחרי סגירה",
    description: "שלושה ימים אחרי שעסקה נסגרה בהצלחה, משימה לאחראי לבקש חוות דעת מהלקוח.",
    build: () => ({
      name: "בקשת חוות דעת אחרי סגירה",
      trigger: "deal:won",
      conditions: [],
      actions: [{ type: "create_task", title: "לבקש חוות דעת על {{name}}", due_amount: 3, due_unit: "days", assign: "owner", task_type: "follow_up" }],
    }),
  },
  {
    key: "renewal_30d",
    title: "תזכורת חידוש 30 יום לפני",
    description: "30 יום לפני תאריך החידוש של עסקה, משימה לאחראי לדבר עם הלקוח על החידוש.",
    // AUT-03: the deal's renewal date (DEAL-07)
    build: () => ({
      name: "תזכורת חידוש 30 יום לפני",
      trigger: "deal:date",
      trigger_field: "renewal_date",
      trigger_direction: "before",
      trigger_days: 30,
      conditions: [],
      actions: [{ type: "create_task", title: "לדבר עם הלקוח על חידוש {{name}}", due_amount: 0, due_unit: "none", assign: "owner", task_type: "follow_up" }],
    }),
  },
  {
    key: "renewal_deal_30d",
    title: "עסקת חידוש 30 יום לפני",
    description:
      "30 יום לפני תאריך החידוש של עסקה נוצרת עסקת חידוש לאותו לקוח, בתהליך המכירה הראשון, באחריות האחראי על העסקה, ומקושרת לעסקה המקורית. האחראי מקבל משימה לטפל בה. את הסכום ממלאים בעסקה החדשה.",
    missing: "התבנית צריכה תהליך מכירה עם שלב פתוח. הוסיפו שלב פתוח בהגדרות תהליכי המכירה ונסו שוב.",
    // DEAL-08: AUT-03's date trigger on the deal's renewal date (DEAL-07) and AUT-02's "create deal" step, which names the
    // deal it was made from as the previous deal (DEAL-11). Once per deal and renewal date (the engine's run key).
    build: (lookups) => {
      const pipeline = lookups.pipelines.find((p) => p.stages.some((s) => s.kind === "open"));
      if (!pipeline) return null;
      return {
        name: "עסקת חידוש 30 יום לפני",
        trigger: "deal:date",
        trigger_field: "renewal_date",
        trigger_direction: "before",
        trigger_days: 30,
        conditions: [],
        actions: [
          { type: "create_deal", name: "חידוש: {{name}}", pipeline_id: pipeline.id, assign: "owner" },
          { type: "create_task", title: "לטפל בחידוש {{name}}", due_amount: 0, due_unit: "none", assign: "owner", task_type: "follow_up" },
        ],
      };
    },
  },
];
