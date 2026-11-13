// VRT-02: a marketing page per industry kit (WEB-01's industry pages), in that industry's words. Everything the page says the
// kit sets up is read from INDUSTRY_KITS (VRT-01), and the pictures are drawn from the kit's own sample data (VRT-03,
// SAMPLE_KIT_CONTENT), so the page never drifts from what a business really gets.
//
// DRAFT marketing wording (LND-02/03): the owner corrects it. No price is promised here: the page links to the landing page's
// price list. The clinic page holds NO health or medical content: tests/unit/industry-pages checks every text of the page
// (and the component's own) against the closed medical word list of tests/unit/industry-kits.

import { INDUSTRY_KITS, type IndustryKit, type KitMeetingType } from "@/features/industry-templates/kits";
import { SAMPLE_KIT_CONTENT, type SampleKitContent, type SampleKitKey } from "@/features/setup/sample-kits";

export type IndustryPageKey = SampleKitKey;

/** The industry pages, in the order the landing page lists them. */
export const INDUSTRY_PAGE_KEYS: readonly IndustryPageKey[] = ["clinic", "studio"];

export const isIndustryPageKey = (key: string): key is IndustryPageKey => (INDUSTRY_PAGE_KEYS as readonly string[]).includes(key);

type Copy = {
  /** the short name on links and in the page title */
  label: string;
  /** what the landing page's card says under the name */
  teaser: string;
  eyebrow: string;
  title: string;
  lead: string;
  description: string;
  /** how the industry calls the people it serves (the picture headings) */
  people: string;
  steps: Array<{ title: string; text: string }>;
};

// DRAFT (LND-02/03): the owner's corrections replace these texts
const COPY: Readonly<Record<IndustryPageKey, Copy>> = {
  clinic: {
    label: "קליניקות",
    teaser: "תורים, סדרות טיפולים וכרטיסיות, מוכנים מהיום הראשון.",
    eyebrow: "לקליניקות ולמטפלים",
    title: "כל פנייה מקבלת תור, ואף מטופל לא נשכח",
    lead: "ערכה מוכנה לקליניקה: שלבי המעקב, סוגי התורים, כרטיסיית טיפולים, תבניות הודעה וטופס לקביעת תור. מתחילים לעבוד מהיום הראשון, ומשנים מה שרוצים.",
    description: "Mexuz לקליניקות: ערכה מוכנה עם שלבי מעקב, סוגי תורים, כרטיסיות טיפולים, תבניות הודעה וטופס לקביעת תור. בעברית, בטלפון ובמחשב.",
    people: "מטופלים",
    steps: [
      { title: "נרשמים ובוחרים את ערכת הקליניקה", text: "בשלב ההקמה בוחרים \"ערכה או תבנית\". הערכה מוסיפה רק מה שחסר, ולא דורסת שום דבר שכבר הגדרתם." },
      { title: "משתפים את טופס קביעת התור", text: "הטופס נוסף כבוי. מדליקים אותו ומשתפים קישור, כפתור לאתר או קוד QR, וכל פנייה נכנסת לרשימה אחת." },
      { title: "עובדים מהיומן ומהטלפון", text: "חיוג ו-WhatsApp בלחיצה, תבניות לאישור ולתזכורת תור, וכרטיסייה שמתעדכנת אחרי כל טיפול." },
    ],
  },
  studio: {
    label: "סטודיו וקורסים",
    teaser: "שיעורי ניסיון, מנויים, קורסים וכרטיסיות שיעורים.",
    eyebrow: "לסטודיו, לחוגים ולקורסים",
    title: "מי שביקש שיעור ניסיון, מגיע לשיעור ונשאר",
    lead: "ערכה מוכנה לסטודיו: שלבי ההרשמה, שיעורי ניסיון, שיעורים קבוצתיים ופרטיים, כרטיסיית שיעורים, תבניות הודעה וטופס הרשמה. מתחילים לעבוד מהיום הראשון, ומשנים מה שרוצים.",
    description: "Mexuz לסטודיו ולקורסים: ערכה מוכנה עם שלבי הרשמה, שיעורי ניסיון, כרטיסיות שיעורים, תבניות הודעה וטופס הרשמה. בעברית, בטלפון ובמחשב.",
    people: "תלמידים",
    steps: [
      { title: "נרשמים ובוחרים את ערכת הסטודיו", text: "בשלב ההקמה בוחרים \"ערכה או תבנית\". הערכה מוסיפה רק מה שחסר, ולא דורסת שום דבר שכבר הגדרתם." },
      { title: "משתפים את טופס שיעור הניסיון", text: "הטופס נוסף כבוי. מדליקים אותו ומשתפים קישור, כפתור לאתר או קוד QR, וכל פנייה נכנסת לרשימה אחת." },
      { title: "עובדים מהיומן ומהטלפון", text: "חיוג ו-WhatsApp בלחיצה, תבניות לאישור ולתזכורת שיעור, וכרטיסייה שמתעדכנת אחרי כל שיעור." },
    ],
  },
};

const FORMATS: Readonly<Record<KitMeetingType["meeting_format"], string>> = {
  in_person: "פגישה במקום",
  phone: "בטלפון",
  video: "בווידאו",
  other: "אחר",
};

const CHANNELS = { email: "מייל", sms: "SMS", whatsapp: "WhatsApp" } as const;

export type KitSetupGroup = { key: string; title: string; note: string | null; items: string[] };

export type IndustryPage = {
  key: IndustryPageKey;
  copy: Copy;
  setup: KitSetupGroup[];
  pictures: {
    board: { title: string; columns: Array<{ stage: string; cards: Array<{ name: string; line: string }> }> };
    leads: { title: string; rows: Array<{ name: string; status: string; line: string }> };
    day: { title: string; rows: Array<{ time: string; name: string; type: string; minutes: number }> };
    card: { title: string; holder: string; used: number; entries: number; validity: string } | null;
  };
};

const kitOf = (key: IndustryPageKey): IndustryKit => {
  const kit = INDUSTRY_KITS.find((k) => k.template.industry === key);
  if (!kit) throw new Error(`industry kit ${key} is missing`);
  return kit;
};

const sampleOf = (key: IndustryPageKey): SampleKitContent => {
  const sample = SAMPLE_KIT_CONTENT.find((c) => c.kit === key);
  if (!sample) throw new Error(`sample data of ${key} is missing`);
  return sample;
};

const validityText = (count: number, unit: "days" | "months") =>
  unit === "months" ? (count === 1 ? "תוקף חודש" : `תוקף ${count} חודשים`) : count === 1 ? "תוקף יום" : `תוקף ${count} ימים`;

/** What the kit sets up, read from the kit itself (names only: no price, the price list is on the landing page). */
export function kitSetup(kit: IndustryKit): KitSetupGroup[] {
  const t = kit.template;
  const punchCards = kit.products.filter((p) => p.kind === "punch_card" && p.punch);
  const services = kit.products.filter((p) => p.kind !== "punch_card");
  const groups: KitSetupGroup[] = [
    { key: "pipeline", title: t.pipeline ? `תהליך מכירה: ${t.pipeline.name}` : "תהליך מכירה", note: null, items: t.pipeline?.stages.map((s) => s.name) ?? [] },
    { key: "statuses", title: "סטטוסים לפניות", note: null, items: [...t.statuses] },
    { key: "sources", title: "מקורות פניות", note: null, items: [...t.sources] },
    { key: "meeting_types", title: "סוגי פגישות ביומן", note: null, items: kit.meeting_types.map((m) => `${m.name} · ${m.duration_minutes} דק' · ${FORMATS[m.meeting_format]}`) },
    {
      key: "punch_cards",
      title: "כרטיסיות",
      note: "בחבילות שכוללות כרטיסיות. כניסה נרשמת כשפגישה מהסוג המתאים מתקיימת.",
      items: punchCards.map((p) => `${p.name} · ${p.punch!.entries} כניסות · ${validityText(p.punch!.validity_count, p.punch!.validity_unit)}`),
    },
    { key: "services", title: "שירותים בקטלוג", note: "המחירים לדוגמה, ומשנים אותם בקטלוג.", items: services.map((p) => p.name) },
    {
      key: "messages",
      title: "תבניות הודעה",
      note: "נוסח ראשוני שמשנים בהגדרות.",
      items: [
        ...kit.message_templates.map((m) => `${m.name} (${CHANNELS[m.channel]})`),
        ...kit.whatsapp_templates.map((w) => `${w.name} (WhatsApp)`),
      ],
    },
    { key: "fields", title: "שדות שלכם", note: null, items: t.fields.map((f) => f.label) },
    { key: "form", title: "טופס לאתר", note: "נוסף כבוי, ומדליקים כשמוכנים.", items: [kit.form.title] },
    { key: "views", title: "תצוגות שמורות", note: null, items: kit.views.map((v) => v.name) },
    { key: "automations", title: "אוטומציות", note: "נוספות כבויות, ומדליקים כשרוצים.", items: t.automations.map((a) => a.name) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

// invented times of day for the calendar picture (demo only)
const DAY_TIMES = ["09:00", "10:00", "11:30", "13:00"];

export function industryPage(key: IndustryPageKey): IndustryPage {
  const kit = kitOf(key);
  const sample = sampleOf(key);
  const copy = COPY[key];
  const stages = (kit.template.pipeline?.stages ?? []).filter((s) => s.kind === "open");
  const dealContact = sample.contacts.find((c) => c.key === sample.deal.contact);
  const contactName = (c: { first_name: string; last_name: string }) => `${c.first_name} ${c.last_name}`;
  // the board: the first two open stages hold the sample leads, the third column is the sample deal's own stage
  const dealStage = stages.find((s) => s.name === sample.deal.stage) ?? stages[2];
  const columns = [...stages.slice(0, 2), ...(dealStage ? [dealStage] : [])].map((stage) => ({
    stage: stage.name,
    cards: [] as Array<{ name: string; line: string }>,
  }));
  const leadColumns = Math.max(1, Math.min(2, columns.length - (dealStage ? 1 : 0)));
  sample.leads.forEach((lead, i) => columns[i % leadColumns]?.cards.push({ name: lead.full_name, line: lead.source }));
  if (dealStage) columns[columns.length - 1].cards.push({ name: sample.deal.name, line: dealContact ? contactName(dealContact) : "" });
  const firstField = kit.template.fields.find((f) => f.object_type === "lead" && f.field_type === "select");
  const leadRows = sample.leads.map((lead) => {
    const value = firstField ? lead.custom_fields[firstField.key] : undefined;
    return { name: lead.full_name, status: lead.status, line: typeof value === "string" ? value : lead.source };
  });
  const people = [...sample.leads.map((l) => l.full_name), ...sample.contacts.map(contactName)];
  const dayRows = kit.meeting_types.map((m, i) => ({ time: DAY_TIMES[i % DAY_TIMES.length], name: people[i % people.length], type: m.name, minutes: m.duration_minutes }));
  const cardProduct = sample.punch_card ? kit.products.find((p) => p.name === sample.punch_card!.product && p.punch) : undefined;
  const cardHolder = sample.punch_card ? sample.contacts.find((c) => c.key === sample.punch_card!.contact) : undefined;
  return {
    key,
    copy,
    setup: kitSetup(kit),
    pictures: {
      board: { title: kit.template.pipeline?.name ?? "תהליך מכירה", columns },
      leads: { title: "פניות", rows: leadRows },
      day: { title: "היומן של היום", rows: dayRows },
      card:
        cardProduct?.punch && cardHolder
          ? {
              title: cardProduct.name,
              holder: contactName(cardHolder),
              // invented progress for the picture (demo only)
              used: Math.min(3, cardProduct.punch.entries),
              entries: cardProduct.punch.entries,
              validity: validityText(cardProduct.punch.validity_count, cardProduct.punch.validity_unit),
            }
          : null,
    },
  };
}

/** Every text an industry page shows (the medical-words test reads this). */
export function industryPageTexts(page: IndustryPage): string[] {
  const p = page.pictures;
  return [
    ...Object.values(page.copy).flatMap((v) => (typeof v === "string" ? [v] : v.flatMap((s) => [s.title, s.text]))),
    ...page.setup.flatMap((g) => [g.title, g.note ?? "", ...g.items]),
    p.board.title,
    ...p.board.columns.flatMap((c) => [c.stage, ...c.cards.flatMap((card) => [card.name, card.line])]),
    p.leads.title,
    ...p.leads.rows.flatMap((r) => [r.name, r.status, r.line]),
    p.day.title,
    ...p.day.rows.flatMap((r) => [r.name, r.type]),
    ...(p.card ? [p.card.title, p.card.holder, p.card.validity] : []),
  ];
}

/** The landing page's cards: each industry page's name and line. */
export const INDUSTRY_PAGE_LINKS = INDUSTRY_PAGE_KEYS.map((key) => ({ key, label: COPY[key].label, teaser: COPY[key].teaser }));
