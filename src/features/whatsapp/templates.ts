import type { TimelineSubject } from "@/features/activities/schema";
import { mentionAt, mentionIds } from "@/features/mentions/token";

// WA-01: WhatsApp text templates, sent one by one through a wa.me link (no provider).
// Pure functions only: used by the record button, the settings page, and GAP-03
// (a reminder of tomorrow's meeting), which fills {תאריך} and {שעה} as well.

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_BODY_MAX = 1000;
// the database refuses more (trigger whatsapp_templates_cap, hint 'whatsapp_templates:max')
export const TEMPLATES_PER_ORG = 50;
// what the person may send in one message (the link carries it in the URL)
export const MESSAGE_MAX = 2000;

// the default template the seed marks with kind 'meeting_reminder' (GAP-03 offers it first)
export const MEETING_REMINDER_KIND = "meeting_reminder";
// COL-04: the default template the seed marks with kind 'collection_reminder' (the collection reminder task offers it first)
export const COLLECTION_REMINDER_KIND = "collection_reminder";

/**
 * The placeholders a template may hold, written in Hebrew inside braces. Keep the
 * set small: the record button fills the first four; {תאריך} and {שעה} are filled
 * only where there is a meeting (GAP-03), and otherwise stay for the person to complete.
 */
export const PLACEHOLDERS = {
  firstName: { token: "{שם פרטי}", label: "השם הפרטי של הלקוח" },
  fullName: { token: "{שם מלא}", label: "השם המלא של הלקוח" },
  userName: { token: "{שם הנציג}", label: "השם שלכם" },
  businessName: { token: "{שם העסק}", label: "שם העסק" },
  date: { token: "{תאריך}", label: "תאריך הפגישה" },
  time: { token: "{שעה}", label: "שעת הפגישה" },
  // COL-04: filled only by a collection reminder task
  document: { token: "{מסמך}", label: "המסמך (סוג ומספר), בתזכורת גבייה" },
  amount: { token: "{סכום}", label: "הסכום לתשלום, בתזכורת גבייה" },
  dueDate: { token: "{מועד תשלום}", label: "מועד התשלום, בתזכורת גבייה" },
} as const;

export type PlaceholderKey = keyof typeof PLACEHOLDERS;
export type TemplateValues = Partial<Record<PlaceholderKey, string | null>>;

const TOKEN_KEYS = new Map<string, PlaceholderKey>(
  (Object.keys(PLACEHOLDERS) as PlaceholderKey[]).map((key) => [PLACEHOLDERS[key].token, key]),
);
const TOKEN_PATTERN = /\{[^{}\n]{1,20}\}/g;

/**
 * Replaces every known placeholder that has a value. A placeholder without a value,
 * and any other text in braces, stays as it is, so the person sees what to complete.
 */
export function fillTemplate(text: string, values: TemplateValues): string {
  return text.replace(TOKEN_PATTERN, (token) => {
    const key = TOKEN_KEYS.get(token);
    const value = key ? values[key]?.trim() : undefined;
    return value ? value : token;
  });
}

/** The known placeholders still in a text, in order, each once. */
export function missingPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (TOKEN_KEYS.has(match[0])) found.add(match[0]);
  }
  return [...found];
}

/** The first word of a name ("דנה כהן" -> "דנה"); null for an empty name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** https://wa.me/<digits>?text=... from an E.164 number; null without a usable number. */
export function whatsappMessageUrl(phoneE164: string | null | undefined, text: string): string | null {
  const digits = (phoneE164 ?? "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  const message = text.trim();
  return message ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : `https://wa.me/${digits}`;
}

// Every organization starts with these and renames or deletes them freely. The database
// seeds them (app.seed_whatsapp_templates); tests/unit/whatsapp-templates.test.ts keeps the two equal.
export const DEFAULT_TEMPLATES: ReadonlyArray<{ name: string; body: string; kind: string | null }> = [
  {
    name: "פנייה ראשונה",
    body: "שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. קיבלנו את הפנייה שלך. מתי נוח לך לדבר?",
    kind: null,
  },
  {
    name: "לא הצלחנו להשיג",
    body: "שלום {שם פרטי}, ניסיתי להתקשר אליך ולא הצלחתי להשיג. מתי נוח שאחזור אליך? {שם הנציג}, {שם העסק}",
    kind: null,
  },
  {
    name: "תזכורת לפגישה מחר",
    body: "שלום {שם פרטי}, תזכורת לפגישה שלנו מחר, {תאריך} בשעה {שעה}. אם צריך לשנות, אפשר לכתוב לי כאן. {שם הנציג}, {שם העסק}",
    kind: MEETING_REMINDER_KIND,
  },
  {
    name: "תודה על השיחה",
    body: "תודה {שם פרטי}, היה נעים לדבר. אם יש שאלות, אני כאן. {שם הנציג}, {שם העסק}",
    kind: null,
  },
  // COL-04: the owner's wording of 29 October 2026; seeded for new businesses and added once to existing ones that had none
  // (migration collection_reminders_answers)
  {
    name: "תזכורת לתשלום",
    body: "שלום {שם פרטי}, תזכורת: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה, ואפשר להתעלם מההודעה. {שם הנציג}, {שם העסק}",
    kind: COLLECTION_REMINDER_KIND,
  },
];

/**
 * The values a record page fills in: the person's names, the user's own name and the business
 * name. A first name that is not stored separately is the first word of the full name.
 */
export function recordTemplateValues(
  person: { firstName?: string | null; fullName: string | null },
  context: { user: { displayName: string }; org: { name: string } },
): TemplateValues {
  return {
    firstName: person.firstName?.trim() || firstNameOf(person.fullName),
    fullName: person.fullName,
    userName: context.user.displayName,
    businessName: context.org.name,
  };
}

/** WA-01 follow-up (owner, 14 October 2026): what a list row needs to offer the templates; null for someone who cannot write. */
export type WhatsappListContext = { orgId: string; userName: string; businessName: string };

export type WhatsappLog = { orgId: string; subject: TimelineSubject; name: string; values: TemplateValues };

/**
 * The WhatsApp button of one list row (leads, contacts, "My day"), the same flow and logging as
 * the record page. undefined for someone who cannot write or a row without a valid phone, so the
 * row falls back to the plain wa.me link (or none).
 */
export function listWhatsappLog(
  context: WhatsappListContext | null,
  row: { subject: TimelineSubject; name: string; phoneE164: string | null; firstName?: string | null; fullName: string | null },
): WhatsappLog | undefined {
  if (!context || !row.phoneE164) return undefined;
  return {
    orgId: context.orgId,
    subject: row.subject,
    name: row.name,
    values: recordTemplateValues({ firstName: row.firstName, fullName: row.fullName }, { user: { displayName: context.userName }, org: { name: context.businessName } }),
  };
}

/** The list context of an org context: null for someone who cannot write. */
export function whatsappListContext(context: { canWrite: boolean; user: { displayName: string }; org: { id: string; name: string } }): WhatsappListContext | null {
  return context.canWrite ? { orgId: context.org.id, userName: context.user.displayName, businessName: context.org.name } : null;
}

/** The place after the last template: one past the highest position (a deleted template leaves a gap). */
export function nextPosition(templates: ReadonlyArray<{ position: number }>): number {
  return templates.reduce((max, template) => Math.max(max, template.position), -1) + 1;
}

/**
 * A logged message is what the customer got, not a note: every mention token
 * (@[Name](user:<uuid>), REC-02 grammar) becomes plain "@Name", so the database never reads
 * a mention in it and nobody is notified. Repeated until no token is left.
 */
export function plainMentions(text: string): string {
  let out = text;
  while (mentionIds(out).length > 0) {
    let next = "";
    let i = 0;
    while (i < out.length) {
      const mention = out[i] === "@" ? mentionAt(out, i) : null;
      if (mention) {
        next += `@${mention.name}`;
        i += mention.length;
      } else {
        next += out[i];
        i += 1;
      }
    }
    out = next;
  }
  return out;
}
