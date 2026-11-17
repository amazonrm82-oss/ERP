import { z } from "zod";

import { withPrefixThe, type OrgTerms } from "@/features/terminology/terms";
import { parseMoneyToAgorot } from "@/lib/format";

// DOC-14: the credit form's rules, shared by the page and the server action. Pure (no server, no provider), unit tested in
// tests/unit/invoice-credit.test.ts. The database stays the judge: app.invoice_credit_open checks what is left under a lock,
// works out the VAT share and keeps one request per key (migration invoice_credit).

export const CREDIT_REASON_MAX = 500;

/** The reason as the database keeps it: trimmed, runs of white space folded into one space. */
export const foldReason = (text: string) => text.replace(/\s+/g, " ").trim();

const hasControl = (text: string) => [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

export const creditFormSchema = z.object({
  key: z.guid(),
  // owner (411) ב: "lines" = a partial credit of an original that mixes exempt and taxable lines, made of chosen lines
  mode: z.enum(["full", "partial", "lines"], "יש לבחור זיכוי מלא או חלקי."),
  amount: z.string().max(40),
  // one line: runs of white space (a pasted line break too) fold into one space, as app.invoice_credit_open does
  reason: z
    .string()
    .transform(foldReason)
    .pipe(z.string()
    .min(1, "חובה לכתוב את סיבת הזיכוי.")
    .max(CREDIT_REASON_MAX, `הסיבה עד ${CREDIT_REASON_MAX} תווים.`)
    .refine((value) => !hasControl(value), "הסיבה בלי תווים מיוחדים.")),
});

export const CREDIT_FIELD_NAMES = ["key", "mode", "amount", "reason"] as const;

/** One chosen line as the form edits it: its id, ticked, and the amount typed (empty = all that is left of it). */
export type CreditLineDraft = { lineId: string; chosen: boolean; amount: string };

/** A chosen line as the database takes it (null amount = all that is left of the line). */
export type CreditLinePick = { line_id: string; amount_agorot: number | null };

const draftLineSchema = z.object({ lineId: z.guid(), chosen: z.boolean(), amount: z.string().max(40) });

/** The form's hidden `lines` field for a line credit: at least one ticked line, each amount above zero and within its part left. */
export function parseCreditLines(json: string, leftByLine: ReadonlyMap<string, number> | null): { ok: true; lines: CreditLinePick[] } | { ok: false; message: string } {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return { ok: false, message: "השורות לא נקראו. נסו שוב." };
  }
  if (!Array.isArray(rows) || rows.length > 200) return { ok: false, message: "השורות לא נקראו. נסו שוב." };
  const picks: CreditLinePick[] = [];
  for (const row of rows) {
    const parsed = draftLineSchema.safeParse(row);
    if (!parsed.success) return { ok: false, message: "השורות לא נקראו. נסו שוב." };
    if (!parsed.data.chosen) continue;
    if (parsed.data.amount.trim() === "") {
      picks.push({ line_id: parsed.data.lineId, amount_agorot: null });
      continue;
    }
    const agorot = parseMoneyToAgorot(parsed.data.amount);
    const left = leftByLine?.get(parsed.data.lineId);
    if (agorot === null || agorot <= 0) return { ok: false, message: "בשורה שנבחרה צריך סכום גדול מאפס, או להשאיר ריק לכל מה שנשאר." };
    if (left !== undefined && agorot > left) return { ok: false, message: "הסכום בשורה גדול ממה שנשאר לזכות בה." };
    picks.push({ line_id: parsed.data.lineId, amount_agorot: agorot });
  }
  if (picks.length === 0) return { ok: false, message: "יש לסמן לפחות שורה אחת לזיכוי." };
  return { ok: true, lines: picks };
}

/** The amount the database gets: null = everything that is left (full), else whole agorot 1..left; or the message to show. */
export function creditAmount(mode: "full" | "partial", amount: string, leftAgorot: number | null): { ok: true; agorot: number | null } | { ok: false; message: string } {
  if (mode === "full") return { ok: true, agorot: null };
  const agorot = parseMoneyToAgorot(amount);
  if (agorot === null || agorot <= 0) return { ok: false, message: "יש לכתוב סכום זיכוי גדול מאפס." };
  if (leftAgorot !== null && agorot > leftAgorot) return { ok: false, message: "הסכום גדול ממה שנשאר לזכות במסמך." };
  return { ok: true, agorot };
}

/** Why a document is not credited through the provider (codes of app.invoice_credit_room_of). */
export const CREDIT_BLOCKED_TEXT: Record<string, string> = {
  type: "מזכים כאן רק חשבונית מס או חשבונית מס קבלה.",
  cancelled: "המסמך בוטל, ולכן אין מה לזכות בו.",
  not_issued_here: "המסמך לא הופק דרך ספק החשבוניות של העסק. זיכוי של מסמך שנרשם ידנית מפיקים אצל הספק ורושמים כאן.",
  provider: "המסמך הופק אצל ספק אחר מזה שהעסק מחובר אליו עכשיו.",
  nothing_left: "כל הסכום של המסמך כבר זוכה, או שבקשות זיכוי עליו עוד ממתינות לספק.",
};

export function creditBlockedText(code: string | null): string {
  return (code && CREDIT_BLOCKED_TEXT[code]) || "אי אפשר לזכות את המסמך הזה.";
}

/** The page's words that name the record the original belongs to, in the business's own terms. */
export function creditBackLabel(kind: "deal" | "contact", terms: OrgTerms): string {
  return `חזרה ${withPrefixThe("ל", kind === "deal" ? terms.deal : terms.contact)}`;
}
