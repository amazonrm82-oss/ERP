import { z } from "zod";

// QUO-13 part one: what an accepted quote does to its deal (org_document_settings.quote_accept_deal, default 'ask').

export const QUOTE_ACCEPT_DEAL_MODES = ["auto", "ask", "none"] as const;
export type QuoteAcceptDeal = (typeof QUOTE_ACCEPT_DEAL_MODES)[number];
export const QUOTE_ACCEPT_DEAL_DEFAULT: QuoteAcceptDeal = "ask";

export const QUOTE_ACCEPT_DEAL_OPTIONS: { value: QuoteAcceptDeal; label: string; description: string }[] = [
  {
    value: "ask",
    label: "לשאול",
    description: "מי שמטפל בהצעה מקבל התראה, ובדף ההצעה אפשר להעביר את העסקה לזכייה ולעדכן את השורות שלה בלחיצה.",
  },
  {
    value: "auto",
    label: "לעשות לבד",
    description:
      "העסקה עוברת לשלב הזכייה הראשון בתהליך המכירה, והשורות שלה מוחלפות בשורות ההצעה שהלקוח אישר. בלי חלון הסגירה: לא נשאלים שדות החובה של שלב הזכייה ולא נוצרת משימת קליטה.",
  },
  { value: "none", label: "לא לעשות כלום", description: "העסקה נשארת כפי שהיא, ומעדכנים אותה ידנית." },
];

export function quoteAcceptDealOf(value: unknown): QuoteAcceptDeal {
  return (QUOTE_ACCEPT_DEAL_MODES as readonly unknown[]).includes(value) ? (value as QuoteAcceptDeal) : QUOTE_ACCEPT_DEAL_DEFAULT;
}

export function quoteAcceptDealLabel(value: QuoteAcceptDeal): string {
  return QUOTE_ACCEPT_DEAL_OPTIONS.find((option) => option.value === value)!.label;
}

export const QUOTE_ACCEPT_DEAL_FIELD_NAMES = ["quote_accept_deal"] as const;
export const quoteAcceptDealSchema = z.object({
  quote_accept_deal: z.enum(QUOTE_ACCEPT_DEAL_MODES, { error: "יש לבחור מה קורה בעסקה." }),
});

/** The quote page offers the move while the deal is open, for an accepted quote that is not an addendum, unless the setting is 'none'. */
export function offersDealMove(input: {
  status: string;
  hasDeal: boolean;
  isAddendum: boolean;
  dealOpen: boolean;
  mode: QuoteAcceptDeal;
  canEdit: boolean;
}): boolean {
  return input.status === "accepted" && input.hasDeal && !input.isAddendum && input.dealOpen && input.mode !== "none" && input.canEdit;
}

/** What the won window says when the deal was won but a deal lines rule kept its old lines (the hint of the refusal). */
export function linesKeptText(hint: string): string {
  const why =
    hint === "deal_lines:vat_mode"
      ? 'ההצעה מתומחרת בהגדרת מע"מ אחרת מזו של העסקה'
      : hint === "deal_lines:product"
        ? "אחד המוצרים בהצעה כבר לא מוצע"
        : hint.startsWith("feature:")
          ? "חלק מהשורות לא מתאימות לחבילה"
          : "אחד הכללים של שורות העסקה לא אפשר את העדכון";
  return `העסקה עברה לזכייה, אבל השורות שלה לא עודכנו לפי ההצעה: ${why}.`;
}

/**
 * QUO-13: reads public.quote_win_deal's answer. The deal it moved must be the deal the window was opened for; anything else
 * (another deal, a malformed answer) is null, and the caller refuses. linesHint is the refusal's hint when the lines were kept.
 */
export function quoteWinResult(answer: unknown, dealId: string): { deal: string; linesHint: string | null } | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const { deal, lines } = answer as { deal?: unknown; lines?: unknown };
  if (typeof deal !== "string" || deal !== dealId || typeof lines !== "string") return null;
  return { deal, linesHint: lines === "updated" ? null : lines };
}
