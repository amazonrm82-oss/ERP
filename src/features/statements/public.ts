import { z } from "zod";

import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";

// BAL-04: the customer's statement page, from public.statement_public(token, ip_hash) (service_role only). The answer holds no
// ids: the business, the customer's name, the business's today and the open debt documents (BAL-02's rule) with the totals.

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

export type PublicStatement = {
  business: { name: string; legalName: string | null; taxId: string | null; address: string | null; phone: string | null; email: string | null };
  logoPath: string | null;
  color: string | null;
  customerName: string | null;
  today: string;
  lines: StatementLine[];
  more: number;
  openAgorot: number;
  overdueAgorot: number;
  creditAgorot: number;
  builtWith: boolean;
};

/** The answer as the page needs it, or null when it does not have the expected shape. */
export function publicStatementFrom(raw: unknown): PublicStatement | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { business, brand, customer, today, documents, more, totals, built_with } = parsed.data;
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
    openAgorot: totals.open_agorot,
    overdueAgorot: totals.overdue_agorot,
    creditAgorot: totals.credit_agorot,
    builtWith: built_with,
  };
}

/** "באיחור של 12 ימים" / "באיחור של יום אחד", or null when not late. */
export function overdueText(days: number): string | null {
  if (days <= 0) return null;
  return days === 1 ? "באיחור של יום אחד" : `באיחור של ${days} ימים`;
}
