import { z } from "zod";

import { isHexColor, normalizeHex } from "@/features/branding/color";
import { optionalText } from "@/lib/validation";

/**
 * QUO-05: how a quote looks to the customer (paper now; the PDF of QUO-06 and the customer page of
 * QUO-08 later). One per business, public.quote_designs; no row = the defaults below. The logo and the
 * colour are the business's own (FLD-04) and the details are those of TAX-02; the design says whether
 * and how they appear. Hebrew only (English is wave 4).
 */

export const QUOTE_HEADER_MAX = 500;
export const QUOTE_FOOTER_MAX = 1000;

export type QuoteDesign = {
  headerText: string | null;
  footerText: string | null;
  showLogo: boolean;
  showBusinessDetails: boolean;
  // TAX-02: the bank details stored on the document when it was sent (or an order numbered)
  showBankDetails: boolean;
  // '#rrggbb' for quotes only; null = the business colour
  accentColor: string | null;
};

export const DEFAULT_QUOTE_DESIGN: QuoteDesign = {
  headerText: null,
  footerText: null,
  showLogo: true,
  showBusinessDetails: true,
  showBankDetails: true,
  accentColor: null,
};

export type QuoteDesignRow = {
  header_text: string | null;
  footer_text: string | null;
  show_logo: boolean;
  show_business_details: boolean;
  show_bank_details: boolean;
  accent_color: string | null;
};

export function designFromRow(row: QuoteDesignRow | null): QuoteDesign {
  if (!row) return DEFAULT_QUOTE_DESIGN;
  return {
    headerText: row.header_text,
    footerText: row.footer_text,
    showLogo: row.show_logo,
    showBusinessDetails: row.show_business_details,
    showBankDetails: row.show_bank_details,
    accentColor: isHexColor(row.accent_color) ? row.accent_color : null,
  };
}

/** The colour a quote is drawn in: its own, else the business colour, else none (the design system's). */
export function quoteColor(design: QuoteDesign, brandColor: string | null): string | null {
  return design.accentColor ?? brandColor;
}

export const COLOR_MODES = ["brand", "own"] as const;

export const quoteDesignSchema = z
  .object({
    header_text: optionalText(QUOTE_HEADER_MAX, `הכותרת העליונה ארוכה מדי (עד ${QUOTE_HEADER_MAX} תווים).`),
    footer_text: optionalText(QUOTE_FOOTER_MAX, `הכותרת התחתונה ארוכה מדי (עד ${QUOTE_FOOTER_MAX} תווים).`),
    show_logo: z.unknown().optional(),
    show_business_details: z.unknown().optional(),
    show_bank_details: z.unknown().optional(),
    color_mode: z.preprocess((value) => (typeof value === "string" ? value : "brand"), z.enum(COLOR_MODES, { error: "יש לבחור צבע." })),
    accent_color: z.unknown().optional(),
  })
  .transform((value, ctx) => {
    let accentColor: string | null = null;
    if (value.color_mode === "own") {
      accentColor = normalizeHex(value.accent_color);
      if (!accentColor) {
        ctx.addIssue({ code: "custom", path: ["accent_color"], message: "יש לבחור צבע, למשל ‎#1e56d6." });
        return z.NEVER;
      }
    }
    return {
      header_text: value.header_text,
      footer_text: value.footer_text,
      show_logo: value.show_logo === "on",
      show_business_details: value.show_business_details === "on",
      show_bank_details: value.show_bank_details === "on",
      accent_color: accentColor,
    } satisfies QuoteDesignRow;
  });

export const QUOTE_DESIGN_FIELD_NAMES = ["header_text", "footer_text", "show_logo", "show_business_details", "show_bank_details", "color_mode", "accent_color"] as const;

export type DocumentCustomer = {
  // the name for invoices, else the company, else the contact
  name: string;
  // the person, when the quote is to a company or an invoice name
  attention: string | null;
  address: string | null;
  email: string | null;
  taxId: string | null;
};

/**
 * QUO-07: a sent quote shows the customer as it was printed when sent (quote_send keeps the names), even
 * after the record was renamed or purged; the address and email still come from the record while it exists.
 * An erased quote has no names left and shows no customer once the record is gone.
 */
export function sentCustomer(
  quote: { status: string; customerName: string | null; customerContactName: string | null },
  live: DocumentCustomer | null,
): DocumentCustomer | null {
  if (quote.status === "draft" || !quote.customerName) return live;
  return {
    name: quote.customerName,
    attention: quote.customerContactName,
    address: live?.address ?? null,
    email: live?.email ?? null,
    taxId: live?.taxId ?? null,
  };
}
