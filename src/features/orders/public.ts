import { z } from "zod";

import { BILLINGS } from "@/features/products/schema";
import { bankFromSnapshot } from "@/features/quotes/bank";
import { quoteColor, type DocumentCustomer, type QuoteDesign } from "@/features/quotes/design";
import type { DocumentBusiness } from "@/features/quotes/design-server";
import type { ScheduleRow } from "@/features/quotes/schedule";

import type { Order, OrderLine } from "./queries";
import { isOrderStatus } from "./schema";

// ORD-05: the customer's page of a numbered order, from public.order_public(token, ip_hash) (service_role only). The answer
// holds no ids; it is read here into the shape of the order document (OrderDocument), with made-up keys for the lines.

/** The customer's link: 64 base64url characters (only its SHA-256 is kept). */
export const ORDER_LINK_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const publicOrderPath = (token: string) => `/f/order/${token}`;

const money = z.coerce.number().int();
const nullableMoney = z.coerce.number().int().nullable();
const text = z.string().nullable();

const answerSchema = z.object({
  order: z.object({
    number: text,
    status: z.string(),
    order_date: z.string(),
    delivery_date: text,
    shipping_address: text,
    notes: text,
    prices_include_vat: z.boolean(),
    no_vat_reason: text,
    no_vat_note: text,
    discount_bp: z.number().int().nullable(),
    discount_agorot: nullableMoney,
    vat_rate_bp: z.number().int().nullable(),
    subtotal_agorot: money,
    discount_total_agorot: money,
    net_total_agorot: money,
    vat_agorot: money,
    total_agorot: money,
  }),
  customer: z.object({ name: text }),
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
      total_agorot: money,
    }),
  ),
  schedule: z.array(z.object({ name: z.string(), percent_bp: z.number().int(), due_date: text, milestone: text, amount_agorot: money })),
  business: z.object({ name: z.string(), tax_id: text, address_line: text, city: text, postal_code: text, phone: text, email: text }),
  design: z.object({ header_text: text, footer_text: text, show_logo: z.boolean(), show_business_details: z.boolean(), show_bank_details_order: z.boolean().optional(), accent_color: text }),
  brand: z.object({ logo: text, color: text }),
  built_with: z.boolean(),
  decision: z.object({ decision: z.enum(["accepted", "rejected"]), decided_at: z.string() }).nullable(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  // TAX-02: the bank details stored when the order was numbered, only while the design shows them (absent before 021087)
  bank: z.unknown().optional(),
});

export type PublicOrder = {
  design: QuoteDesign;
  color: string | null;
  logoPath: string | null;
  business: DocumentBusiness;
  customer: DocumentCustomer | null;
  order: Order;
  lines: OrderLine[];
  schedule: ScheduleRow[];
  builtWith: boolean;
  // the customer's answer (what and when), if there is one
  decision: { decision: "accepted" | "rejected"; decidedAt: string } | null;
  // what an answer must name; null when the order does not wait for one
  fingerprint: string | null;
};

/** The answer as the page needs it, or null when it does not have the expected shape. */
export function publicOrderFrom(raw: unknown): PublicOrder | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { order: o, customer, lines, schedule, business, design, brand, built_with, decision, fingerprint, bank } = parsed.data;
  const pageDesign: QuoteDesign = {
    headerText: design.header_text,
    footerText: design.footer_text,
    showLogo: design.show_logo,
    showBusinessDetails: design.show_business_details,
    // the quote switch is not part of an order's answer; this page draws an order only
    showBankDetailsQuote: false,
    showBankDetailsOrder: design.show_bank_details_order ?? true,
    accentColor: design.accent_color,
  };
  const place = [business.city, business.postal_code].filter(Boolean).join(" ");
  const address = [business.address_line, place].filter(Boolean).join(", ");
  return {
    design: pageDesign,
    color: quoteColor(pageDesign, brand.color),
    logoPath: design.show_logo ? brand.logo : null,
    business: { name: business.name, taxId: business.tax_id, address: address || null, phone: business.phone, email: business.email },
    // the name as printed when the order was numbered (ORD-03)
    customer: customer.name ? { name: customer.name, attention: null, address: null, email: null, taxId: null } : null,
    order: {
      id: "public",
      status: isOrderStatus(o.status) ? o.status : "new",
      source: "manual",
      numberDisplay: o.number,
      quoteId: null,
      originalOrderId: null,
      dealId: null,
      contactId: null,
      companyId: null,
      deliveryContactId: null,
      ownerId: null,
      orderDate: o.order_date,
      deliveryDate: o.delivery_date,
      shippingAddress: o.shipping_address,
      notes: o.notes,
      pricesIncludeVat: o.prices_include_vat,
      noVatReason: o.no_vat_reason,
      vatRateBp: o.vat_rate_bp,
      subtotalAgorot: o.subtotal_agorot,
      discountTotalAgorot: o.discount_total_agorot,
      netTotalAgorot: o.net_total_agorot,
      vatAgorot: o.vat_agorot,
      totalAgorot: o.total_agorot,
      customerName: customer.name,
      confirmedAt: null,
      cancelledAt: null,
      customerDeletedAt: null,
      createdAt: o.order_date,
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
      priceSource: "manual",
      priceListName: null,
      totalAgorot: line.total_agorot,
    })),
    schedule: schedule.map((step, index) => ({
      key: `step-${index + 1}`,
      name: step.name,
      percentBp: step.percent_bp,
      dueDate: step.due_date,
      milestone: step.milestone,
      amountAgorot: step.amount_agorot,
    })),
    builtWith: built_with,
    decision: decision ? { decision: decision.decision, decidedAt: decision.decided_at } : null,
    fingerprint,
  };
}

// The one rule for a sent link (owner, 20 October 2026, as for quotes): a cancelled order shows only its state
export type StatusPublicOrder = {
  statusPage: true;
  state: "cancelled";
  number: string | null;
  business: string;
  logoPath: string | null;
  phone: string | null;
};

const statusSchema = z.object({
  status_page: z.object({
    state: z.literal("cancelled"),
    number: text,
    business: z.string(),
    logo: text,
    color: text,
    phone: text,
  }),
});

/** The status answer of public.order_public, or null for any other shape. */
export function statusOrderFrom(raw: unknown): StatusPublicOrder | null {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data.status_page;
  return { statusPage: true, state: p.state, number: p.number, business: p.business, logoPath: p.logo, phone: p.phone };
}

/**
 * The checkbox wording an approval agrees to. DRAFT: legal wording drafted by Claude Code, to be edited by the lawyer
 * (owner's decision of 8 October 2026). Any change to the text gets a new version string, stored with every approval.
 */
export const ORDER_ACCEPT_WORDING = "קראתי את פרטי ההזמנה, הסכומים ולוח התשלומים, ואני מאשר/ת אותה. החתימה שלי כאן מחייבת כמו חתימה בכתב יד.";
export const ORDER_ACCEPT_WORDING_VERSION = "order-draft-2026-10-20";
