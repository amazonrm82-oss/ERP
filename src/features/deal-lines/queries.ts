import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PriceListLineRule, PricedProduct } from "@/features/price-lists/price";
import type { Billing, VatKind } from "@/features/products/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { chargesVat, isVatStatus } from "@/features/tax/status";
import { documentVat, type DocumentVat, type VatRate } from "@/features/tax/rates";
import type { Database } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { zoneDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { isBilling } from "./recurring";
import { conversionRateBp, dealLinesMode, pickCustomerList, isDealLineSource, type DealLineSource, type NamedPriceList } from "./pricing";

type Client = SupabaseClient<Database>;

export type DealLine = {
  id: string;
  position: number;
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceAgorot: number;
  discountBp: number | null;
  discountAgorot: number | null;
  totalAgorot: number;
  priceIncludesVat: boolean;
  vatExempt: boolean;
  source: DealLineSource;
  priceListId: string | null;
  priceListName: string | null;
  // DLI-04: how the line bills; null = saved before DLI-04 (counts in the deal's own period)
  billing: Billing | null;
};

const LINE_COLUMNS =
  "id, position, product_id, description, quantity, unit_price_agorot, discount_bp, discount_agorot, total_agorot, price_includes_vat, vat_exempt, price_source, price_list_id, price_list_name, billing";

type LineRow = {
  id: string;
  position: number;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price_agorot: number;
  discount_bp: number | null;
  discount_agorot: number | null;
  total_agorot: number;
  price_includes_vat: boolean;
  vat_exempt: boolean;
  price_source: string;
  price_list_id: string | null;
  price_list_name: string | null;
  billing: string | null;
};

function toLine(row: LineRow): DealLine {
  return {
    id: row.id,
    position: row.position,
    productId: row.product_id,
    description: row.description,
    quantity: Number(row.quantity),
    unitPriceAgorot: Number(row.unit_price_agorot),
    discountBp: row.discount_bp,
    discountAgorot: row.discount_agorot === null ? null : Number(row.discount_agorot),
    totalAgorot: Number(row.total_agorot),
    priceIncludesVat: row.price_includes_vat,
    vatExempt: row.vat_exempt,
    // the check constraint holds price_source to the three values
    source: isDealLineSource(row.price_source) ? row.price_source : "manual",
    priceListId: row.price_list_id,
    priceListName: row.price_list_name,
    // the check constraint holds billing to the four modes
    billing: isBilling(row.billing) ? row.billing : null,
  };
}

/** The lines of a deal, in order (at most 200, app.deal_lines_check). Read with the user's session. */
export async function readDealLines(supabase: Client, orgId: string, dealId: string): Promise<DealLine[]> {
  const rows = must(
    await supabase
      .from("deal_lines")
      .select(LINE_COLUMNS)
      .eq("organization_id", orgId)
      .eq("deal_id", dealId)
      .order("position")
      .order("created_at")
      .order("id"),
    "deal_lines",
  );
  return rows.map(toLine);
}

export async function listDealLines(orgId: string, dealId: string): Promise<DealLine[]> {
  return readDealLines(await createClient(), orgId, dealId);
}

/**
 * PL-03: the customer's price list for a new line on this deal, by the owner's order
 * (pickCustomerList(): the contact's own list, that contact's company's, the deal's company's;
 * a set list that does not apply today is passed over), with its terms, or null. Read with the
 * user's session: a contact, company or list they cannot read counts as none. Without the plan
 * flag 'price_lists' no list is used (the database refuses one: feature:price_lists).
 */
export async function customerPriceList(
  supabase: Client,
  orgId: string,
  deal: { contactId: string | null; companyId: string | null },
  day: string,
): Promise<Omit<NamedPriceList, "lines"> | null> {
  if (!(await orgHasFeature(orgId, "price_lists"))) return null;
  let contactList: string | null = null;
  let contactCompany: string | null = null;
  if (deal.contactId) {
    const contact = must(
      await supabase.from("contacts").select("price_list_id, company_id").eq("organization_id", orgId).eq("id", deal.contactId).maybeSingle(),
      "contacts",
    );
    contactList = contact?.price_list_id ?? null;
    contactCompany = contact?.company_id ?? null;
  }
  const companyIds = [...new Set([contactCompany, deal.companyId].filter((id): id is string => id !== null))];
  const companies =
    companyIds.length === 0
      ? []
      : must(await supabase.from("companies").select("id, price_list_id").eq("organization_id", orgId).in("id", companyIds), "companies");
  const listOf = (companyId: string | null) => (companyId ? (companies.find((c) => c.id === companyId)?.price_list_id ?? null) : null);
  const order = [contactList, listOf(contactCompany), listOf(deal.companyId)];
  const listIds = [...new Set(order.filter((id): id is string => id !== null))];
  if (listIds.length === 0) return null;
  const lists = must(
    await supabase.from("price_lists").select("id, name, is_active, valid_from, valid_to").eq("organization_id", orgId).in("id", listIds),
    "price_lists",
  ).map((list) => ({ id: list.id, name: list.name, isActive: list.is_active, validFrom: list.valid_from, validTo: list.valid_to }));
  return pickCustomerList(
    order.map((id) => (id ? (lists.find((list) => list.id === id) ?? null) : null)),
    day,
  );
}

/** The tiers of a price list for some products (at most 20 per product, price_list_lines_check). */
export async function priceListTiers(supabase: Client, orgId: string, listId: string, productIds: string[]): Promise<PriceListLineRule[]> {
  if (productIds.length === 0) return [];
  const rows = must(
    await supabase
      .from("price_list_lines")
      .select("id, product_id, min_quantity, price_agorot, discount_bp, price_includes_vat")
      .eq("organization_id", orgId)
      .eq("price_list_id", listId)
      .in("product_id", productIds)
      .order("product_id")
      .order("min_quantity")
      .order("id"),
    "price_list_lines",
  );
  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    minQuantity: Number(row.min_quantity),
    priceAgorot: row.price_agorot === null ? null : Number(row.price_agorot),
    discountBp: row.discount_bp,
    priceIncludesVat: row.price_includes_vat,
  }));
}

export type PickedProduct = PricedProduct & { name: string; sku: string | null; barcode: string | null; offerable: boolean };

/** One product for pricing, or null when it is not in the organization (or not readable). */
export async function readPricedProduct(supabase: Client, orgId: string, productId: string): Promise<PickedProduct | null> {
  const row = must(
    await supabase
      .from("products")
      .select("id, name, sku, barcode, price_agorot, price_includes_vat, vat_kind, is_active, archived_at")
      .eq("organization_id", orgId)
      .eq("id", productId)
      .maybeSingle(),
    "products",
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode,
    priceAgorot: Number(row.price_agorot),
    priceIncludesVat: row.price_includes_vat,
    // the check constraint holds vat_kind to VAT_KINDS
    vatKind: row.vat_kind as VatKind,
    offerable: row.is_active && row.archived_at === null,
  };
}

/**
 * Everything the prices of a deal's lines depend on, besides the product and the
 * list: the day (business time zone), the VAT of that day, the rate that carries
 * a price between the modes, and the mode of the deal's lines.
 */
export type DealPricing = {
  day: string;
  vat: DocumentVat;
  rateBp: number;
  includesVat: boolean;
  list: Omit<NamedPriceList, "lines"> | null;
};

export async function readDealPricing(
  supabase: Client,
  orgId: string,
  deal: { contactId: string | null; companyId: string | null },
  lines: ReadonlyArray<{ priceIncludesVat: boolean }>,
  timeZone: string,
): Promise<DealPricing> {
  const day = zoneDate(new Date(), timeZone);
  const [settings, rateRows, list] = await Promise.all([
    supabase.from("org_document_settings").select("vat_status, other_charges_vat, prices_include_vat").eq("organization_id", orgId).maybeSingle(),
    supabase.from("vat_rates").select("effective_from, rate_bp").order("effective_from"),
    customerPriceList(supabase, orgId, deal, day),
  ]);
  const row = must(settings, "org document settings");
  const rates: VatRate[] = must(rateRows, "vat rates").map((r) => ({ effectiveFrom: r.effective_from, rateBp: r.rate_bp }));
  const status = isVatStatus(row?.vat_status) ? row.vat_status : null;
  const vat = documentVat(chargesVat(status, row?.other_charges_vat ?? null), rates, day);
  return {
    day,
    vat,
    rateBp: conversionRateBp(vat, rates, day),
    includesVat: dealLinesMode(lines, row?.prices_include_vat === true),
    list,
  };
}

export async function getDealPricing(
  orgId: string,
  deal: { contactId: string | null; companyId: string | null },
  lines: ReadonlyArray<{ priceIncludesVat: boolean }>,
  timeZone: string,
): Promise<DealPricing> {
  return readDealPricing(await createClient(), orgId, deal, lines, timeZone);
}
