import "server-only";

import { effectiveBilling, type Billing } from "@/features/billing/billing";
import { getRecordBilling } from "@/features/billing/queries";
import { getOrgBranding } from "@/features/branding/queries";
import { quoteColor, type DocumentCustomer, type QuoteDesign } from "@/features/quotes/design";
import { customerFrom, getDocumentBusiness, getQuoteDesign, plain, type DocumentBusiness } from "@/features/quotes/design-server";

import { getOrderParties, listOrderLines, type Order, type OrderLine } from "./queries";

export type OrderDocumentData = {
  design: QuoteDesign;
  color: string | null;
  logoUrl: string | null;
  business: DocumentBusiness;
  customer: DocumentCustomer | null;
  order: Order;
  lines: OrderLine[];
};

const EMPTY: Billing = { name: null, taxId: null, address: null, shippingAddress: null, email: null, terms: null, priceListId: null };

/**
 * ORD-05 part one: everything an order confirmation shows, read with the user's session. It takes the business's quote
 * design (logo, colour, header and footer, business details). The customer is the effective billing details (CON-08);
 * a numbered order names the customer as it was named when numbered (ORD-03), like a sent quote.
 *
 * Known limit (review, 19 October 2026): only the name is a snapshot. The billing address, email and tax id are read from
 * the contact or company as they are today, also on a numbered order (orders store no copy of them, as quotes do not); the
 * page says so beside the document (`LIVE_BILLING_NOTE`). Keeping a copy needs columns on orders, so it waits for a
 * migration (and for DOC, where an accounting document must keep them).
 */
export async function getOrderDocumentData(orgId: string, order: Order, displayName: string): Promise<OrderDocumentData> {
  const [design, branding, business, lines, parties] = await Promise.all([
    getQuoteDesign(orgId),
    getOrgBranding(orgId),
    getDocumentBusiness(orgId, displayName),
    listOrderLines(orgId, order.id),
    getOrderParties(orgId, order),
  ]);
  let billing: Billing | null = null;
  if (order.contactId) {
    const record = await getRecordBilling(orgId, "contact", order.contactId);
    if (record) billing = plain(effectiveBilling(record.own, record.company?.billing ?? null));
  } else if (order.companyId) {
    const record = await getRecordBilling(orgId, "company", order.companyId);
    if (record) billing = { ...record.own, name: record.own.name ?? parties.company };
  }
  const live = customerFrom(billing ?? EMPTY, { company: parties.company, contact: parties.contact });
  const customer =
    order.status !== "draft" && order.customerName
      ? { name: order.customerName, attention: live?.attention ?? null, address: live?.address ?? null, email: live?.email ?? null, taxId: live?.taxId ?? null }
      : live;
  return {
    design,
    color: quoteColor(design, branding.color),
    logoUrl: design.showLogo ? branding.logoUrl : null,
    business,
    customer,
    order,
    lines,
  };
}

/** Shown beside a numbered order's document, never printed. */
export const LIVE_BILLING_NOTE = "פרטי החיוב של הלקוח (כתובת, אימייל ומספר מזהה) מוצגים כפי שהם היום בכרטיס הלקוח, ולא כפי שהיו כשההזמנה אושרה.";
