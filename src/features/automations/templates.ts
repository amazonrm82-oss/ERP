import type { Lookups } from "./queries";
import type { Rule } from "./schema";

export type Template = {
  key: string;
  title: string;
  description: string;
  // why it cannot be added yet (missing integration or field), when that is the case
  unavailable?: string;
  build?: (lookups: Lookups) => Rule | null;
};

const statusNamed = (lookups: Lookups, name: string) => lookups.statuses.find((s) => s.name === name)?.id;

/** The ready-made rules from the spec (section 10.1), adapted to what is connected today. */
export const TEMPLATES: Template[] = [
  {
    key: "new_lead_callback",
    title: "ליד חדש: לחזור תוך 15 דקות",
    description: "כל ליד חדש מקבל משימת שיחה לבעלים, עם מועד בעוד 15 דקות, והבעלים מקבל התראה. (שליחת WhatsApp אוטומטית תתווסף כשיחובר WhatsApp.)",
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
    description: "עסקה פתוחה שלא זזה שלב 14 ימים: התראה לבעלים ולמנהלי המערכת.",
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
    description: "ביום ההולדת של איש קשר נוצרת משימה לבעלים לשלוח ברכה. (שליחה אוטומטית תתווסף כשיחובר WhatsApp או אימייל.)",
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
    description: "שלושה ימים אחרי שעסקה נסגרה בהצלחה, משימה לבעלים לבקש חוות דעת מהלקוח.",
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
    description: "תזכורת לפני תום מנוי של לקוח.",
    unavailable: "דורש תאריך חידוש בעסקה, שייבנה עם מנויים והכנסה חוזרת.",
  },
];
