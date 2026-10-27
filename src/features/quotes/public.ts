import { z } from "zod";

import { BILLINGS } from "@/features/products/schema";

import { bankFromSnapshot } from "./bank";
import { quoteColor, type DocumentCustomer, type QuoteDesign } from "./design";
import type { DocumentBusiness } from "./design-server";
import type { Quote, QuoteLine } from "./queries";
import type { ScheduleRow } from "./schedule";
import { isNoVatReason, isQuoteStatus } from "./schema";

// QUO-08: the customer's page of a sent quote, from public.quote_public(token) (service_role only). The answer holds
// no ids; it is read here into the shape of QUO-05's document (QuoteDocument), with made-up keys for the lines.

/** The customer's link: 64 base64url characters (only its SHA-256 is kept). */
export const QUOTE_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const publicQuotePath = (token: string) => `/f/quote/${token}`;
/** QUO-06 follow-up: the customer's download of the stored PDF of the quote the link shows */
export const publicQuotePdfPath = (token: string) => `/api/forms/quote/${token}/pdf`;

const money = z.coerce.number().int();
const nullableMoney = z.coerce.number().int().nullable();
const text = z.string().nullable();

const answerSchema = z.object({
  quote: z.object({
    number: text,
    title: z.string(),
    status: z.string(),
    quote_date: z.string(),
    valid_until: text,
    sent_at: text,
    prices_include_vat: z.boolean(),
    no_vat_reason: text,
    no_vat_note: text,
    discount_bp: z.number().int().nullable(),
    discount_agorot: nullableMoney,
    notes: text,
    terms: text,
    vat_rate_bp: z.number().int().nullable(),
    subtotal_agorot: money,
    discount_total_agorot: money,
    net_total_agorot: money,
    vat_agorot: money,
    total_agorot: money,
  }),
  customer: z.object({ name: text, contact: text }),
  lines: z.array(
    z.object({
      position: z.number().int(),
      kind: z.enum(["item", "group"]),
      name: z.string(),
      description: text,
      unit_name: text,
      quantity: z.coerce.number(),
      unit_price_agorot: money,
      discount_bp: z.number().int().nullable(),
      discount_agorot: nullableMoney,
      vat_exempt: z.boolean(),
      billing: z.enum(BILLINGS),
      is_optional: z.boolean(),
      optional_selected: z.boolean(),
      total_agorot: money,
    }),
  ),
  business: z.object({
    name: z.string(),
    tax_id: text,
    address_line: text,
    city: text,
    postal_code: text,
    phone: text,
    email: text,
  }),
  design: z.object({
    header_text: text,
    footer_text: text,
    show_logo: z.boolean(),
    show_business_details: z.boolean(),
    // TAX-02 (absent before 021087)
    show_bank_details_quote: z.boolean().optional(),
    accent_color: text,
  }),
  brand: z.object({ logo: text, color: text }),
  built_with: z.boolean(),
  // QUO-12: the number the customer's link was made for, when the page shows a newer version of it (absent before 020345)
  replaced: z.object({ number: text }).nullish(),
  // QUO-12 (owner, 19 October 2026): a newer version is being prepared (absent before 020540)
  draft_version: z.boolean().optional(),
  // owner, 19 October 2026: the day an accepted quote was accepted, in the business's zone (absent before 020550)
  accepted_on: text.optional(),
  // GAP-10: the quote this one adds to, and this quote's accepted addenda (absent before 020430)
  addendum: z.object({ number: text }).nullish(),
  addenda: z.array(z.object({ number: text, title: z.string(), total_agorot: money })).optional(),
  // QUO-06 follow-up: the version shown has a stored, fingerprinted PDF the customer may download
  pdf: z.boolean().optional(),
  // TAX-02: the bank details stored when the quote was sent, only while the design shows them (absent before 021087)
  bank: z.unknown().optional(),
  // GAP-09: the payment schedule, each step's share of the total worked out by the database
  schedule: z.array(
    z.object({
      name: z.string(),
      percent_bp: z.number().int(),
      due_date: text,
      milestone: text,
      amount_agorot: money,
    }),
  ),
});

export type PublicQuote = {
  design: QuoteDesign;
  // the colour the page is drawn in: the design's own, else the business's (QUO-05)
  color: string | null;
  logoPath: string | null;
  business: DocumentBusiness;
  customer: DocumentCustomer | null;
  quote: Quote;
  lines: QuoteLine[];
  schedule: ScheduleRow[];
  builtWith: boolean;
  // QUO-12: the link was made for an earlier version; this is the newer one (the earlier one's number, if it had one)
  replaced: { number: string | null } | null;
  // QUO-12: a draft version follows the quote shown; the page says an updated version is being prepared
  draftVersion: boolean;
  // the day it was accepted (YYYY-MM-DD, business zone), for an accepted quote
  acceptedOn: string | null;
  // GAP-10: this quote adds to an accepted quote (its number); and the accepted addenda of this quote
  addendumOf: { number: string | null } | null;
  addenda: { key: string; number: string | null; title: string; totalAgorot: number }[];
  // QUO-06 follow-up: a stored PDF of this version can be downloaded from the link
  hasPdf: boolean;
};

/** The answer as the page needs it, or null when it does not have the expected shape. */
export function publicQuoteFrom(raw: unknown): PublicQuote | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { quote: q, customer, lines, business, design, brand, built_with, schedule, replaced, draft_version, accepted_on, addendum, addenda, pdf, bank } = parsed.data;
  const pageDesign: QuoteDesign = {
    headerText: design.header_text,
    footerText: design.footer_text,
    showLogo: design.show_logo,
    showBusinessDetails: design.show_business_details,
    showBankDetailsQuote: design.show_bank_details_quote ?? true,
    // the order switch is not part of a quote's answer; this page draws a quote only
    showBankDetailsOrder: false,
    accentColor: design.accent_color,
  };
  const place = [business.city, business.postal_code].filter(Boolean).join(" ");
  const address = [business.address_line, place].filter(Boolean).join(", ");
  return {
    design: pageDesign,
    color: quoteColor(pageDesign, brand.color),
    logoPath: design.show_logo ? brand.logo : null,
    business: { name: business.name, taxId: business.tax_id, address: address || null, phone: business.phone, email: business.email },
    // the names as printed when the quote was sent (QUO-07)
    customer: customer.name ? { name: customer.name, attention: customer.contact, address: null, email: null, taxId: null } : null,
    quote: {
      id: "public",
      previousId: null,
      addendumOf: null,
      cancelledFrom: null,
      cancelReason: null,
      title: q.title,
      status: isQuoteStatus(q.status) ? q.status : "sent",
      dealId: null,
      contactId: null,
      companyId: null,
      ownerId: null,
      quoteDate: q.quote_date,
      validUntil: q.valid_until,
      pricesIncludeVat: q.prices_include_vat,
      noVatReason: isNoVatReason(q.no_vat_reason) ? q.no_vat_reason : null,
      noVatNote: q.no_vat_note,
      discountBp: q.discount_bp,
      discountAgorot: q.discount_agorot,
      notes: q.notes,
      terms: q.terms,
      vatRateBp: q.vat_rate_bp,
      subtotalAgorot: q.subtotal_agorot,
      discountTotalAgorot: q.discount_total_agorot,
      netTotalAgorot: q.net_total_agorot,
      vatAgorot: q.vat_agorot,
      totalAgorot: q.total_agorot,
      createdAt: q.quote_date,
      numberDisplay: q.number,
      sentAt: q.sent_at,
      customerName: customer.name,
      customerContactName: customer.contact,
      customerDeletedAt: null,
      bankDetails: bankFromSnapshot(bank),
    },
    lines: lines.map((line, index) => ({
      // the answer holds no ids: a key per line, for the page only
      id: `line-${index + 1}`,
      position: line.position,
      kind: line.kind,
      productId: null,
      name: line.name,
      description: line.description,
      unitName: line.unit_name,
      quantity: line.quantity,
      unitPriceAgorot: line.unit_price_agorot,
      discountBp: line.discount_bp,
      discountAgorot: line.discount_agorot,
      vatExempt: line.vat_exempt,
      billing: line.billing,
      isOptional: line.is_optional,
      optionalSelected: line.optional_selected,
      source: "manual",
      priceListId: null,
      priceListName: null,
      totalAgorot: line.total_agorot,
    })),
    schedule: schedule.map((step, index) => ({
      // no ids in the answer: a key per step, for the page only
      key: `step-${index + 1}`,
      name: step.name,
      percentBp: step.percent_bp,
      dueDate: step.due_date,
      milestone: step.milestone,
      amountAgorot: step.amount_agorot,
    })),
    builtWith: built_with,
    replaced: replaced ? { number: replaced.number } : null,
    draftVersion: draft_version ?? false,
    acceptedOn: accepted_on ?? null,
    addendumOf: addendum ? { number: addendum.number } : null,
    addenda: (addenda ?? []).map((a, index) => ({ key: `addendum-${index + 1}`, number: a.number, title: a.title, totalAgorot: a.total_agorot })),
    hasPdf: pdf === true,
  };
}

// Owner, 19 October 2026: the link of a sent quote always leads to its newest sent version; when that one is not open
// (declined, cancelled, expired) the page shows only its state, with no prices, lines or signing. An accepted one is shown
// in full with the day it was accepted (owner's correction of the same day).
export const STATUS_PAGE_STATES = ["rejected", "cancelled", "expired"] as const;
export type StatusPageState = (typeof STATUS_PAGE_STATES)[number];

export type StatusPublicQuote = {
  statusPage: true;
  state: StatusPageState;
  number: string | null;
  title: string;
  validUntil: string | null;
  business: string;
  logoPath: string | null;
  phone: string | null;
  // the number the link was made for, when this is a newer version of it
  replaced: { number: string | null } | null;
  // a newer version is being prepared
  draftVersion: boolean;
};

const statusSchema = z.object({
  status_page: z.object({
    state: z.enum(STATUS_PAGE_STATES),
    number: z.string().nullable(),
    title: z.string(),
    valid_until: z.string().nullable(),
    business: z.string(),
    logo: z.string().nullable(),
    color: z.string().nullable(),
    phone: z.string().nullable(),
    replaced: z.object({ number: z.string().nullable() }).nullable(),
    draft_version: z.boolean(),
  }),
});

/** The status answer of public.quote_public, or null for any other shape. */
export function statusQuoteFrom(raw: unknown): StatusPublicQuote | null {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data.status_page;
  return {
    statusPage: true,
    state: p.state,
    number: p.number,
    title: p.title,
    validUntil: p.valid_until,
    business: p.business,
    logoPath: p.logo,
    phone: p.phone,
    replaced: p.replaced ? { number: p.replaced.number } : null,
    draftVersion: p.draft_version,
  };
}

/** The sentence the status page shows for each state. */
export const STATUS_PAGE_TEXT: Record<StatusPageState, string> = {
  rejected: "התשובה על ההצעה כבר נשמרה: ההצעה לא אושרה.",
  cancelled: "ההצעה בוטלה על ידי העסק.",
  expired: "פג תוקף ההצעה.",
};
