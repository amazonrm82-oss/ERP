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
  invalid: "חלק מהפרטים לא תקינים. בדקו את השם, תעודת הזהות והחתימה.",
  rate_limited: "היו יותר מדי ניסיונות בזמן קצר. נסו שוב בעוד כמה דקות.",
};

export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return typeof value === "string" && Object.hasOwn(DECISION_MESSAGES, value);
}

const versionSchema = z.object({ number: z.string().nullable(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable() });

/**
 * public.quote_public_version's answer, checked against the number the page drew: the fingerprint only when it belongs to
 * the version on screen (a sent version is frozen and has a number of its own), else null (no decision offered).
 */
export function publicVersionFingerprint(data: unknown, shownNumber: string | null): string | null {
  const parsed = versionSchema.safeParse(data);
  if (!parsed.success || parsed.data.fingerprint === null || shownNumber === null) return null;
  return parsed.data.number === shownNumber ? parsed.data.fingerprint : null;
}
