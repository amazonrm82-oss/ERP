import type { Gender } from "@/features/gender/gender";
import { pickVariants } from "@/features/whatsapp/variants";

// MSG-02: the merge fields a shared message template may hold, a CLOSED list. The database refuses any other
// {text} (without ":" or "|") in a template's subject or body (app.message_unknown_field over app.message_merge_fields(),
// migration message_templates, the list last redefined in service_template_rule; hint message_template:field);
// tests/unit/message-templates.test.ts reads the latest migration
// and keeps the two lists and the pattern equal. The first nine are WA-01's placeholders (src/features/whatsapp/templates.ts);
// {קישור להצעה} is the customer's quote link (QUO-08), filled only by a sender that made the link; the last five came with
// the owner's answer (88).

export const MESSAGE_MERGE_FIELDS = {
  firstName: { token: "{שם פרטי}", label: "השם הפרטי של הלקוח" },
  fullName: { token: "{שם מלא}", label: "השם המלא של הלקוח" },
  userName: { token: "{שם הנציג}", label: "השם של הנציג ששולח" },
  businessName: { token: "{שם העסק}", label: "שם העסק" },
  date: { token: "{תאריך}", label: "תאריך הפגישה, או בכרטיסייה היום האחרון שלה" },
  time: { token: "{שעה}", label: "שעת הפגישה" },
  document: { token: "{מסמך}", label: "המסמך (סוג ומספר), בגבייה" },
  amount: { token: "{סכום}", label: "הסכום לתשלום, בגבייה" },
  dueDate: { token: "{מועד תשלום}", label: "מועד התשלום, בגבייה" },
  quoteLink: { token: "{קישור להצעה}", label: "הקישור שבו הלקוח רואה את הצעת המחיר" },
  // owner (88), 3 November 2026
  businessPhone: { token: "{טלפון העסק}", label: "הטלפון של העסק" },
  businessAddress: { token: "{כתובת העסק}", label: "הכתובת של העסק" },
  validUntil: { token: "{תוקף}", label: "עד מתי הצעת המחיר בתוקף" },
  updateContent: { token: "{תוכן העדכון}", label: "תוכן העדכון, בהודעה שיווקית" },
  unsubscribeLink: { token: "{קישור הסרה}", label: "קישור להסרה מרשימת התפוצה (המערכת מוסיפה אותו לכל הודעה שיווקית)" },
  // owner (90) ג, 3 November 2026 (migration service_template_rule): the code a verification code message carries
  verificationCode: { token: "{קוד אימות}", label: "קוד האימות, בהודעת קוד אימות" },
  // PKG-03 (owner (127) ב, 4 November 2026; migration punch_card_notice_messages): a punch card notice
  cardName: { token: "{שם הכרטיסייה}", label: "שם הכרטיסייה, בהודעת כרטיסייה" },
  entriesLeft: { token: "{כניסות}", label: "הכניסות שנשארו, כמשפט (\"נשארו 3 כניסות\"), בהודעת כרטיסייה" },
} as const;

export type MergeFieldKey = keyof typeof MESSAGE_MERGE_FIELDS;
export type MergeValues = Partial<Record<MergeFieldKey, string | null>> & {
  gender?: Gender | null;
};

/** The field names without braces, in order (= app.message_merge_fields()). */
export const MERGE_FIELD_NAMES: readonly string[] = (Object.keys(MESSAGE_MERGE_FIELDS) as MergeFieldKey[]).map((key) =>
  MESSAGE_MERGE_FIELDS[key].token.slice(1, -1),
);

const NAME_TO_KEY = new Map<string, MergeFieldKey>(
  (Object.keys(MESSAGE_MERGE_FIELDS) as MergeFieldKey[]).map((key) => [MESSAGE_MERGE_FIELDS[key].token.slice(1, -1), key]),
);

// the same pattern as app.message_unknown_field: braces around 1..30 characters with no brace, ":", "|" or line break
// (a HEB-01 gender block always holds ":", so it is never read as a field)
export const MERGE_FIELD_PATTERN = /\{([^{}:|\n]{1,30})\}/g;

/** Every {text} of a text that is not a merge field, in order, each once. */
export function unknownMergeFields(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MERGE_FIELD_PATTERN)) {
    if (!NAME_TO_KEY.has(match[1])) found.add(match[0]);
  }
  return [...found];
}

/**
 * Picks each gender block's wording (HEB-01: by values.gender, neutral when it is not male or female), then replaces
 * every merge field that has a value. A field without a value stays as it is, so the reader sees what a sender fills.
 */
export function fillMessage(text: string, values: MergeValues): string {
  return pickVariants(text, values.gender).replace(MERGE_FIELD_PATTERN, (token, name: string) => {
    const key = NAME_TO_KEY.get(name);
    const value = key ? values[key]?.trim() : undefined;
    return value ? value : token;
  });
}

/** The merge fields still in a filled text, in order, each once. */
export function unfilledMergeFields(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MERGE_FIELD_PATTERN)) {
    if (NAME_TO_KEY.has(match[1])) found.add(match[0]);
  }
  return [...found];
}
