import { z } from "zod";

import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/features/payments/schema";
import { bankFromSnapshot, type DocumentBank } from "@/features/quotes/bank";

// BAL-04: the customer's statement page, from public.statement_public(token, ip_hash) (service_role only). The answer holds no
// ids: the business, the customer's name, the business's today and the open debt documents (BAL-02's rule) with the totals;
// since the owner's answers of 1 November 2026 also the payments received in the last 12 months (date, method, amount only)
// and the business's bank details while the statement's TAX-02 switch shows them.

/** The customer's link: 64 base64url characters (only its SHA-256 is kept). */
export const STATEMENT_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const publicStatementPath = (token: string) => `/f/statement/${token}`;

/** The debt documents a statement lists (BAL-02): never a receipt, a credit invoice or an invoice-receipt. */
export const STATEMENT_DOC_TYPES = ["tax_invoice", "proforma", "opening_balance"] as const;
export type StatementDocType = (typeof STATEMENT_DOC_TYPES)[number];

const money = z.coerce.number().int();
const text = z.string().nullable();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const answerSchema = z.object({
  business: z.object({
    name: z.string(),
    legal_name: text,
    tax_id: text,
    address_line: text,
    city: text,
    postal_code: text,
    phone: text,
    email: text,
  }),
  brand: z.object({ logo: text, color: text }),
  customer: z.object({ name: text }),
  today: day,
  currency: z.literal("ILS"),
  documents: z.array(
    z.object({
      type: z.enum(STATEMENT_DOC_TYPES),
      number: text,
      doc_date: day,
      due_date: day.nullable(),
      amount_agorot: money,
      balance_agorot: money,
      overdue_days: z.coerce.number().int().min(0),
    }),
  ),
  more: z.coerce.number().int().min(0),
  payments: z.array(z.object({ paid_on: day, method: z.enum(PAYMENT_METHODS), amount_agorot: money.positive() })),
  payments_more: z.coerce.number().int().min(0),
  bank: z.unknown().nullable(),
  totals: z.object({ open_agorot: money, overdue_agorot: money, credit_agorot: money }),
  built_with: z.boolean(),
});

export type StatementLine = {
  /** a key for the page only (the answer holds no ids) */
  key: string;
  title: string;
  number: string | null;
  docDate: string;
  dueDate: string | null;
  amountAgorot: number;
  balanceAgorot: number;
  overdueDays: number;
};

export type StatementPayment = {
  /** a key for the page only (the answer holds no ids) */
  key: string;
  paidOn: string;
  /** the method's label only; a cheque is "צ'ק", never its number or bank */
  method: string;
  amountAgorot: number;
};

export type PublicStatement = {
  business: { name: string; legalName: string | null; taxId: string | null; address: string | null; phone: string | null; email: string | null };
  logoPath: string | null;
  color: string | null;
  customerName: string | null;
  today: string;
  lines: StatementLine[];
  more: number;
  payments: StatementPayment[];
  paymentsMore: number;
  bank: DocumentBank | null;
  openAgorot: number;
  overdueAgorot: number;
  creditAgorot: number;
  builtWith: boolean;
};

/** The answer as the page needs it, or null when it does not have the expected shape. */
export function publicStatementFrom(raw: unknown): PublicStatement | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { business, brand, customer, today, documents, more, payments, payments_more, bank, totals, built_with } = parsed.data;
  const place = [business.city, business.postal_code].filter(Boolean).join(" ");
  const address = [business.address_line, place].filter(Boolean).join(", ");
  return {
    business: {
      name: business.name,
      legalName: business.legal_name && business.legal_name !== business.name ? business.legal_name : null,
      taxId: business.tax_id,
      address: address || null,
      phone: business.phone,
      email: business.email,
    },
    logoPath: brand.logo,
    color: brand.color,
    customerName: customer.name,
    today,
    lines: documents.map((d, index) => ({
      key: `doc-${index + 1}`,
      title: DOCUMENT_TYPE_LABELS[d.type],
      number: d.number,
      docDate: d.doc_date,
      dueDate: d.due_date,
      amountAgorot: d.amount_agorot,
      balanceAgorot: d.balance_agorot,
      overdueDays: d.overdue_days,
    })),
    more,
    payments: payments.map((p, index) => ({
      key: `pay-${index + 1}`,
      paidOn: p.paid_on,
      method: PAYMENT_METHOD_LABELS[p.method],
      amountAgorot: p.amount_agorot,
    })),
    paymentsMore: payments_more,
    bank: bankFromSnapshot(bank),
    openAgorot: totals.open_agorot,
    overdueAgorot: totals.overdue_agorot,
    creditAgorot: totals.credit_agorot,
    builtWith: built_with,
  };
}

/** The note under the documents when more than 500 are open, or null. */
export function moreDocumentsText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "ועוד מסמך פתוח אחד שלא מוצג כאן. הסכומים למעלה כוללים אותו."
    : `ועוד ${n} מסמכים פתוחים שלא מוצגים כאן. הסכומים למעלה כוללים אותם.`;
}

/** The note under the payments when more than 500 were received, or null. */
export function morePaymentsText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "ועוד תשלום אחד מוקדם יותר שלא מוצג כאן." : `ועוד ${n} תשלומים מוקדמים יותר שלא מוצגים כאן.`;
}

/** "באיחור של 12 ימים" / "באיחור של יום אחד", or null when not late. */
export function overdueText(days: number): string | null {
  if (days <= 0) return null;
  return days === 1 ? "באיחור של יום אחד" : `באיחור של ${days} ימים`;
}
