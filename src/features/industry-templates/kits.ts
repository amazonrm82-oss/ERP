// VRT-01: industry kits. A kit is an industry template (FLD-05: a pipeline, lead statuses, sources, custom fields,
// automations switched off) plus what a business of that industry needs on its first day: sample products (punch
// cards only with the plan key), meeting types, message templates (DRAFT wording), WhatsApp templates, one web form
// (added switched off) and saved lead views. Applying a kit, like a template, only adds what is missing (names
// compared with btrim(), and ignoring case where the table's unique index does); nothing is deleted, renamed or changed.
// Owner (274) א + ב: the first two kits are clinics and studios & courses.
//
// The database applies them (public.apply_industry_template) from its own copy, app.industry_kit(key) in the
// industry kits migration. The two must stay equal: tests/db/65-industry-templates.test.ts compares them.
//
// The clinics kit holds NO health or medical content (no diagnosis, medication, condition or sensitivity field, no
// health declaration): tests/db/356-industry-kits and tests/unit/industry-kits check every name, label and option
// against a closed list of medical words.

import {
  INDUSTRY_TEMPLATES,
  normName,
  previewTemplate,
  type ExistingLists,
  type IndustryTemplate,
  type TemplatePreview,
} from "./templates";

export type KitProduct = {
  name: string;
  kind: "product" | "service" | "punch_card";
  // before VAT, taxable (the FLD-05 rule)
  price_agorot: number;
  billing: "one_time" | "monthly";
  // only on a punch card (added only with the plan key punch_cards); meeting_type: the kit's meeting type a held meeting
  // of uses an entry, by name (none when the business has no type of that name)
  punch: { entries: number; validity_count: number; validity_unit: "days" | "months"; meeting_type: string | null } | null;
};

export type KitMeetingType = {
  name: string;
  duration_minutes: number;
  meeting_format: "in_person" | "phone" | "video" | "other";
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  color: "accent" | "success" | "warning" | "danger" | "neutral";
  // the kit's product the type offers, by name (linked only while the plan has the product catalog and it is offerable)
  product: string | null;
};

export type KitMessageTemplate = {
  name: string;
  channel: "email" | "sms" | "whatsapp";
  // marketing only: a service template of a type with its own sender (CAL-12's meeting reminders) is the system's own
  // (notice_kind), so a kit's copy could never be sent and would only take one of the 50 slots; never an offer
  message_type: "marketing";
  subject: string | null;
  body: string;
};

export type KitWhatsappTemplate = { name: string; body: string };

export type KitForm = {
  name: string;
  title: string;
  intro: string;
  submit_label: string;
  success_message: string;
  // built-in intake keys or cf:<key> of the kit's lead fields (a custom field the business lacks is left out)
  fields: Array<{ key: string; required: boolean }>;
};

// an organization-wide view of the leads list, filtered by one of the kit's lead statuses
export type KitView = { object_type: "lead"; name: string; status: string };

export type IndustryKit = {
  template: IndustryTemplate;
  products: KitProduct[];
  meeting_types: KitMeetingType[];
  message_templates: KitMessageTemplate[];
  whatsapp_templates: KitWhatsappTemplate[];
  form: KitForm;
  views: KitView[];
};

// the DRAFT marker kept in message_templates.wording_version on the kit's templates (cleared by a person's edit)
export const KIT_WORDING_VERSION = "kit-draft-1";

const open = (name: string, probability: number, rot_days: number | null = 14) => ({ name, kind: "open" as const, probability, rot_days });
const won = (name: string) => ({ name, kind: "won" as const, probability: 100, rot_days: null });
const lost = (name: string) => ({ name, kind: "lost" as const, probability: 0, rot_days: null });
const svc = (name: string, shekels: number, billing: KitProduct["billing"] = "one_time"): KitProduct => ({
  name,
  kind: "service",
  price_agorot: shekels * 100,
  billing,
  punch: null,
});
const punch = (name: string, shekels: number, entries: number, months: number, meetingType: string): KitProduct => ({
  name,
  kind: "punch_card",
  price_agorot: shekels * 100,
  billing: "one_time",
  punch: { entries, validity_count: months, validity_unit: "months", meeting_type: meetingType },
});

const NEW_LEAD_CALL = {
  key: "new_lead_call",
  name: "ליד חדש: לחזור תוך 15 דקות",
  entity_type: "lead" as const,
  trigger_type: "created" as const,
  trigger_config: {},
  actions: [{ type: "create_task" as const, title: "להתקשר ל{{name}}", task_type: "call" as const, assign: "owner" as const, due_in_minutes: 15 }],
};

export const INDUSTRY_KITS: readonly IndustryKit[] = [
  {
    template: {
      industry: "clinic",
      title: "ערכת קליניקה ומרפאה",
      pipeline: {
        name: "טיפולים בקליניקה",
        stages: [open("פנייה", 10, 3), open("שיחת התאמה", 30, 7), open("נקבע תור ראשון", 60, 7), open("בסדרת טיפולים", 80, 30), won("סדרה נסגרה"), lost("לא המשיך")],
      },
      statuses: ["נקבע תור", "ממתין לתור", "ביקש שיחה חוזרת"],
      sources: ["גוגל", "הפניה מגורם מקצועי", "אינסטגרם"],
      fields: [
        { object_type: "lead", key: "treatment_type", label: "סוג טיפול", field_type: "select", options: ["פגישת היכרות", "טיפול בודד", "סדרת טיפולים"] },
        { object_type: "lead", key: "preferred_therapist", label: "מטפל/ת מועדף/ת", field_type: "text", options: [] },
        { object_type: "lead", key: "referral_source", label: "מקור הפניה", field_type: "select", options: ["איש או אשת מקצוע", "חברים ומשפחה", "אינטרנט", "אחר"] },
        { object_type: "contact", key: "preferred_time", label: "זמן מועדף לתור", field_type: "select", options: ["בוקר", "צהריים", "ערב"] },
        { object_type: "deal", key: "sessions_count", label: "מספר מפגשים", field_type: "number", options: [] },
      ],
      automations: [
        NEW_LEAD_CALL,
        {
          key: "won_follow_up",
          name: "סדרה נסגרה: שיחת מעקב",
          entity_type: "deal",
          trigger_type: "deal_won",
          trigger_config: {},
          actions: [{ type: "create_task", title: "שיחת מעקב אחרי {{name}}", task_type: "call", assign: "owner", due_in_days: 14 }],
        },
      ],
    },
    products: [svc("פגישת היכרות", 150), svc("טיפול", 300), punch("כרטיסייה ל-10 טיפולים", 2700, 10, 6, "טיפול")],
    meeting_types: [
      { name: "תור ראשון", duration_minutes: 45, meeting_format: "in_person", buffer_before_minutes: 0, buffer_after_minutes: 10, color: "success", product: "פגישת היכרות" },
      { name: "טיפול", duration_minutes: 50, meeting_format: "in_person", buffer_before_minutes: 0, buffer_after_minutes: 10, color: "accent", product: "טיפול" },
      { name: "שיחת התאמה טלפונית", duration_minutes: 15, meeting_format: "phone", buffer_before_minutes: 0, buffer_after_minutes: 0, color: "warning", product: null },
    ],
    message_templates: [
      {
        name: "הזמנה לתור המשך",
        channel: "whatsapp",
        message_type: "marketing",
        subject: null,
        body: "שלום {שם פרטי}, עבר זמן מאז הביקור האחרון ב{שם העסק}. רוצים לקבוע תור המשך? אפשר להשיב להודעה או להתקשר: {טלפון העסק}",
      },
    ],
    whatsapp_templates: [
      { name: "אישור תור", body: "שלום {שם פרטי}, התור ב{שם העסק} נקבע ל-{תאריך} בשעה {שעה}. נתראה!" },
      { name: "תזכורת לתור מחר", body: "שלום {שם פרטי}, תזכורת: מחר בשעה {שעה} יש תור ב{שם העסק}. אם צריך לשנות, כתבו לנו כאן." },
      { name: "שיחת מעקב אחרי טיפול", body: "שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. רצינו לשמוע איך היה ואם אפשר לעזור במשהו." },
    ],
    form: {
      name: "טופס קביעת תור",
      title: "קביעת תור",
      intro: "השאירו פרטים ונחזור אליכם לתיאום תור.",
      submit_label: "שליחה",
      success_message: "תודה! נחזור אליכם בהקדם לתיאום התור.",
      fields: [
        { key: "full_name", required: true },
        { key: "phone", required: true },
        { key: "cf:treatment_type", required: false },
        { key: "cf:referral_source", required: false },
        { key: "message", required: false },
      ],
    },
    views: [
      { object_type: "lead", name: "ממתינים לתור", status: "ממתין לתור" },
      { object_type: "lead", name: "תורים שנקבעו", status: "נקבע תור" },
    ],
  },
  {
    template: {
      industry: "studio",
      title: "ערכת סטודיו וקורסים",
      pipeline: {
        name: "הרשמה לסטודיו",
        stages: [open("פנייה", 10, 3), open("נקבע שיעור ניסיון", 40, 7), open("אחרי שיעור ניסיון", 60, 7), open("ממתין לתשלום", 80, 7), won("הרשמה הושלמה"), lost("לא המשיך")],
      },
      statuses: ["נקבע שיעור ניסיון", "הגיע לשיעור ניסיון", "ממתין לפתיחת קבוצה"],
      sources: ["אינסטגרם", "פייסבוק", "חבר מביא חבר"],
      fields: [
        { object_type: "lead", key: "level", label: "רמה", field_type: "select", options: ["מתחילים", "ממשיכים", "מתקדמים"] },
        { object_type: "lead", key: "track", label: "מסלול", field_type: "select", options: ["שיעורים קבועים", "כרטיסייה", "קורס", "שיעור פרטי"] },
        { object_type: "lead", key: "preferred_days", label: "ימים מועדפים", field_type: "multi_select", options: ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"] },
        { object_type: "contact", key: "parent_name", label: "שם הורה", field_type: "text", options: [] },
        { object_type: "deal", key: "course_start", label: "תאריך פתיחה", field_type: "date", options: [] },
      ],
      automations: [
        NEW_LEAD_CALL,
        {
          key: "won_follow_up",
          name: "הרשמה הושלמה: פרטי פתיחה",
          entity_type: "deal",
          trigger_type: "deal_won",
          trigger_config: {},
          actions: [{ type: "create_task", title: "לשלוח פרטי פתיחה על {{name}}", task_type: "todo", assign: "owner", due_in_days: 1 }],
        },
      ],
    },
    products: [
      svc("שיעור ניסיון", 50),
      svc("שיעור בודד", 80),
      svc("מנוי חודשי", 350, "monthly"),
      svc("קורס מתחילים", 1200),
      punch("כרטיסייה ל-10 שיעורים", 700, 10, 3, "שיעור קבוצתי"),
    ],
    meeting_types: [
      { name: "שיעור ניסיון", duration_minutes: 60, meeting_format: "in_person", buffer_before_minutes: 0, buffer_after_minutes: 0, color: "success", product: "שיעור ניסיון" },
      { name: "שיעור קבוצתי", duration_minutes: 60, meeting_format: "in_person", buffer_before_minutes: 0, buffer_after_minutes: 15, color: "accent", product: "שיעור בודד" },
      { name: "שיעור פרטי", duration_minutes: 60, meeting_format: "in_person", buffer_before_minutes: 0, buffer_after_minutes: 0, color: "warning", product: null },
    ],
    message_templates: [
      {
        name: "קבוצה חדשה נפתחת",
        channel: "email",
        message_type: "marketing",
        subject: "קבוצה חדשה נפתחת ב{שם העסק}",
        body: "שלום {שם פרטי},\nאנחנו פותחים קבוצה חדשה ב{שם העסק}. לפרטים ולהרשמה אפשר להשיב למייל הזה או להתקשר: {טלפון העסק}.\n{שם העסק}",
      },
    ],
    whatsapp_templates: [
      { name: "אישור שיעור ניסיון", body: "שלום {שם פרטי}, שיעור הניסיון ב{שם העסק} נקבע ל-{תאריך} בשעה {שעה}. נתראה!" },
      { name: "תזכורת לשיעור", body: "שלום {שם פרטי}, תזכורת: השיעור ב{שם העסק} ב-{תאריך} בשעה {שעה}. אם אי אפשר להגיע, כתבו לנו כאן." },
      { name: "מעקב אחרי שיעור ניסיון", body: "שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. איך היה בשיעור הניסיון? נשמח לספר על המסלולים." },
    ],
    form: {
      name: "טופס הרשמה לשיעור ניסיון",
      title: "הרשמה לשיעור ניסיון",
      intro: "השאירו פרטים ונחזור אליכם לתיאום שיעור ניסיון.",
      submit_label: "שליחה",
      success_message: "תודה! נחזור אליכם בהקדם.",
      fields: [
        { key: "full_name", required: true },
        { key: "phone", required: true },
        { key: "email", required: false },
        { key: "cf:level", required: false },
        { key: "cf:track", required: false },
        { key: "message", required: false },
      ],
    },
    views: [
      { object_type: "lead", name: "נקבע שיעור ניסיון", status: "נקבע שיעור ניסיון" },
      { object_type: "lead", name: "ממתינים לפתיחת קבוצה", status: "ממתין לפתיחת קבוצה" },
    ],
  },
];

/** Every template the screens offer: the kits first, then the FLD-05 templates of the sign-up industries. */
export const ALL_TEMPLATES: readonly IndustryTemplate[] = [...INDUSTRY_KITS.map((k) => k.template), ...INDUSTRY_TEMPLATES];

export function industryKit(key: string | null | undefined): IndustryKit | null {
  return INDUSTRY_KITS.find((k) => k.template.industry === key) ?? null;
}

/** A template by key, kits included. */
export function anyTemplate(key: string | null | undefined): IndustryTemplate | null {
  return ALL_TEMPLATES.find((t) => t.industry === key) ?? null;
}

// the kit offered first for a sign-up industry (else that industry's own template)
const KIT_OF_INDUSTRY: Readonly<Record<string, string>> = { health: "clinic", education: "studio" };

export function suggestedTemplateKey(industry: string | null | undefined): string | null {
  if (!industry) return null;
  return KIT_OF_INDUSTRY[industry] ?? anyTemplate(industry)?.industry ?? null;
}

// ---------------------------------------------------------------------------
// Preview of a kit's extras, by the rules of public.apply_industry_template
// ---------------------------------------------------------------------------

export type KitExisting = {
  meetingTypes: string[];
  messageTemplates: string[];
  whatsappTemplates: string[];
  forms: string[];
  // names of the organization-wide lead views
  leadViews: string[];
  // whether the plan holds punch cards (punch card products are added only then)
  punchCards: boolean;
};

export type KitPreview = {
  meetingTypes: string[];
  messageTemplates: string[];
  whatsappTemplates: string[];
  form: string | null;
  views: string[];
};

// lower(btrim(name)): the tables with a unique index on lower(name)
const foldName = (name: string): string => normName(name).toLowerCase();

const missingBy = (fold: (n: string) => string, names: string[], have: string[]) => {
  const seen = new Set(have.map(fold));
  return names.filter((name) => {
    const n = fold(name);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
};

export type AnyTemplatePreview = { preview: TemplatePreview; kit: KitPreview | null };

/** The template preview of any key (a kit's products instead of TEMPLATE_PRODUCTS) and, for a kit, its extras. */
export function previewAny(key: string, existing: ExistingLists, kitExisting: KitExisting): AnyTemplatePreview | null {
  const kit = industryKit(key);
  const template = kit?.template ?? anyTemplate(key);
  if (!template) return null;
  const preview = previewTemplate(template, existing);
  if (!kit) return { preview, kit: null };
  const products =
    existing.products === null
      ? []
      : kit.products
          .filter((p) => p.kind !== "punch_card" || kitExisting.punchCards)
          .filter((p) => !existing.products!.some((name) => normName(name) === normName(p.name)))
          .map((p) => ({ name: p.name, kind: p.kind === "punch_card" ? ("service" as const) : p.kind, price_agorot: p.price_agorot, billing: p.billing }));
  const form = hasName(kitExisting.forms, kit.form.name) ? null : kit.form.name;
  return {
    preview: { ...preview, products },
    kit: {
      meetingTypes: missingBy(foldName, kit.meeting_types.map((m) => m.name), kitExisting.meetingTypes),
      messageTemplates: missingBy(foldName, kit.message_templates.map((m) => m.name), kitExisting.messageTemplates),
      whatsappTemplates: missingBy(foldName, kit.whatsapp_templates.map((m) => m.name), kitExisting.whatsappTemplates),
      form,
      // a view needs its lead status: one the business has or the kit adds (the SQL skips the view otherwise)
      views: missingBy(
        normName,
        kit.views
          .filter((v) => [...existing.statuses, ...kit.template.statuses].some((name) => normName(name) === normName(v.status)))
          .map((v) => v.name),
        kitExisting.leadViews,
      ),
    },
  };
}

function hasName(names: string[], name: string): boolean {
  return names.some((n) => normName(n) === normName(name));
}

export function kitPreviewIsEmpty(kit: KitPreview | null): boolean {
  return (
    !kit ||
    (kit.meetingTypes.length === 0 && kit.messageTemplates.length === 0 && kit.whatsappTemplates.length === 0 && kit.form === null && kit.views.length === 0)
  );
}
