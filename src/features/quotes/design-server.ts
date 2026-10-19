import "server-only";

import { cache } from "react";

import { effectiveBilling, type Billing } from "@/features/billing/billing";
import { getRecordBilling } from "@/features/billing/queries";
import { getOrgBranding } from "@/features/branding/queries";
import { getDocumentDetails } from "@/features/tax/queries";
import { documentAddress } from "@/features/tax/settings";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { designFromRow, quoteColor, sentCustomer, type DocumentCustomer, type QuoteDesign } from "./design";
import { getQuoteParties, listQuoteLines, listQuoteSchedule, type Quote, type QuoteLine } from "./queries";
import { scheduleRows, type ScheduleRow } from "./schedule";

/** QUO-05: the business's quote design (every member reads it; no row = the defaults). */
export const getQuoteDesign = cache(async (orgId: string): Promise<QuoteDesign> => {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("quote_designs")
      .select("header_text, footer_text, show_logo, show_business_details, accent_color")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "quote design",
  );
  return designFromRow(row);
});

export type DocumentBusiness = {
  // the registered name when set, else the display name (owner: documents use the registered name)
  name: string;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
};

export type { DocumentCustomer } from "./design";

export type QuoteDocumentData = {
  design: QuoteDesign;
  color: string | null;
  logoUrl: string | null;
  business: DocumentBusiness;
  customer: DocumentCustomer | null;
  quote: Quote;
  lines: QuoteLine[];
  // GAP-09: the payment schedule with each step's share of the total (none = no section)
  schedule?: ScheduleRow[];
};

/** The business as its documents show it. */
export async function getDocumentBusiness(orgId: string, displayName: string): Promise<DocumentBusiness> {
  const details = await getDocumentDetails(orgId);
  return {
    name: details.legalName?.trim() || displayName,
    taxId: details.taxId,
    address: documentAddress(details),
    phone: details.phone,
    email: details.email,
  };
}

function customerFrom(billing: Billing, names: { company: string | null; contact: string | null }): DocumentCustomer | null {
  const name = billing.name ?? names.company ?? names.contact;
  if (!name) return null;
  return {
    name,
    attention: names.contact && names.contact !== name ? names.contact : null,
    address: billing.address,
    email: billing.email,
    taxId: billing.taxId,
  };
}

function plain(shown: ReturnType<typeof effectiveBilling>): Billing {
  return {
    name: shown.name.value,
    taxId: shown.taxId.value,
    address: shown.address.value,
    shippingAddress: shown.shippingAddress.value,
    email: shown.email.value,
    terms: shown.terms.value,
    priceListId: shown.priceListId.value,
  };
}

/**
 * QUO-05: everything a quote's document shows, read with the user's session. The customer's details
 * are the effective billing details (CON-08: the contact's, else its company's); a record the user may
 * not read shows by the names alone.
 */
export async function getQuoteDocumentData(orgId: string, quote: Quote, displayName: string): Promise<QuoteDocumentData> {
  const [design, branding, business, lines, parties] = await Promise.all([
    getQuoteDesign(orgId),
    getOrgBranding(orgId),
    getDocumentBusiness(orgId, displayName),
    listQuoteLines(orgId, quote.id),
    getQuoteParties(orgId, quote),
  ]);
  // GAP-09
  const schedule = scheduleRows(quote.totalAgorot, await listQuoteSchedule(orgId, quote.id));
  let billing: Billing | null = null;
  if (quote.contactId) {
    const record = await getRecordBilling(orgId, "contact", quote.contactId);
    if (record) billing = plain(effectiveBilling(record.own, record.company?.billing ?? null));
  } else if (quote.companyId) {
    const record = await getRecordBilling(orgId, "company", quote.companyId);
    if (record) billing = { ...record.own, name: record.own.name ?? parties.company };
  }
  const empty: Billing = { name: null, taxId: null, address: null, shippingAddress: null, email: null, terms: null, priceListId: null };
  return {
    design,
    color: quoteColor(design, branding.color),
    logoUrl: design.showLogo ? branding.logoUrl : null,
    business,
    customer: sentCustomer(quote, customerFrom(billing ?? empty, { company: parties.company, contact: parties.contact })),
    quote,
    lines,
    schedule,
  };
}

/** A made-up quote for the settings preview, in the business's own design. */
export async function getSampleDocumentData(orgId: string, displayName: string): Promise<QuoteDocumentData> {
  const [design, branding, business] = await Promise.all([getQuoteDesign(orgId), getOrgBranding(orgId), getDocumentBusiness(orgId, displayName)]);
  const today = new Date().toISOString().slice(0, 10);
  const line = (id: string, position: number, name: string, quantity: number, price: number, extra: Partial<QuoteLine> = {}): QuoteLine => ({
    id,
    position,
    kind: "item",
    productId: null,
    name,
    description: null,
    unitName: "יחידה",
    quantity,
    unitPriceAgorot: price,
    discountBp: null,
    discountAgorot: null,
    vatExempt: false,
    billing: "one_time",
    isOptional: false,
    optionalSelected: false,
    source: "manual",
    priceListId: null,
    priceListName: null,
    totalAgorot: Math.round(quantity * price),
    ...extra,
  });
  return {
    design,
    color: quoteColor(design, branding.color),
    logoUrl: design.showLogo ? branding.logoUrl : null,
    business,
    customer: { name: "לקוח לדוגמה בע\"מ", attention: "ישראל ישראלי", address: "רחוב הדוגמה 1, תל אביב", email: "client@example.com", taxId: null },
    quote: {
      id: "sample",
      previousId: null,
      cancelledFrom: null,
      cancelReason: null,
      addendumOf: null,
      title: "הצעת מחיר לדוגמה",
      status: "sent",
      numberDisplay: "1001",
      sentAt: today,
      customerName: null,
      customerContactName: null,
      customerDeletedAt: null,
      dealId: null,
      contactId: null,
      companyId: null,
      ownerId: null,
      quoteDate: today,
      validUntil: null,
      pricesIncludeVat: false,
      noVatReason: null,
      noVatNote: null,
      discountBp: null,
      discountAgorot: null,
      notes: "תודה שבחרתם בנו.",
      terms: "תשלום שוטף + 30.",
      vatRateBp: 1800,
      subtotalAgorot: 150000,
      discountTotalAgorot: 0,
      netTotalAgorot: 150000,
      vatAgorot: 27000,
      totalAgorot: 177000,
      createdAt: today,
    },
    lines: [
      { ...line("g", 1, "שלב א", 1, 0), kind: "group", unitName: null, totalAgorot: 0 },
      line("a", 2, "שירות לדוגמה", 2, 50000),
      line("b", 3, "מוצר לדוגמה", 1, 50000),
    ],
  };
}
