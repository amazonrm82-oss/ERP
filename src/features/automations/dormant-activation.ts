/**
 * RET-01, owner's answer (64) ג (2 November 2026): when a "customer became dormant" rule is switched on in a business that
 * already has dormant customers, the screen asks with the number whether to run the rule on them too (unticked by default).
 * Yes = one run over them (public.run_dormant_backfill, counted in the automation quota and logged); no = only customers who
 * become dormant from the day the rule was switched on (automations.dormant_from, kept by the database).
 */

/** The URL parameter the save and switch-on actions add, so the rule's page asks once. */
export const DORMANT_ASK_PARAM = "dormant_ask";

export const DORMANT_TRIGGER = "customer_dormant";

/** Ask only right after switching on (the start point is today), for an active dormant rule, with someone to run on. */
export function shouldAskDormant(input: {
  asked: boolean;
  isActive: boolean;
  triggerType: string;
  dormantFrom: string | null;
  today: string;
  count: number | null;
}): boolean {
  return (
    input.asked &&
    input.isActive &&
    input.triggerType === DORMANT_TRIGGER &&
    input.dormantFrom === input.today &&
    typeof input.count === "number" &&
    input.count > 0
  );
}

export function dormantQuestion(count: number): string {
  return count === 1 ? "יש כבר לקוח רדום אחד. להריץ את הכלל גם עליו?" : `יש כבר ${count} לקוחות רדומים. להריץ את הכלל גם עליהם?`;
}

export function dormantCheckboxLabel(count: number): string {
  return count === 1 ? "כן, להריץ את הכלל גם על הלקוח הרדום הקיים" : `כן, להריץ את הכלל גם על ${count} הלקוחות הרדומים הקיימים`;
}

export const DORMANT_NOT_ASKED_LINE = "בלי סימון, הכלל ירוץ רק על מי שיהפוך לרדום מהיום.";

export type BackfillAnswer =
  | { ok: true; ran: number; skipped: number; more: boolean; quota: boolean }
  | { ok: false; reason: string };

/** Reads the database's answer; anything unexpected is null. */
export function parseBackfillAnswer(value: unknown): BackfillAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.ok === false && typeof v.reason === "string") return { ok: false, reason: v.reason };
  if (v.ok === true && typeof v.ran === "number" && typeof v.skipped === "number") {
    return { ok: true, ran: v.ran, skipped: v.skipped, more: v.more === true, quota: v.quota === true };
  }
  return null;
}

/** Sums server answers (one per click today; each call runs at most the server's caps). */
export function sumBackfill(answers: BackfillAnswer[]): { ran: number; skipped: number; more: boolean; quota: boolean; refused: string | null } {
  let ran = 0;
  let skipped = 0;
  let more = false;
  let quota = false;
  let refused: string | null = null;
  for (const a of answers) {
    if (!a.ok) {
      refused = a.reason;
      more = false;
      continue;
    }
    ran += a.ran;
    skipped += a.skipped;
    more = a.more;
    quota = quota || a.quota;
  }
  return { ran, skipped, more, quota, refused };
}

/** The result line the screen shows after "yes". */
export function backfillMessage(total: ReturnType<typeof sumBackfill>): string {
  if (total.refused === "done" && total.ran === 0) return "הכלל כבר הורץ על הלקוחות הרדומים הקיימים.";
  if (total.refused === "inactive") return "האוטומציה כבויה. אפשר להפעיל אותה ולנסות שוב.";
  if (total.ran === 0 && total.skipped === 0 && !total.more && !total.quota) return "אין עוד לקוחות רדומים להריץ עליהם את הכלל.";
  const parts = [total.ran === 1 ? "הכלל הורץ על לקוח רדום אחד." : `הכלל הורץ על ${total.ran} לקוחות רדומים.`];
  if (total.quota) parts.push("חלק מהלקוחות לא טופלו, כי מכסת ההרצות החודשית של האוטומציות נגמרה.");
  else if (total.skipped > 0) parts.push(`${total.skipped} דולגו.`);
  if (total.more) parts.push("נשארו עוד לקוחות. אפשר ללחוץ שוב כדי להמשיך.");
  return parts.join(" ");
}
