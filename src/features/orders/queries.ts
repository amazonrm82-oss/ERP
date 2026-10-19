import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";

import { customerPriceList } from "@/features/deal-lines/queries";
import { conversionRateBp, type NamedPriceList } from "@/features/deal-lines/pricing";
import { chargesVat, isVatStatus } from "@/features/tax/status";
import { documentVat, type VatRate } from "@/features/tax/rates";

import type { Database, OrderLineRow, OrderRow } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { PAGE_SIZE } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

import { isOrderSource, isOrderStatus, type OrderSource, type OrderStatus } from "./schema";

// ORD-01: every read goes with the user's session; RLS shows an order to whoever reads its deal, else its contact, else
// its company (an order left with none of them: owners, admins and managers).

type Client = SupabaseClient<Database>;

export type Order = {
  id: string;
  status: OrderStatus;
  source: OrderSource;
  numberDisplay: string | null;
  quoteId: string | null;
  originalOrderId: string | null;
  dealId: string | null;
  contactId: string | null;
  companyId: string | null;
  deliveryContactId: string | null;
  ownerId: string | null;
  orderDate: string;
  deliveryDate: string | null;
  shippingAddress: string | null;
  notes: string | null;
  pricesIncludeVat: boolean;
  noVatReason: string | null;
  vatRateBp: number | null;
  subtotalAgorot: number;
  discountTotalAgorot: number;
  netTotalAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
  customerName: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  customerDeletedAt: string | null;
  createdAt: string;
};

export type OrderLine = {
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
  billing: string;
  priceSource: string;
  priceListName: string | null;
  totalAgorot: number;
};

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    status: isOrderStatus(row.status) ? row.status : "draft",
    source: isOrderSource(row.source) ? row.source : "manual",
    numberDisplay: row.number_display,
    quoteId: row.quote_id,
    originalOrderId: row.original_order_id,
    dealId: row.deal_id,
    contactId: row.contact_id,
    companyId: row.company_id,
    deliveryContactId: row.delivery_contact_id,
    ownerId: row.owner_id,
    orderDate: row.order_date,
    deliveryDate: row.delivery_date,
    shippingAddress: row.shipping_address,
    notes: row.notes,
    pricesIncludeVat: row.prices_include_vat,
    noVatReason: row.no_vat_reason,
    vatRateBp: row.vat_rate_bp,
    subtotalAgorot: Number(row.subtotal_agorot),
    discountTotalAgorot: Number(row.discount_total_agorot),
    netTotalAgorot: Number(row.net_total_agorot),
    vatAgorot: Number(row.vat_agorot),
    totalAgorot: Number(row.total_agorot),
    customerName: row.customer_name,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    customerDeletedAt: row.customer_deleted_at,
    createdAt: row.created_at,
  };
}

function toLine(row: OrderLineRow): OrderLine {
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
    billing: row.billing,
    priceSource: row.price_source,
    priceListName: row.price_list_name,
    totalAgorot: Number(row.total_agorot),
  };
}

/** One order with the given client (Server Actions pass their own); null when missing or not readable. */
export async function readOrder(supabase: Client, orgId: string, orderId: string): Promise<Order | null> {
  const row = must(await supabase.from("orders").select("*").eq("organization_id", orgId).eq("id", orderId).maybeSingle(), "order");
  return row ? toOrder(row) : null;
}

export const getOrder = cache(async (orgId: string, orderId: string): Promise<Order | null> => readOrder(await createClient(), orgId, orderId));

export async function listOrderLines(orgId: string, orderId: string): Promise<OrderLine[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("order_lines").select("*").eq("organization_id", orgId).eq("order_id", orderId).order("position").order("id").limit(200),
    "order_lines",
  );
  return rows.map(toLine);
}

export type OrderSummary = {
  id: string;
  status: OrderStatus;
  source: OrderSource;
  numberDisplay: string | null;
  orderDate: string;
  deliveryDate: string | null;
  totalAgorot: number;
  customer: string | null;
  contactId: string | null;
  companyId: string | null;
};

const SUMMARY_COLUMNS = "id, status, source, number_display, order_date, delivery_date, total_agorot, customer_name, contact_id, company_id";

type SummaryRow = Pick<OrderRow, "id" | "status" | "source" | "number_display" | "order_date" | "delivery_date" | "total_agorot" | "customer_name" | "contact_id" | "company_id">;

async function withCustomers(supabase: Client, orgId: string, rows: SummaryRow[]): Promise<OrderSummary[]> {
  // a draft has no stored customer name yet: the contact's name, else the company's (read with the user's session)
  const contactIds = [...new Set(rows.filter((r) => !r.customer_name && r.contact_id).map((r) => r.contact_id as string))];
  const companyIds = [...new Set(rows.filter((r) => !r.customer_name && !r.contact_id && r.company_id).map((r) => r.company_id as string))];
  const [contacts, companies] = await Promise.all([
    contactIds.length ? supabase.from("contacts").select("id, full_name").eq("organization_id", orgId).in("id", contactIds) : null,
    companyIds.length ? supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", companyIds) : null,
  ]);
  const names = new Map<string, string>();
  for (const c of contacts ? must(contacts, "contacts") : []) if (c.full_name) names.set(c.id, c.full_name);
  for (const c of companies ? must(companies, "companies") : []) names.set(c.id, c.name);
  return rows.map((row) => ({
    id: row.id,
    status: isOrderStatus(row.status) ? row.status : "draft",
    source: isOrderSource(row.source) ? row.source : "manual",
    numberDisplay: row.number_display,
    orderDate: row.order_date,
    deliveryDate: row.delivery_date,
    totalAgorot: Number(row.total_agorot),
    customer: row.customer_name ?? names.get(row.contact_id ?? "") ?? names.get(row.company_id ?? "") ?? null,
    contactId: row.contact_id,
    companyId: row.company_id,
  }));
}

export type OrderListFilters = { status: OrderStatus | null; page: number };

/** ORD-01: the orders list, newest first, one page at a time. */
export async function listOrders(orgId: string, filters: OrderListFilters): Promise<{ orders: OrderSummary[]; hasMore: boolean }> {
  const supabase = await createClient();
  const from = (filters.page - 1) * PAGE_SIZE;
  let query = supabase.from("orders").select(SUMMARY_COLUMNS).eq("organization_id", orgId);
  if (filters.status) query = query.eq("status", filters.status);
  const rows = must(await query.order("created_at", { ascending: false }).order("id").range(from, from + PAGE_SIZE), "orders");
  const page = await withCustomers(supabase, orgId, rows.slice(0, PAGE_SIZE));
  return { orders: page, hasMore: rows.length > PAGE_SIZE };
}

/** The orders of a deal, a contact or a company (record cards). */
export async function listRecordOrders(orgId: string, subject: { kind: "deal" | "contact" | "company"; id: string }): Promise<OrderSummary[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("orders")
      .select(SUMMARY_COLUMNS)
      .eq("organization_id", orgId)
      .eq(subject.kind === "deal" ? "deal_id" : subject.kind === "contact" ? "contact_id" : "company_id", subject.id)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(50),
    "orders",
  );
  return withCustomers(supabase, orgId, rows);
}

/** The order made from this quote (one per quote), if the user reads it. */
export async function getQuoteOrder(orgId: string, quoteId: string): Promise<{ id: string; numberDisplay: string | null } | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("orders").select("id, number_display").eq("organization_id", orgId).eq("quote_id", quoteId).maybeSingle(),
    "orders",
  );
  return row ? { id: row.id, numberDisplay: row.number_display } : null;
}

/** The names around an order, each read with the user's session (a hidden record stays unnamed). */
export async function getOrderParties(
  orgId: string,
  order: Pick<Order, "dealId" | "contactId" | "companyId" | "deliveryContactId" | "quoteId" | "originalOrderId">,
): Promise<{ deal: string | null; contact: string | null; company: string | null; deliveryContact: string | null; quote: string | null; original: string | null }> {
  const supabase = await createClient();
  const [deal, contacts, company, quote, original] = await Promise.all([
    order.dealId ? supabase.from("deals").select("name").eq("organization_id", orgId).eq("id", order.dealId).maybeSingle() : null,
    order.contactId || order.deliveryContactId
      ? supabase
          .from("contacts")
          .select("id, full_name")
          .eq("organization_id", orgId)
          .in("id", [order.contactId, order.deliveryContactId].filter((id): id is string => id !== null))
      : null,
    order.companyId ? supabase.from("companies").select("name").eq("organization_id", orgId).eq("id", order.companyId).maybeSingle() : null,
    order.quoteId ? supabase.from("quotes").select("number_display, title").eq("organization_id", orgId).eq("id", order.quoteId).maybeSingle() : null,
    order.originalOrderId ? supabase.from("orders").select("number_display").eq("organization_id", orgId).eq("id", order.originalOrderId).maybeSingle() : null,
  ]);
  const people = new Map((contacts ? must(contacts, "contacts") : []).map((c) => [c.id, c.full_name]));
  const quoteRow = quote ? must(quote, "quotes") : null;
  return {
    deal: deal ? (must(deal, "deals")?.name ?? null) : null,
    contact: order.contactId ? (people.get(order.contactId) ?? null) : null,
    company: company ? (must(company, "companies")?.name ?? null) : null,
    deliveryContact: order.deliveryContactId ? (people.get(order.deliveryContactId) ?? null) : null,
    quote: quoteRow ? (quoteRow.number_display ?? quoteRow.title) : null,
    original: original ? (must(original, "orders")?.number_display ?? null) : null,
  };
}

/** What a product line of a draft is priced with (PL-03, the quotes' rule): the order's day, VAT mode and customer's list. */
export type OrderPricing = {
  day: string;
  rateBp: number;
  includesVat: boolean;
  list: Omit<NamedPriceList, "lines"> | null;
};

export async function readOrderPricing(supabase: Client, orgId: string, order: Pick<Order, "orderDate" | "contactId" | "companyId" | "pricesIncludeVat">): Promise<OrderPricing> {
  const day = order.orderDate;
  const [settings, rateRows, list] = await Promise.all([
    supabase.from("org_document_settings").select("vat_status, other_charges_vat").eq("organization_id", orgId).maybeSingle(),
    supabase.from("vat_rates").select("effective_from, rate_bp").is("cancelled_at", null).order("effective_from"),
    customerPriceList(supabase, orgId, { contactId: order.contactId, companyId: order.companyId }, day),
  ]);
  const row = must(settings, "org document settings");
  const rates: VatRate[] = must(rateRows, "vat rates").map((r) => ({ effectiveFrom: r.effective_from, rateBp: r.rate_bp }));
  const status = isVatStatus(row?.vat_status) ? row.vat_status : null;
  const vat = documentVat(chargesVat(status, row?.other_charges_vat ?? null), rates, day);
  return { day, rateBp: conversionRateBp(vat, rates, day), includesVat: order.pricesIncludeVat, list };
}

export async function getOrderPricing(orgId: string, order: Order): Promise<OrderPricing> {
  return readOrderPricing(await createClient(), orgId, order);
}
