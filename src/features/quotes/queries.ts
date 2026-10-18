import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { customerPriceList } from "@/features/deal-lines/queries";
import { conversionRateBp, isDealLineSource, type DealLineSource, type NamedPriceList } from "@/features/deal-lines/pricing";
import { isBilling } from "@/features/deal-lines/recurring";
import type { Billing } from "@/features/products/schema";
import { chargesVat, isVatStatus } from "@/features/tax/status";
import { documentVat, type DocumentVat, type VatRate } from "@/features/tax/rates";
import type { Database } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { PAGE_SIZE } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

import type { ScheduleStep } from "./schedule";
import { quoteCustomerName } from "./share";
import { isNoVatReason, isQuoteStatus, type NoVatReason, type QuoteStatus } from "./schema";

type Client = SupabaseClient<Database>;

export type Quote = {
  id: string;
  title: string;
  status: QuoteStatus;
  dealId: string | null;
  contactId: string | null;
  companyId: string | null;
  ownerId: string | null;
  quoteDate: string;
  validUntil: string | null;
  pricesIncludeVat: boolean;
  noVatReason: NoVatReason | null;
  noVatNote: string | null;
  discountBp: number | null;
  discountAgorot: number | null;
  notes: string | null;
  terms: string | null;
  vatRateBp: number | null;
  subtotalAgorot: number;
  discountTotalAgorot: number;
  netTotalAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
  createdAt: string;
  // QUO-07: set when it is sent; the customer as named then; "הלקוח נמחק" once its record is purged
  numberDisplay: string | null;
  sentAt: string | null;
  customerName: string | null;
  customerContactName: string | null;
  customerDeletedAt: string | null;
};

export type QuoteLine = {
  id: string;
  position: number;
  kind: "item" | "group";
  productId: string | null;
  name: string;
  description: string | null;
  unitName: string | null;
  quantity: number;
  unitPriceAgorot: number;
  discountBp: number | null;
  discountAgorot: number | null;
  vatExempt: boolean;
  billing: Billing;
  isOptional: boolean;
  optionalSelected: boolean;
  source: DealLineSource;
  priceListId: string | null;
  priceListName: string | null;
  totalAgorot: number;
};

const QUOTE_COLUMNS =
  "id, title, status, deal_id, contact_id, company_id, owner_id, quote_date, valid_until, prices_include_vat, no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, vat_rate_bp, subtotal_agorot, discount_total_agorot, net_total_agorot, vat_agorot, total_agorot, created_at, number_display, sent_at, customer_name, customer_contact_name, customer_deleted_at";

type QuoteDbRow = Database["public"]["Tables"]["quotes"]["Row"];
type LineDbRow = Database["public"]["Tables"]["quote_lines"]["Row"];

function toQuote(row: Pick<QuoteDbRow, keyof QuoteDbRow>): Quote {
  return {
    id: row.id,
    title: row.title,
    // the check constraints hold these to the lists in schema.ts
    status: isQuoteStatus(row.status) ? row.status : "draft",
    dealId: row.deal_id,
    contactId: row.contact_id,
    companyId: row.company_id,
    ownerId: row.owner_id,
    quoteDate: row.quote_date,
    validUntil: row.valid_until,
    pricesIncludeVat: row.prices_include_vat,
    noVatReason: isNoVatReason(row.no_vat_reason) ? row.no_vat_reason : null,
    noVatNote: row.no_vat_note,
    discountBp: row.discount_bp,
    discountAgorot: row.discount_agorot === null ? null : Number(row.discount_agorot),
    notes: row.notes,
    terms: row.terms,
    vatRateBp: row.vat_rate_bp,
    subtotalAgorot: Number(row.subtotal_agorot),
    discountTotalAgorot: Number(row.discount_total_agorot),
    netTotalAgorot: Number(row.net_total_agorot),
    vatAgorot: Number(row.vat_agorot),
    totalAgorot: Number(row.total_agorot),
    createdAt: row.created_at,
    numberDisplay: row.number_display,
    sentAt: row.sent_at,
    customerName: row.customer_name,
    customerContactName: row.customer_contact_name,
    customerDeletedAt: row.customer_deleted_at,
  };
}

const LINE_COLUMNS =
  "id, position, kind, product_id, name, description, unit_name, quantity, unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional, optional_selected, price_source, price_list_id, price_list_name, total_agorot";

function toLine(row: Pick<LineDbRow, keyof LineDbRow>): QuoteLine {
  return {
    id: row.id,
    position: row.position,
    kind: row.kind === "group" ? "group" : "item",
    productId: row.product_id,
    name: row.name,
    description: row.description,
    unitName: row.unit_name,
    quantity: Number(row.quantity),
    unitPriceAgorot: Number(row.unit_price_agorot),
    discountBp: row.discount_bp,
    discountAgorot: row.discount_agorot === null ? null : Number(row.discount_agorot),
    vatExempt: row.vat_exempt,
    billing: isBilling(row.billing) ? row.billing : "one_time",
    isOptional: row.is_optional,
    optionalSelected: row.optional_selected,
    source: isDealLineSource(row.price_source) ? row.price_source : "manual",
    priceListId: row.price_list_id,
    priceListName: row.price_list_name,
    totalAgorot: Number(row.total_agorot),
  };
}

/** One quote the caller reads, or null. */
export async function readQuote(supabase: Client, orgId: string, quoteId: string): Promise<Quote | null> {
  const row = must(await supabase.from("quotes").select(QUOTE_COLUMNS).eq("organization_id", orgId).eq("id", quoteId).maybeSingle(), "quote");
  return row ? toQuote(row as QuoteDbRow) : null;
}

export async function getQuote(orgId: string, quoteId: string): Promise<Quote | null> {
  return readQuote(await createClient(), orgId, quoteId);
}

/** The lines of a quote in order (at most 200, app.quote_lines_check). */
export async function readQuoteLines(supabase: Client, orgId: string, quoteId: string): Promise<QuoteLine[]> {
  const rows = must(
    await supabase.from("quote_lines").select(LINE_COLUMNS).eq("organization_id", orgId).eq("quote_id", quoteId).order("position").order("created_at").order("id"),
    "quote lines",
  );
  return rows.map((row) => toLine(row as LineDbRow));
}

export async function listQuoteLines(orgId: string, quoteId: string): Promise<QuoteLine[]> {
  return readQuoteLines(await createClient(), orgId, quoteId);
}

export type QuoteSummary = Pick<Quote, "id" | "title" | "status" | "quoteDate" | "validUntil" | "totalAgorot" | "createdAt" | "numberDisplay">;

/** QUO-01: the quotes of a deal or a contact, newest first (the card on the record). QUO-16: and of a company. */
export async function listRecordQuotes(orgId: string, subject: { kind: "deal" | "contact" | "company"; id: string }): Promise<QuoteSummary[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("quotes")
      .select("id, title, status, quote_date, valid_until, total_agorot, created_at, number_display")
      .eq("organization_id", orgId)
      .eq(subject.kind === "deal" ? "deal_id" : subject.kind === "contact" ? "contact_id" : "company_id", subject.id)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(50),
    "quotes",
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: isQuoteStatus(row.status) ? row.status : "draft",
    quoteDate: row.quote_date,
    validUntil: row.valid_until,
    totalAgorot: Number(row.total_agorot),
    createdAt: row.created_at,
    numberDisplay: row.number_display,
  }));
}

export type DetachedQuote = QuoteSummary & { customerName: string | null; sentAt: string | null; customerDeletedAt: string };

/**
 * QUO-07: kept quotes whose customer was deleted (the deal and contact are both gone), newest deletion first,
 * one page at a time. Read with the user's session: the select policy shows them to owners, admins and managers by role (QUO-07, owner 18 October 2026).
 */
export async function listDetachedQuotes(orgId: string, page: number): Promise<{ quotes: DetachedQuote[]; hasMore: boolean }> {
  const supabase = await createClient();
  const from = (page - 1) * PAGE_SIZE;
  const rows = must(
    await supabase
      .from("quotes")
      .select("id, title, status, quote_date, valid_until, total_agorot, created_at, number_display, customer_name, sent_at, customer_deleted_at")
      .eq("organization_id", orgId)
      .not("customer_deleted_at", "is", null)
      .order("customer_deleted_at", { ascending: false })
      .order("id")
      .range(from, from + PAGE_SIZE),
    "quotes",
  );
  return {
    hasMore: rows.length > PAGE_SIZE,
    quotes: rows.slice(0, PAGE_SIZE).map((row) => ({
      id: row.id,
      title: row.title,
      status: isQuoteStatus(row.status) ? row.status : "sent",
      quoteDate: row.quote_date,
      validUntil: row.valid_until,
      totalAgorot: Number(row.total_agorot),
      createdAt: row.created_at,
      numberDisplay: row.number_display,
      customerName: row.customer_name,
      sentAt: row.sent_at,
      customerDeletedAt: row.customer_deleted_at as string,
    })),
  };
}

/**
 * What the prices of a quote's lines depend on: its day, the VAT of that day (none with a no-VAT
 * reason), the rate that carries a product's price between the modes (the business's real rate, so a
 * price typed including VAT becomes its net on a no-VAT quote), the quote's mode, and the customer's
 * price list (PL-03 order: the contact's own list, its company's, the quote's company's).
 */
export type QuotePricing = {
  day: string;
  vat: DocumentVat;
  // the business's rate for the day: 0 = no VAT, null = status not set (before the quote's own reason)
  businessRateBp: number | null;
  rateBp: number;
  includesVat: boolean;
  list: Omit<NamedPriceList, "lines"> | null;
};

export async function readQuotePricing(supabase: Client, orgId: string, quote: Quote): Promise<QuotePricing> {
  const day = quote.quoteDate;
  const [settings, rateRows, list] = await Promise.all([
    supabase.from("org_document_settings").select("vat_status, other_charges_vat").eq("organization_id", orgId).maybeSingle(),
    supabase.from("vat_rates").select("effective_from, rate_bp").is("cancelled_at", null).order("effective_from"),
    customerPriceList(supabase, orgId, { contactId: quote.contactId, companyId: quote.companyId }, day),
  ]);
  const row = must(settings, "org document settings");
  const rates: VatRate[] = must(rateRows, "vat rates").map((r) => ({ effectiveFrom: r.effective_from, rateBp: r.rate_bp }));
  const status = isVatStatus(row?.vat_status) ? row.vat_status : null;
  const businessVat = documentVat(chargesVat(status, row?.other_charges_vat ?? null), rates, day);
  const vat: DocumentVat = quote.noVatReason ? { kind: "none" } : businessVat;
  return {
    day,
    vat,
    businessRateBp: businessVat.kind === "rate" ? businessVat.rateBp : businessVat.kind === "none" ? 0 : null,
    rateBp: conversionRateBp(businessVat, rates, day),
    includesVat: quote.pricesIncludeVat,
    list,
  };
}

export async function getQuotePricing(orgId: string, quote: Quote): Promise<QuotePricing> {
  return readQuotePricing(await createClient(), orgId, quote);
}

/** The names on the quote's customer side (read with the user's session; a hidden one is null). */
export async function getQuoteParties(orgId: string, quote: Quote): Promise<{ deal: string | null; contact: string | null; company: string | null }> {
  const supabase = await createClient();
  const [deal, contact, company] = await Promise.all([
    quote.dealId ? supabase.from("deals").select("name").eq("organization_id", orgId).eq("id", quote.dealId).maybeSingle() : null,
    quote.contactId ? supabase.from("contacts").select("full_name").eq("organization_id", orgId).eq("id", quote.contactId).maybeSingle() : null,
    quote.companyId ? supabase.from("companies").select("name").eq("organization_id", orgId).eq("id", quote.companyId).maybeSingle() : null,
  ]);
  return {
    deal: deal ? (must(deal, "deal")?.name ?? null) : null,
    contact: contact ? (must(contact, "contact")?.full_name ?? null) : null,
    company: company ? (must(company, "company")?.name ?? null) : null,
  };
}

export type QuoteCustomerNow = {
  // the customer's name by quote_send's rule as it reads today (null = cannot tell: a part is hidden or missing)
  name: string | null;
  // where the WhatsApp and email buttons send to: the quote's contact, when the user reads it
  email: string | null;
  phoneE164: string | null;
  // the person the greeting names
  contactName: string | null;
};

/**
 * QUO-07 point 9 and QUO-08 (owner, 18 October 2026): the customer as they read now, with the user's session. A part the
 * user may not read counts as hidden, so the name is null rather than built from what they could not see.
 */
export async function getQuoteCustomerNow(orgId: string, quote: Quote): Promise<QuoteCustomerNow> {
  const supabase = await createClient();
  const [contactRead, companyRead] = await Promise.all([
    quote.contactId
      ? supabase.from("contacts").select("full_name, billing_name, company_id, email, phone_e164").eq("organization_id", orgId).eq("id", quote.contactId).maybeSingle()
      : null,
    quote.companyId ? supabase.from("companies").select("name").eq("organization_id", orgId).eq("id", quote.companyId).maybeSingle() : null,
  ]);
  const contact = contactRead ? must(contactRead, "quote contact") : null;
  const company = companyRead ? must(companyRead, "quote company") : null;
  const contactCompanyRead = contact?.company_id
    ? await supabase.from("companies").select("name, billing_name").eq("organization_id", orgId).eq("id", contact.company_id).maybeSingle()
    : null;
  const contactCompany = contactCompanyRead ? must(contactCompanyRead, "quote contact company") : null;
  const name = quoteCustomerName({
    // a link the quote holds but the user cannot read is hidden; no link is none
    contact: quote.contactId ? (contact ? { fullName: contact.full_name, billingName: contact.billing_name, companyId: contact.company_id } : "hidden") : null,
    contactCompany: contact?.company_id ? (contactCompany ? { name: contactCompany.name, billingName: contactCompany.billing_name } : "hidden") : null,
    company: quote.companyId ? (company ? { name: company.name } : "hidden") : null,
  });
  return { name, email: contact?.email ?? null, phoneE164: contact?.phone_e164 ?? null, contactName: contact?.full_name ?? null };
}

export type QuoteLinkStatus = { active: boolean; createdAt: string | null };

/**
 * QUO-08: whether a sent quote has a working customer link, for those who manage it (public.quote_link_status;
 * the hash never leaves the database). Null for anyone else.
 */
export async function getQuoteLinkStatus(orgId: string, quoteId: string): Promise<QuoteLinkStatus | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("quote_link_status", { p_org: orgId, p_quote: quoteId });
  if (error) {
    // not someone who manages the quote, or the plan has no quotes: no link card
    if (error.code === "42501" || error.code === "P0001") return null;
    throw new Error(`quote_link_status failed: ${error.code} ${error.message}`);
  }
  const value = data as { active?: unknown; created_at?: unknown } | null;
  return { active: value?.active === true, createdAt: typeof value?.created_at === "string" ? value.created_at : null };
}

// GAP-09: the quote's payment schedule, in order (RLS: whoever reads the quote)
export async function listQuoteSchedule(orgId: string, quoteId: string): Promise<ScheduleStep[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("quote_payment_steps")
      .select("id, position, name, percent_bp, due_date, milestone")
      .eq("organization_id", orgId)
      .eq("quote_id", quoteId)
      .order("position")
      .order("id"),
    "quote payment schedule",
  );
  return rows.map((row) => ({ id: row.id, position: row.position, name: row.name, percentBp: row.percent_bp, dueDate: row.due_date, milestone: row.milestone }));
}

// QUO-16 ---------------------------------------------------------------------

export type QuoteListFilters = {
  status: QuoteStatus | null;
  ownerId: string | null;
  // quote dates, inclusive (YYYY-MM-DD)
  from: string | null;
  to: string | null;
  page: number;
};

export type QuoteListItem = QuoteSummary & {
  ownerId: string | null;
  sentAt: string | null;
  // the customer as the quote names it once sent, else the contact's name, else the deal's
  customer: string | null;
  dealId: string | null;
  contactId: string | null;
};

/**
 * QUO-16: the business's quotes, newest first, filtered by status, owner and quote date; one page at a time. Read with
 * the user's session: the quotes RLS shows only the quotes of deals and contacts they read.
 */
export async function listQuotes(orgId: string, filters: QuoteListFilters): Promise<{ quotes: QuoteListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  let query = supabase
    .from("quotes")
    .select("id, title, status, quote_date, valid_until, total_agorot, created_at, number_display, owner_id, sent_at, customer_name, deal_id, contact_id")
    .eq("organization_id", orgId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.ownerId) query = query.eq("owner_id", filters.ownerId);
  if (filters.from) query = query.gte("quote_date", filters.from);
  if (filters.to) query = query.lte("quote_date", filters.to);
  const offset = (filters.page - 1) * PAGE_SIZE;
  const rows = must(
    await query
      .order("quote_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + PAGE_SIZE),
    "quotes list",
  );
  const page = rows.slice(0, PAGE_SIZE);
  // the names of the deals and contacts on this page, read separately (RLS: only those the user reads)
  const contactIds = [...new Set(page.flatMap((row) => (row.contact_id && !row.customer_name ? [row.contact_id] : [])))];
  const dealIds = [...new Set(page.flatMap((row) => (row.deal_id && !row.customer_name && !row.contact_id ? [row.deal_id] : [])))];
  const [contacts, deals] = await Promise.all([
    contactIds.length > 0 ? supabase.from("contacts").select("id, full_name").eq("organization_id", orgId).in("id", contactIds) : null,
    dealIds.length > 0 ? supabase.from("deals").select("id, name").eq("organization_id", orgId).in("id", dealIds) : null,
  ]);
  const contactNames = new Map((contacts ? must(contacts, "quote contacts") : []).map((row) => [row.id, row.full_name]));
  const dealNames = new Map((deals ? must(deals, "quote deals") : []).map((row) => [row.id, row.name]));
  return {
    hasMore: rows.length > PAGE_SIZE,
    quotes: page.map((row) => ({
      id: row.id,
      title: row.title,
      status: isQuoteStatus(row.status) ? row.status : "draft",
      quoteDate: row.quote_date,
      validUntil: row.valid_until,
      totalAgorot: Number(row.total_agorot),
      createdAt: row.created_at,
      numberDisplay: row.number_display,
      ownerId: row.owner_id,
      sentAt: row.sent_at,
      dealId: row.deal_id,
      contactId: row.contact_id,
      customer: row.customer_name ?? (row.contact_id ? contactNames.get(row.contact_id) : null) ?? (row.deal_id ? dealNames.get(row.deal_id) : null) ?? null,
    })),
  };
}
