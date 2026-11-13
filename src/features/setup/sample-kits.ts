// VRT-03: sample data by industry (extends USR-04). A business that applied an industry kit (VRT-01), or picked an
// industry that has one, gets sample records in that industry's words: a clinic sees inquiries, clients and a series of
// sessions, a studio sees students, a course and (with the plan key punch_cards) a punch card. Every other business gets
// the generic USR-04 set, unchanged.
//
// The database adds them (public.sample_data_add) from its own copy, app.sample_kit_content(kit) in the sample data by
// industry migration. The two must stay equal: tests/db/358-sample-data-kits compares them. Which kit a business gets is
// app.sample_kit(org), mirrored by sampleDataKit() below.
//
// DRAFT wording. The clinics set holds NO health or medical content: tests/unit/sample-kits and tests/db/356-industry-kits
// check every text against the closed list of medical words. Names are invented, addresses are @example.com, no phones.
//
// Statuses, sources, the pipeline and its stage, custom fields and the punch card product are looked up by name in the
// business (the kit's own names); a missing one falls back to the generic choice (status, source, pipeline) or is left out
// (custom field, punch card). A custom field value is written only while the field is active and the value fits it.

export type SampleKitKey = "clinic" | "studio";

export type SampleLead = {
  key: string;
  full_name: string;
  email: string;
  status: string;
  source: string;
  message: string | null;
  custom_fields: Record<string, string | number | string[]>;
};

export type SampleContact = {
  key: string;
  first_name: string;
  last_name: string;
  email: string;
  city: string | null;
  custom_fields: Record<string, string | number | string[]>;
};

export type SampleDeal = {
  name: string;
  amount_agorot: number;
  pipeline: string;
  stage: string;
  // the key of one of the set's contacts
  contact: string;
  custom_fields: Record<string, string | number | string[]>;
};

export type SampleTask = {
  title: string;
  task_type: "call" | "todo";
  due_minutes: number;
  // what the task is on: one of the set's leads, else the deal (contact when there is no deal)
  lead: string | null;
  deal: boolean;
};

export type SampleKitContent = {
  kit: SampleKitKey;
  leads: SampleLead[];
  contacts: SampleContact[];
  deal: SampleDeal;
  tasks: SampleTask[];
  // opened active by hand on that contact, only with the plan key punch_cards and the product in the catalog
  punch_card: { contact: string; product: string } | null;
};

// the line every first sample lead carries, as in the generic set
const REMOVE_LINE = "אפשר למחוק את כל נתוני הדוגמה בלחיצה מרשימת ההקמה.";

export const SAMPLE_KIT_CONTENT: readonly SampleKitContent[] = [
  {
    kit: "clinic",
    leads: [
      {
        key: "l1",
        full_name: "רונית כהן",
        email: "ronit@example.com",
        status: "ממתין לתור",
        source: "גוגל",
        message: `רוצה לקבוע פגישת היכרות. פנייה לדוגמה. ${REMOVE_LINE}`,
        custom_fields: { treatment_type: "פגישת היכרות", referral_source: "אינטרנט" },
      },
      {
        key: "l2",
        full_name: "אלון מזרחי",
        email: "alon@example.com",
        status: "ביקש שיחה חוזרת",
        source: "הפניה מגורם מקצועי",
        message: "מבקש לשמוע על סדרת טיפולים ועל שעות הקבלה. פנייה לדוגמה.",
        custom_fields: { treatment_type: "סדרת טיפולים", referral_source: "איש או אשת מקצוע" },
      },
      {
        key: "l3",
        full_name: "שירה גולן",
        email: "shira@example.com",
        status: "נקבע תור",
        source: "אינסטגרם",
        message: null,
        custom_fields: { treatment_type: "טיפול בודד", preferred_therapist: "דנה" },
      },
    ],
    contacts: [
      { key: "c1", first_name: "יעל", last_name: "ברגר", email: "yael@example.com", city: "רמת גן", custom_fields: { preferred_time: "בוקר" } },
      { key: "c2", first_name: "משה", last_name: "פרידמן", email: "moshe@example.com", city: "ירושלים", custom_fields: { preferred_time: "ערב" } },
    ],
    deal: {
      name: "סדרת 10 טיפולים",
      amount_agorot: 270000,
      pipeline: "טיפולים בקליניקה",
      stage: "בסדרת טיפולים",
      contact: "c1",
      custom_fields: { sessions_count: 10 },
    },
    tasks: [
      { title: "להתקשר לרונית כהן לתיאום פגישת היכרות", task_type: "call", due_minutes: 120, lead: "l1", deal: false },
      { title: "לתאם עם יעל ברגר את התור הבא בסדרה", task_type: "todo", due_minutes: 1440, lead: null, deal: true },
    ],
    punch_card: { contact: "c1", product: "כרטיסייה ל-10 טיפולים" },
  },
  {
    kit: "studio",
    leads: [
      {
        key: "l1",
        full_name: "נועם אלמוג",
        email: "noam@example.com",
        status: "נקבע שיעור ניסיון",
        source: "אינסטגרם",
        message: `רוצה לנסות שיעור ניסיון בקבוצת מתחילים. פנייה לדוגמה. ${REMOVE_LINE}`,
        custom_fields: { level: "מתחילים", track: "כרטיסייה", preferred_days: ["ראשון", "רביעי"] },
      },
      {
        key: "l2",
        full_name: "הילה שגב",
        email: "hila@example.com",
        status: "ממתין לפתיחת קבוצה",
        source: "חבר מביא חבר",
        message: "שואלת מתי נפתחת קבוצת ערב. פנייה לדוגמה.",
        custom_fields: { level: "ממשיכים", track: "שיעורים קבועים" },
      },
      {
        key: "l3",
        full_name: "תומר וייס",
        email: "tomer@example.com",
        status: "הגיע לשיעור ניסיון",
        source: "פייסבוק",
        message: null,
        custom_fields: { track: "קורס" },
      },
    ],
    contacts: [
      { key: "c1", first_name: "מאיה", last_name: "ברק", email: "maya@example.com", city: "חיפה", custom_fields: {} },
      { key: "c2", first_name: "עידו", last_name: "שמש", email: "ido@example.com", city: "כפר סבא", custom_fields: { parent_name: "רינת שמש" } },
    ],
    deal: {
      name: "קורס מתחילים",
      amount_agorot: 120000,
      pipeline: "הרשמה לסטודיו",
      stage: "ממתין לתשלום",
      contact: "c2",
      custom_fields: {},
    },
    tasks: [
      { title: "לתאם שיעור ניסיון עם נועם אלמוג", task_type: "call", due_minutes: 120, lead: "l1", deal: false },
      { title: "לשלוח לעידו שמש את פרטי הפתיחה של הקורס", task_type: "todo", due_minutes: 1440, lead: null, deal: true },
    ],
    punch_card: { contact: "c1", product: "כרטיסייה ל-10 שיעורים" },
  },
];

export function sampleKitContent(kit: string | null | undefined): SampleKitContent | null {
  return SAMPLE_KIT_CONTENT.find((c) => c.kit === kit) ?? null;
}

// the kit offered for a sign-up industry (the rule of KIT_OF_INDUSTRY in industry-templates/kits.ts)
const KIT_OF_INDUSTRY: Readonly<Record<string, SampleKitKey>> = { health: "clinic", education: "studio" };

/**
 * Which industry's sample data a business gets (= app.sample_kit): the kit it applied last, else the kit of the
 * industry it picked at sign-up, else none (the generic set).
 */
export function sampleDataKit(org: { industry: string | null; industry_templates: readonly string[] }): SampleKitKey | null {
  for (let i = org.industry_templates.length - 1; i >= 0; i -= 1) {
    const key = org.industry_templates[i];
    if (key === "clinic" || key === "studio") return key;
  }
  return (org.industry && KIT_OF_INDUSTRY[org.industry]) || null;
}

// how the set is described before it is added, in the industry's words
const WORDS: Readonly<Record<SampleKitKey, { leads: string; contacts: string; deal: string; card: string }>> = {
  clinic: { leads: "פניות", contacts: "מטופלים", deal: "סדרת טיפולים", card: "כרטיסייה" },
  studio: { leads: "פניות", contacts: "תלמידים", deal: "הרשמה לקורס", card: "כרטיסייה" },
};

/** The line beside "הוספת נתוני דוגמה"; the generic one when the business has no kit. */
export function sampleDataBlurb(kit: SampleKitKey | null): string {
  const content = sampleKitContent(kit);
  if (!kit || !content) {
    return "רוצים לראות איך זה נראה? אפשר להוסיף כמה לידים, אנשי קשר ועסקה לדוגמה, ולמחוק אותם בלחיצה.";
  }
  const w = WORDS[kit];
  const people = content.contacts.map((c) => `${c.first_name} ${c.last_name}`).join(" ו");
  const card = content.punch_card ? ` ו${w.card} (כשהיא בחבילה)` : "";
  return `רוצים לראות איך זה נראה? אפשר להוסיף ${content.leads.length} ${w.leads}, ${content.contacts.length} ${w.contacts} (${people}), ${w.deal}${card} לדוגמה, ולמחוק אותם בלחיצה.`;
}
