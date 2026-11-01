import { z } from "zod";

// QUO-09 (owner, 18 October 2026, answer 18): the customer accepts and signs, or declines, on the quote's page.

/**
 * The checkbox wording an acceptance agrees to. DRAFT: legal wording drafted by Claude Code, to be edited by the lawyer
 * (owner's decision of 8 October 2026; DECISIONS.md, QUO-09). Any change to the text gets a new version string, which is
 * stored with every acceptance.
 */
export const ACCEPT_WORDING = "קראתי את הצעת המחיר ואת התנאים שבה, ואני מאשר/ת אותה. החתימה שלי כאן מחייבת כמו חתימה בכתב יד.";
export const ACCEPT_WORDING_VERSION = "draft-2026-10-18";

export const SIGNATURE_IMAGE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
export const SIGNATURE_IMAGE_MAX = 300_000;
export const REASON_MAX = 1000;
// a quote holds at most 200 lines (quote_lines:max)
export const OPTIONAL_KEYS_MAX = 200;

/** What the page posts; the database checks every field again. */
export const decisionBodySchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("accepted"),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    signerName: z.string().trim().min(2).max(120),
    idNumber: z.string().trim().max(12).nullable(),
    signatureKind: z.enum(["drawn", "typed"]),
    signatureImage: z.string().max(SIGNATURE_IMAGE_MAX).regex(SIGNATURE_IMAGE).nullable(),
    agreed: z.literal(true),
    // QUO-08 (owner, 1 November 2026): the optional lines ticked, by their 1-based place in the page's list of lines, and the
    // total the page showed for that choice. Both or neither (an order's page sends neither).
    optionalKeys: z.array(z.number().int().min(1).max(OPTIONAL_KEYS_MAX)).max(OPTIONAL_KEYS_MAX).optional(),
    acceptedTotalAgorot: z.number().int().min(0).optional(),
  }).refine((body) => (body.optionalKeys === undefined) === (body.acceptedTotalAgorot === undefined), {
    message: "the choice and its total go together",
  }),
  z.object({
    decision: z.literal("rejected"),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().trim().max(REASON_MAX).nullable(),
  }),
]);
export type DecisionBody = z.infer<typeof decisionBodySchema>;

export type DecisionStatus = "accepted" | "rejected" | "already_decided" | "closed" | "changed" | "invalid" | "rate_limited";

/** The Hebrew answer the page shows for each outcome. */
export const DECISION_MESSAGES: Record<DecisionStatus, string> = {
  accepted: "תודה! ההצעה אושרה ונחתמה.",
  rejected: "התשובה נשמרה. תודה שעדכנת.",
  already_decided: "כבר התקבלה תשובה על ההצעה הזאת.",
  // owner, 19 October 2026: only an open quote is decided; a cancelled or expired one shows its status page
  closed: "ההצעה כבר לא פתוחה לתשובה. רעננו את הדף.",
  changed: "ההצעה התעדכנה בזמן שהיא הייתה פתוחה. בדקו את הגרסה העדכנית ונסו שוב.",
  invalid: "חלק מהפרטים לא תקינים. בדקו את השם, תעודת הזהות, החתימה ושורות הרשות שבחרתם.",
  rate_limited: "היו יותר מדי ניסיונות בזמן קצר. נסו שוב בעוד כמה דקות.",
};

export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return typeof value === "string" && Object.hasOwn(DECISION_MESSAGES, value);
}

const versionSchema = z.object({
  number: z.string().nullable(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  // QUO-08: an accepted quote whose accepted choice differs from what was sent (absent before 021117 and on other quotes)
  pdf_as_sent: z.boolean().optional(),
});

/**
 * public.quote_public_version's answer, checked against the number the page drew: the fingerprint only when it belongs to
 * the version on screen (a sent version is frozen and has a number of its own), else null (no decision offered).
 */
export function publicVersionFingerprint(data: unknown, shownNumber: string | null): string | null {
  const parsed = versionSchema.safeParse(data);
  if (!parsed.success || parsed.data.fingerprint === null || shownNumber === null) return null;
  return parsed.data.number === shownNumber ? parsed.data.fingerprint : null;
}

// QUO-08 (owner, 1 November 2026, answer (28) א): a question to the rep from the quote's page --------------------------------

export const QUESTION_MAX = 500;

export const QUESTION_MAX_LINES = 20;

// zero-width characters (U+200B-U+200D, U+FEFF) and bidi controls (U+200E/U+200F, U+202A-U+202E, U+2066-U+2069) go
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
// the other C0 controls, DEL and the C1 controls become spaces; the line break stays
const CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

/**
 * The question as it is stored: the same cleaning as public.quote_public_question (keep the two in step), then trimmed of
 * spaces and line breaks. Null when nothing is left, or it is over 500 characters or 20 lines.
 */
export function questionText(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(CONTROLS, " ")
    .replace(/^[ \n]+|[ \n]+$/g, "");
  if (text.length === 0 || [...text].length > QUESTION_MAX || text.split("\n").length > QUESTION_MAX_LINES) return null;
  return text;
}

/** What the page posts, cleaned as it will be stored; the database cleans and checks it again. */
export const questionBodySchema = z.object({
  text: z
    .string()
    .max(QUESTION_MAX * 4)
    .transform((raw, ctx) => {
      const text = questionText(raw);
      if (text === null) {
        ctx.addIssue({ code: "custom", message: "invalid question" });
        return z.NEVER;
      }
      return text;
    }),
});

export type QuestionStatus = "sent" | "invalid" | "closed" | "rate_limited";

export const QUESTION_MESSAGES: Record<QuestionStatus, string> = {
  sent: "השאלה נשלחה. נחזור אליכם בהקדם.",
  invalid: `כתבו שאלה של עד ${QUESTION_MAX} תווים ועד ${QUESTION_MAX_LINES} שורות.`,
  closed: "אי אפשר לשלוח שאלה על ההצעה הזאת. אפשר לפנות לעסק ששלח אותה.",
  rate_limited: "נשלחו יותר מדי שאלות בזמן קצר. נסו שוב מאוחר יותר.",
};

export function isQuestionStatus(value: unknown): value is QuestionStatus {
  return typeof value === "string" && Object.hasOwn(QUESTION_MESSAGES, value);
}

/**
 * QUO-08 (interim, until the owner decides about the PDF): whether the stored PDF of the accepted quote on screen shows the
 * quote as sent rather than as accepted, from public.quote_public_version, only for the version the page drew.
 */
export function publicVersionPdfAsSent(data: unknown, shownNumber: string | null): boolean {
  const parsed = versionSchema.safeParse(data);
  if (!parsed.success || shownNumber === null || parsed.data.number !== shownNumber) return false;
  return parsed.data.pdf_as_sent === true;
}

/** The customer's and the staff's link text for the stored PDF when it is not what was accepted. */
export const PDF_AS_SENT_PUBLIC = "המסמך כפי שנשלח (לפני הבחירה שלכם)";
export const PDF_AS_SENT_STAFF = "הורדת PDF (כפי שנשלח)";
