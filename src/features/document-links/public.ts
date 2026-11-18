import { z } from "zod";

import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";

// DOC-15 (owner (414) א): the customer's page of one accounting document, from public.document_public(token, ip_hash)
// (service_role only). The answer holds no ids and no customer: the business's name for documents (registered name when set)
// and display name, logo and colour, and the
// document's own type, number, dates, amounts, lines and pay state; a cancelled document answers a status page only.

/** The customer's link: 64 base64url characters (only its SHA-256 is kept). */
export const DOCUMENT_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const publicDocumentPath = (token: string) => `/f/doc/${token}`;
/** The document's current PDF file, while it has one (served by our route, never a storage address). */
export const publicDocumentFilePath = (token: string) => `/api/forms/doc/${token}/file`;

/** The types a customer gets a link to: = app.document_link_types() (never an opening balance, which has no number). */
export const DOCUMENT_LINK_TYPES = ["tax_invoice", "tax_invoice_receipt", "receipt", "credit_invoice", "proforma"] as const;
export type DocumentLinkType = (typeof DOCUMENT_LINK_TYPES)[number];
export const isDocumentLinkType = (value: string): value is DocumentLinkType => (DOCUMENT_LINK_TYPES as readonly string[]).includes(value);

export const PAY_STATES = ["paid", "partial", "unpaid", "transferred", "paid_on_issue"] as const;
export type PublicPayState = (typeof PAY_STATES)[number];

const money = z.coerce.number().int();
const text = z.string().nullable();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const brand = z.object({ logo: text, color: text });

const fullSchema = z.object({
  business: z.object({ name: z.string(), display_name: z.string() }),
  brand,
  today: day,
  currency: z.literal("ILS"),
  document: z.object({
    type: z.enum(DOCUMENT_LINK_TYPES),
    number: z.string(),
    doc_date: day,
    due_date: day.nullable(),
    amount_agorot: money,
    net_agorot: money.nullable(),
    vat_agorot: money.nullable(),
    vat_rate_bp: z.coerce.number().int().nullable(),
    allocation_number: text,
    pay_state: z.enum(PAY_STATES).nullable(),
    balance_agorot: money.nullable(),
    overdue_days: z.coerce.number().int().min(0),
  }),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.coerce.number(),
      unit_price_agorot: money,
      discount_agorot: money,
      vat_exempt: z.boolean(),
      total_agorot: money,
    }),
  ),
  file: z.boolean(),
  built_with: z.boolean(),
});

const cancelledSchema = z.object({
  status_page: z.object({ cancelled: z.literal(true), type: z.enum(DOCUMENT_LINK_TYPES), number: z.string() }),
  business: z.object({ name: z.string(), display_name: z.string() }),
  brand,
  built_with: z.boolean(),
});

export type PublicDocumentLine = {
  /** a key for the page only (the answer holds no ids) */
  key: string;
  description: string;
  quantity: number;
  unitPriceAgorot: number;
  discountAgorot: number;
  vatExempt: boolean;
  totalAgorot: number;
};

type Common = {
  /** the name documents use: the registered name when set, else the display name (TAX-01's rule) */
  business: string;
  /** the business's display name (the logo's alt text) */
  displayName: string;
  logoPath: string | null;
  color: string | null;
  builtWith: boolean;
  title: string;
  type: DocumentLinkType;
  number: string;
};

export type PublicDocument =
  | (Common & {
      kind: "document";
      today: string;
      docDate: string;
      dueDate: string | null;
      amountAgorot: number;
      netAgorot: number | null;
      vatAgorot: number | null;
      vatRateBp: number | null;
      allocationNumber: string | null;
      payState: PublicPayState | null;
      balanceAgorot: number | null;
      overdueDays: number;
      lines: PublicDocumentLine[];
      hasFile: boolean;
    })
  | (Common & { kind: "cancelled" });

/** "חשבונית מס 1001" */
export const documentLinkTitle = (type: DocumentLinkType, number: string) => `${DOCUMENT_TYPE_LABELS[type]} ${number}`.trim();

/** The answer as the page needs it, or null when it does not have the expected shape. */
export function publicDocumentFrom(raw: unknown): PublicDocument | null {
  const cancelled = cancelledSchema.safeParse(raw);
  if (cancelled.success) {
    const { status_page, business, brand: b, built_with } = cancelled.data;
    return {
      kind: "cancelled",
      business: business.name,
      displayName: business.display_name,
      logoPath: b.logo,
      color: b.color,
      builtWith: built_with,
      type: status_page.type,
      number: status_page.number,
      title: documentLinkTitle(status_page.type, status_page.number),
    };
  }
  const parsed = fullSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { business, brand: b, today, document: d, lines, file, built_with } = parsed.data;
  return {
    kind: "document",
    business: business.name,
    displayName: business.display_name,
    logoPath: b.logo,
    color: b.color,
    builtWith: built_with,
    type: d.type,
    number: d.number,
    title: documentLinkTitle(d.type, d.number),
    today,
    docDate: d.doc_date,
    dueDate: d.due_date,
    amountAgorot: d.amount_agorot,
    netAgorot: d.net_agorot,
    vatAgorot: d.vat_agorot,
    vatRateBp: d.vat_rate_bp,
    allocationNumber: d.allocation_number,
    payState: d.pay_state,
    balanceAgorot: d.balance_agorot,
    overdueDays: d.overdue_days,
    lines: lines.map((l, index) => ({
      key: `line-${index + 1}`,
      description: l.description,
      quantity: l.quantity,
      unitPriceAgorot: l.unit_price_agorot,
      discountAgorot: l.discount_agorot,
      vatExempt: l.vat_exempt,
      totalAgorot: l.total_agorot,
    })),
    hasFile: file,
  };
}

/** The pay state as one line for the customer, or null (a receipt or credit invoice has none). */
export function payStateText(doc: { payState: PublicPayState | null; overdueDays: number }): string | null {
  switch (doc.payState) {
    case "paid":
    case "paid_on_issue":
      return "שולם";
    case "partial":
      return doc.overdueDays > 0 ? "שולם חלקית, היתרה באיחור" : "שולם חלקית";
    case "unpaid":
      return doc.overdueDays > 0 ? "ממתין לתשלום, באיחור" : "ממתין לתשלום";
    case "transferred":
      return "הוחלפה בחשבונית מס";
    default:
      return null;
  }
}

/** The file name the customer's download gets: the type and number only, never a person's name. */
export function documentFileName(type: DocumentLinkType, number: string): string {
  const safeNumber = number.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "מסמך";
  return `${DOCUMENT_TYPE_LABELS[type].replace(/\//g, "-")} ${safeNumber}.pdf`;
}
