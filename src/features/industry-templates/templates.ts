// FLD-05: industry templates. Each one is a package the business can add on top
// of what it already has: a sales pipeline with its stages, lead statuses, lead
// sources, custom fields and automations (added switched off). Applying never
// deletes or renames anything; a name that already exists is skipped.
//
// The database applies them (public.apply_industry_template) from its own copy,
// app.industry_template(key) in the industry templates migration. The two must
// stay equal: tests/db/65-industry-templates.test.ts compares them.
// Keys are the industry keys of the sign-up form (src/features/onboarding/options.ts).
// This file has no runtime imports on purpose (a plain data module).

export type TemplateStageKind = "open" | "won" | "lost";

export type TemplateStage = {
  name: string;
  kind: TemplateStageKind;
  probability: number;
  rot_days: number | null;
};

export type TemplateFieldType = "text" | "number" | "currency" | "percent" | "select" | "multi_select" | "checkbox" | "date" | "url";

export type TemplateField = {
  object_type: "lead" | "contact" | "company" | "deal";
  key: string;
  label: string;
  field_type: TemplateFieldType;
  options: string[];
};

// The rule as the automation engine stores it (no ids: nothing to resolve per organization).
export type TemplateAutomation = {
  key: string;
  name: string;
  entity_type: "lead" | "contact" | "deal";
  trigger_type: "created" | "deal_won" | "stuck_in_stage" | "no_activity";
  trigger_config: Record<string, number>;
  actions: Array<
    | { type: "create_task"; title: string; task_type: "todo" | "call" | "meeting" | "follow_up"; assign: "owner"; due_in_minutes?: number; due_in_days?: number }
    | { type: "notify"; to: "owner" | "admins"; title: string }
  >;
};

export type IndustryTemplate = {
  industry: string;
  title: string;
  // null: the template adds no pipeline (the default one fits)
  pipeline: { name: string; stages: TemplateStage[] } | null;
  // added as open statuses, before "converted" and "not relevant"
  statuses: string[];
  sources: string[];
  fields: TemplateField[];
  automations: TemplateAutomation[];
};

const open = (name: string, probability: number, rot_days: number | null = 14): TemplateStage => ({ name, kind: "open", probability, rot_days });
const won = (name: string): TemplateStage => ({ name, kind: "won", probability: 100, rot_days: null });
const lost = (name: string): TemplateStage => ({ name, kind: "lost", probability: 0, rot_days: null });

const NEW_LEAD_CALL: TemplateAutomation = {
  key: "new_lead_call",
  name: "ליד חדש: לחזור תוך 15 דקות",
  entity_type: "lead",
  trigger_type: "created",
  trigger_config: {},
  actions: [{ type: "create_task", title: "להתקשר ל{{name}}", task_type: "call", assign: "owner", due_in_minutes: 15 }],
};

const STUCK_DEAL: TemplateAutomation = {
  key: "stuck_deal",
  name: "עסקה תקועה 14 ימים",
  entity_type: "deal",
  trigger_type: "stuck_in_stage",
  trigger_config: { days: 14 },
  actions: [{ type: "notify", to: "owner", title: "העסקה {{name}} לא זזה שבועיים" }],
};

const wonTask = (name: string, title: string, days: number, task_type: "todo" | "call" | "follow_up" = "follow_up"): TemplateAutomation => ({
  key: "won_follow_up",
  name,
  entity_type: "deal",
  trigger_type: "deal_won",
  trigger_config: {},
  actions: [{ type: "create_task", title, task_type, assign: "owner", due_in_days: days }],
});

export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  {
    industry: "services",
    title: "שירותים מקצועיים וייעוץ",
    pipeline: {
      name: "ליווי וייעוץ",
      stages: [open("פנייה", 10, 7), open("פגישת אבחון", 25, 7), open("הצעת מחיר", 50), open("חתימה על הסכם", 80), won("לקוח פעיל"), lost("לא התקדם")],
    },
    statuses: ["נקבעה פגישת אבחון", "ממתין להחלטה"],
    sources: ["המלצה של לקוח", "לינקדאין"],
    fields: [
      { object_type: "lead", key: "service_needed", label: "שירות מבוקש", field_type: "select", options: ["ייעוץ חד-פעמי", "ליווי חודשי", "סדנה"] },
      { object_type: "deal", key: "engagement_type", label: "סוג התקשרות", field_type: "select", options: ["לפי שעות", "ריטיינר חודשי", "פרויקט"] },
      { object_type: "deal", key: "hours_estimate", label: "הערכת שעות", field_type: "number", options: [] },
    ],
    automations: [NEW_LEAD_CALL, STUCK_DEAL],
  },
  {
    industry: "real_estate",
    title: "נדל\"ן ותיווך",
    pipeline: {
      name: "עסקאות נדל\"ן",
      stages: [
        open("פנייה ראשונה", 10, 3),
        open("סיור בנכס", 30, 7),
        open("משא ומתן", 60),
        open("זיכרון דברים", 80),
        won("חוזה נחתם"),
        lost("לא נסגר"),
      ],
    },
    statuses: ["נקבע סיור", "מחפש נכס"],
    sources: ["יד2", "שלט על הנכס"],
    fields: [
      { object_type: "lead", key: "deal_type", label: "סוג עסקה", field_type: "select", options: ["קנייה", "מכירה", "השכרה", "שכירות"] },
      { object_type: "lead", key: "property_type", label: "סוג נכס", field_type: "select", options: ["דירה", "דירת גן", "בית פרטי", "פנטהאוז", "מסחרי", "מגרש"] },
      { object_type: "lead", key: "rooms", label: "מספר חדרים", field_type: "number", options: [] },
      { object_type: "lead", key: "area", label: "אזור מבוקש", field_type: "text", options: [] },
      { object_type: "deal", key: "commission", label: "עמלה", field_type: "percent", options: [] },
    ],
    automations: [NEW_LEAD_CALL, STUCK_DEAL],
  },
  {
    industry: "insurance_finance",
    title: "ביטוח ופיננסים",
    pipeline: {
      name: "פוליסות",
      stages: [open("פנייה", 10, 7), open("איסוף מסמכים", 25), open("בדיקת הצעות", 45), open("הצגת הצעה", 70), won("פוליסה הופקה"), lost("לא נסגר")],
    },
    statuses: ["ממתין למסמכים", "נשלחה הצעה"],
    sources: ["המלצה של לקוח", "פרסום מקומי"],
    fields: [
      { object_type: "lead", key: "insurance_type", label: "סוג ביטוח", field_type: "multi_select", options: ["חיים", "בריאות", "רכב", "דירה", "פנסיה", "עסק"] },
      { object_type: "deal", key: "renewal_date", label: "תאריך חידוש", field_type: "date", options: [] },
      { object_type: "deal", key: "monthly_premium", label: "פרמיה חודשית", field_type: "currency", options: [] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("פוליסה הופקה: שיחת מעקב", "לוודא עם {{name}} שהפוליסה התקבלה", 7, "call")],
  },
  {
    industry: "construction",
    title: "בנייה, שיפוצים והתקנות",
    pipeline: {
      name: "פרויקטים",
      stages: [
        open("פנייה", 10, 3),
        open("ביקור ומדידות", 25, 7),
        open("הצעת מחיר", 50),
        open("חתימה ומקדמה", 80),
        open("בביצוע", 90, null),
        won("הסתיים"),
        lost("לא יצא לפועל"),
      ],
    },
    statuses: ["נקבע ביקור", "ממתין להצעה"],
    sources: ["שלט באתר עבודה", "המלצה של לקוח"],
    fields: [
      { object_type: "lead", key: "work_type", label: "סוג עבודה", field_type: "select", options: ["שיפוץ כללי", "מטבח", "חדר רחצה", "איטום", "חשמל", "אינסטלציה"] },
      { object_type: "lead", key: "site_address", label: "כתובת העבודה", field_type: "text", options: [] },
      { object_type: "deal", key: "start_date", label: "מועד התחלה", field_type: "date", options: [] },
      { object_type: "deal", key: "deposit_paid", label: "שולמה מקדמה", field_type: "checkbox", options: [] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("פרויקט הסתיים: בקשת חוות דעת", "לבקש חוות דעת על {{name}}", 7)],
  },
  {
    industry: "retail",
    title: "מסחר וקמעונאות",
    pipeline: {
      name: "הזמנות",
      stages: [open("התעניינות", 10, 3), open("הצעה נשלחה", 40, 7), open("הזמנה התקבלה", 80, 7), open("נשלח ללקוח", 90, 7), won("נמסר"), lost("בוטל")],
    },
    statuses: ["ביקש הצעת מחיר"],
    sources: ["אינסטגרם", "חנות"],
    fields: [
      { object_type: "lead", key: "product_interest", label: "מוצר מבוקש", field_type: "text", options: [] },
      { object_type: "contact", key: "customer_club", label: "חבר מועדון", field_type: "checkbox", options: [] },
      { object_type: "deal", key: "delivery_method", label: "אופן מסירה", field_type: "select", options: ["איסוף עצמי", "שליח", "דואר"] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("הזמנה נמסרה: שיחת מעקב", "לבדוק שההזמנה {{name}} הגיעה תקינה", 3, "call")],
  },
  {
    industry: "health",
    title: "בריאות, טיפול וקליניקות",
    pipeline: {
      name: "טיפולים",
      stages: [open("פנייה", 10, 3), open("שיחת התאמה", 30, 7), open("נקבע טיפול ראשון", 60, 7), open("בסדרת טיפולים", 80, 30), won("הסתיים"), lost("לא המשיך")],
    },
    statuses: ["נקבע תור", "ממתין לתור"],
    sources: ["גוגל", "הפניה מגורם מקצועי"],
    fields: [
      { object_type: "lead", key: "treatment_type", label: "סוג טיפול", field_type: "select", options: ["פגישה ראשונה", "המשך טיפול", "ייעוץ"] },
      { object_type: "contact", key: "health_fund", label: "קופת חולים", field_type: "select", options: ["כללית", "מכבי", "מאוחדת", "לאומית"] },
      { object_type: "deal", key: "sessions_count", label: "מספר מפגשים", field_type: "number", options: [] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("סדרת טיפולים הסתיימה: מעקב", "שיחת מעקב אחרי {{name}}", 14, "call")],
  },
  {
    industry: "education",
    title: "חינוך והדרכה",
    pipeline: {
      name: "הרשמה",
      stages: [open("פנייה", 10, 3), open("שיחת ייעוץ", 30, 7), open("שיעור ניסיון", 50, 7), open("ממתין לתשלום", 80, 7), won("נרשם"), lost("לא נרשם")],
    },
    statuses: ["נקבע שיעור ניסיון"],
    sources: ["אינסטגרם", "יום פתוח"],
    fields: [
      { object_type: "lead", key: "course", label: "קורס מבוקש", field_type: "text", options: [] },
      { object_type: "lead", key: "learning_format", label: "אופן לימוד", field_type: "select", options: ["פרונטלי", "מקוון", "משולב"] },
      { object_type: "contact", key: "parent_name", label: "שם הורה", field_type: "text", options: [] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("נרשם: פרטי פתיחה", "לשלוח פרטי פתיחה על {{name}}", 1, "todo")],
  },
  {
    industry: "marketing",
    title: "שיווק, פרסום ודיגיטל",
    pipeline: {
      name: "לקוחות סוכנות",
      stages: [open("פנייה", 10, 3), open("פגישת היכרות", 25, 7), open("בריף", 40), open("הצעה", 60), won("ריטיינר נחתם"), lost("לא נסגר")],
    },
    statuses: ["נקבעה פגישה"],
    sources: ["לינקדאין", "המלצה של לקוח"],
    fields: [
      {
        object_type: "lead",
        key: "services_needed",
        label: "שירותים מבוקשים",
        field_type: "multi_select",
        options: ["ניהול קמפיינים", "רשתות חברתיות", "בניית אתר", "קידום אורגני", "מיתוג"],
      },
      { object_type: "deal", key: "monthly_budget", label: "תקציב פרסום חודשי", field_type: "currency", options: [] },
      { object_type: "deal", key: "contract_months", label: "תקופת התקשרות בחודשים", field_type: "number", options: [] },
    ],
    automations: [NEW_LEAD_CALL, STUCK_DEAL],
  },
  {
    industry: "technology",
    title: "טכנולוגיה ותוכנה",
    pipeline: {
      name: "מכירות תוכנה",
      stages: [open("פנייה", 10, 7), open("הדגמה", 30), open("תקופת ניסיון", 50, 30), open("הצעת מחיר", 70), won("נחתם"), lost("אבוד")],
    },
    statuses: ["נקבעה הדגמה"],
    sources: ["לינקדאין", "אתר השוואות"],
    fields: [
      { object_type: "lead", key: "users_count", label: "מספר משתמשים", field_type: "number", options: [] },
      { object_type: "deal", key: "license_type", label: "סוג רישוי", field_type: "select", options: ["חודשי", "שנתי", "חד-פעמי"] },
      { object_type: "deal", key: "renewal_date", label: "תאריך חידוש", field_type: "date", options: [] },
    ],
    automations: [NEW_LEAD_CALL, STUCK_DEAL],
  },
  {
    industry: "tourism_events",
    title: "תיירות ואירועים",
    pipeline: {
      name: "אירועים",
      stages: [open("פנייה", 10, 3), open("בדיקת תאריך", 25, 7), open("הצעת מחיר", 50, 7), open("מקדמה שולמה", 85, null), won("האירוע התקיים"), lost("לא נסגר")],
    },
    statuses: ["ממתין לאישור תאריך"],
    sources: ["אינסטגרם", "אתר אירועים"],
    fields: [
      { object_type: "lead", key: "event_date", label: "תאריך האירוע", field_type: "date", options: [] },
      { object_type: "lead", key: "event_type", label: "סוג אירוע", field_type: "select", options: ["חתונה", "בר או בת מצווה", "אירוע חברה", "יום הולדת", "טיול"] },
      { object_type: "lead", key: "guests", label: "מספר משתתפים", field_type: "number", options: [] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("אחרי האירוע: בקשת חוות דעת", "לבקש חוות דעת על {{name}}", 3)],
  },
  {
    industry: "nonprofit",
    title: "עמותות ומלכ\"רים",
    pipeline: {
      name: "תרומות",
      stages: [open("פנייה", 10, 7), open("שיחת היכרות", 30), open("בקשה הוגשה", 50, 30), open("התחייבות", 80, 30), won("התרומה התקבלה"), lost("לא תרם")],
    },
    statuses: ["מעוניין לתרום", "מעוניין להתנדב"],
    sources: ["אירוע התרמה", "מתנדבים"],
    fields: [
      { object_type: "contact", key: "donor_type", label: "סוג תורם", field_type: "select", options: ["פרטי", "חברה", "קרן"] },
      { object_type: "contact", key: "volunteer", label: "מתנדב", field_type: "checkbox", options: [] },
      { object_type: "deal", key: "receipt_sent", label: "נשלחה קבלה לפי סעיף 46", field_type: "checkbox", options: [] },
    ],
    automations: [NEW_LEAD_CALL, wonTask("תרומה התקבלה: תודה וקבלה", "לשלוח מכתב תודה וקבלה על {{name}}", 1, "todo")],
  },
  {
    industry: "other",
    title: "כללי",
    pipeline: null,
    statuses: ["נקבעה פגישה"],
    sources: ["גוגל", "אינסטגרם"],
    fields: [{ object_type: "lead", key: "interest", label: "במה מתעניין", field_type: "text", options: [] }],
    automations: [NEW_LEAD_CALL, STUCK_DEAL],
  },
];

export function industryTemplate(industry: string | null | undefined): IndustryTemplate | null {
  return INDUSTRY_TEMPLATES.find((t) => t.industry === industry) ?? null;
}

// ---------------------------------------------------------------------------
// Preview: what applying would add to an organization, by the same rules as
// public.apply_industry_template (a name that exists, ignoring outer spaces
// only, like btrim(), is skipped; a field is skipped when its key or its label exists on
// that object type).
// ---------------------------------------------------------------------------

export type ExistingLists = {
  // pipelines not in the recycle bin, ordered by position, created_at (the tie-break of the SQL), with their stages
  pipelines: Array<{ name: string; stages: Array<{ name: string; kind: string }> }>;
  statuses: string[];
  sources: string[];
  fields: Array<{ object_type: string; key: string; label: string }>;
  automations: Array<{ name: string; template_key: string | null }>;
};

export type TemplatePreview = {
  // the pipeline's name, and whether it is new (false: stages are added to the one with that name)
  pipeline: { name: string; isNew: boolean } | null;
  stages: string[];
  statuses: string[];
  sources: string[];
  fields: TemplateField[];
  automations: string[];
};

// btrim(name): strips plain spaces (U+0020) at both ends, nothing else; no case folding
export const normName = (name: string): string => name.replace(/^ +| +$/g, "");

export function automationTemplateKey(industry: string, key: string): string {
  return `industry:${industry}:${key}`;
}

export function previewTemplate(template: IndustryTemplate, existing: ExistingLists): TemplatePreview {
  const missing = (names: string[], have: string[]) => {
    const seen = new Set(have.map(normName));
    return names.filter((name) => {
      const n = normName(name);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  };

  let pipeline: TemplatePreview["pipeline"] = null;
  let stages: string[] = [];
  if (template.pipeline) {
    const match = existing.pipelines.find((p) => normName(p.name) === normName(template.pipeline!.name));
    if (!match) {
      pipeline = { name: template.pipeline.name, isNew: true };
      stages = template.pipeline.stages.map((s) => s.name);
    } else {
      const closedKinds = new Set(match.stages.filter((s) => s.kind !== "open").map((s) => s.kind));
      const candidates = template.pipeline.stages.filter((s) => s.kind === "open" || !closedKinds.has(s.kind));
      stages = missing(
        candidates.map((s) => s.name),
        match.stages.map((s) => s.name),
      );
      pipeline = stages.length > 0 ? { name: match.name, isNew: false } : null;
    }
  }

  const fields = template.fields.filter(
    (f) =>
      !existing.fields.some(
        (e) => e.object_type === f.object_type && (e.key === f.key || normName(e.label) === normName(f.label)),
      ),
  );
  const automations = template.automations
    .filter(
      (a) =>
        !existing.automations.some(
          (e) => e.template_key === automationTemplateKey(template.industry, a.key) || normName(e.name) === normName(a.name),
        ),
    )
    .map((a) => a.name);

  return {
    pipeline,
    stages,
    statuses: missing(template.statuses, existing.statuses),
    sources: missing(template.sources, existing.sources),
    fields,
    automations,
  };
}

export function previewIsEmpty(preview: TemplatePreview): boolean {
  return (
    preview.stages.length === 0 &&
    preview.statuses.length === 0 &&
    preview.sources.length === 0 &&
    preview.fields.length === 0 &&
    preview.automations.length === 0
  );
}
