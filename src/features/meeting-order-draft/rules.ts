import { z } from "zod";

// CAL-13 (owner 9 November 2026, answers (152) א and (153) ג): a held meeting makes a draft order with one line of the
// meeting type's product, automatically or by a button (org_document_settings.meeting_order_draft, default 'button').
// The rule itself lives in the database (app.meeting_order_draft_refusal); this file only words its answers.

export const MEETING_ORDER_DRAFT_MODES = ["button", "auto"] as const;
export type MeetingOrderDraftMode = (typeof MEETING_ORDER_DRAFT_MODES)[number];
export const MEETING_ORDER_DRAFT_DEFAULT: MeetingOrderDraftMode = "button";

export const MEETING_ORDER_DRAFT_OPTIONS: { value: MeetingOrderDraftMode; label: string; description: string }[] = [
  {
    value: "button",
    label: "בכפתור",
    description: "בפגישה שהתקיימה מופיע הכפתור \"יצירת טיוטת הזמנה\", ומי שמטפל באיש הקשר לוחץ עליו כשצריך.",
  },
  {
    value: "auto",
    label: "לבד",
    description:
      "כשפגישה מסומנת \"התקיימה\", נוצרת לבד טיוטת הזמנה עם המוצר של סוג הפגישה, פעם אחת לפגישה. מי שסימן ואין לו הרשאה על הלקוח מקבל התראה, ומי שיש לו הרשאה יוצר את הטיוטה בכפתור.",
  },
];

export function meetingOrderDraftModeOf(value: unknown): MeetingOrderDraftMode {
  return (MEETING_ORDER_DRAFT_MODES as readonly unknown[]).includes(value) ? (value as MeetingOrderDraftMode) : MEETING_ORDER_DRAFT_DEFAULT;
}

export const meetingOrderDraftModeSchema = z.object({
  meeting_order_draft: z.enum(MEETING_ORDER_DRAFT_MODES, { error: "יש לבחור מתי נוצרת הטיוטה." }),
});

/** The database's reasons (app.meeting_order_draft_refusal, plus the button's not_permitted). */
export const MEETING_ORDER_DRAFT_REASONS = [
  "not_found",
  "exists",
  "not_held",
  "feature_orders",
  "module_off",
  "feature_products",
  "not_writable",
  "no_contact",
  "contact_gone",
  "no_type",
  "no_product",
  "product_unavailable",
  "punch_card",
  "not_permitted",
] as const;
export type MeetingOrderDraftReason = (typeof MEETING_ORDER_DRAFT_REASONS)[number];

const REASON_TEXT: Record<MeetingOrderDraftReason, string> = {
  not_found: "הפגישה לא נמצאה.",
  exists: "כבר נוצרה טיוטת הזמנה מהפגישה הזו.",
  not_held: "טיוטת הזמנה נוצרת רק מפגישה שהתקיימה.",
  feature_orders: "הזמנות לא כלולות בחבילה של העסק.",
  module_off: "ההזמנות כבויות בעסק.",
  feature_products: "מוצרים לא כלולים בחבילה של העסק.",
  not_writable: "העסק במצב קריאה בלבד.",
  no_contact: "לפגישה אין איש קשר, ולכן אין למי להכין הזמנה.",
  contact_gone: "איש הקשר של הפגישה בסל המחזור.",
  no_type: "לפגישה אין סוג פגישה.",
  no_product: "לסוג הפגישה אין מוצר מקושר.",
  product_unavailable: "המוצר של סוג הפגישה לא זמין למכירה (כבוי או בארכיון).",
  punch_card: "הפגישה נוצלה מכרטיסייה, ולכן לא נוצרת הזמנה.",
  not_permitted: "אין לך הרשאה ליצור הזמנה לאיש הקשר הזה.",
};

export function isMeetingOrderDraftReason(value: unknown): value is MeetingOrderDraftReason {
  return (MEETING_ORDER_DRAFT_REASONS as readonly unknown[]).includes(value);
}

/** The Hebrew line for a reason; an unknown code gets a neutral line, never the code. */
export function meetingOrderDraftReasonText(reason: string): string {
  return isMeetingOrderDraftReason(reason) ? REASON_TEXT[reason] : "אי אפשר ליצור טיוטת הזמנה מהפגישה הזו.";
}

/** A reason the card does not show beside a held meeting: the whole feature is off (the card shows nothing then). */
export function isQuietReason(reason: string | null): boolean {
  return reason === "feature_orders" || reason === "module_off" || reason === "feature_products" || reason === "not_found";
}

export type MeetingOrderDraftState = { reason: string | null; orderId: string | null };

/** public.meeting_order_draft_states: {meeting id: {reason, order_id}}; anything malformed is left out. */
export function parseDraftStates(value: unknown): Map<string, MeetingOrderDraftState> {
  const out = new Map<string, MeetingOrderDraftState>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const reason = typeof entry.reason === "string" ? entry.reason : null;
    const orderId = typeof entry.order_id === "string" ? entry.order_id : null;
    out.set(id, { reason, orderId });
  }
  return out;
}

export type DraftAnswer = { ok: true; orderId: string } | { ok: false; reason: string; orderId: string | null };

/** public.meeting_order_draft_create's answer; a malformed one reads as a refusal with no known reason. */
export function parseDraftAnswer(value: unknown): DraftAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "unknown", orderId: null };
  const answer = value as Record<string, unknown>;
  const orderId = typeof answer.order_id === "string" ? answer.order_id : null;
  if (answer.ok === true && orderId) return { ok: true, orderId };
  return { ok: false, reason: typeof answer.reason === "string" ? answer.reason : "unknown", orderId };
}
