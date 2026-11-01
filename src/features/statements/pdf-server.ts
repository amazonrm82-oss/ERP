import "server-only";

import { ledgerPeriod } from "@/features/balances/ledger";
import { getDebtSummary, getLedger, seesBalances } from "@/features/balances/queries";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import type { DocumentBank } from "@/features/quotes/bank";
import { quoteColor } from "@/features/quotes/design";
import { getQuoteDesign } from "@/features/quotes/design-server";
import { pdfHeaders } from "@/features/quotes/pdf-fingerprint";
import { getOrgBranding } from "@/features/branding/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getBankDetails, getDocumentDetails } from "@/features/tax/queries";
import { documentAddress } from "@/features/tax/settings";
import { zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import type { StatementCustomer } from "./link-actions";
import { ledgerStatementPdfDocument, statementPdfFileName, type StatementBusiness } from "./pdf";

// BAL-04 (owner, 1 November 2026, answer (2) א): the staff's PDF of a customer's statement, made for this request with the
// user's own session and never stored or counted in the PDF quota. Its data is the card's: public.customer_ledger (BAL-01) and
// public.customer_debt_summary (BAL-02/03), so the database's rights decide (app.can_record_payments with the balances,
// documents and payments keys). A view that is partial (a row of the customer the user does not read) makes no file.

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** The card's words when part of the customer's money is hidden from the user (as for the statement link). */
export const STATEMENT_PDF_PARTIAL =
  "חלק מהמסמכים או התשלומים של הלקוח מוסתרים מכם, ולכן אי אפשר להפיק PDF של דף החשבון. בעלים או מנהלי מערכת יכולים להפיק אותו.";
const NOT_ALLOWED = "אין לכם הרשאה לראות את דף החשבון של הלקוח הזה.";
const NOT_FOUND = "הלקוח לא נמצא.";
const COMPANY = "לאיש קשר שמשויך לחברה, דף החשבון הוא של החברה. הורידו אותו מכרטיס החברה.";

/** The staff's PDF address for a customer, with the ledger's period from the page (empty = the last 12 months). */
export function staffStatementPdfPath(orgId: string, customer: StatementCustomer, period: { from?: string | null; to?: string | null } = {}): string {
  const query = new URLSearchParams();
  if (period.from) query.set("lf", period.from);
  if (period.to) query.set("lt", period.to);
  const tail = query.toString();
  return `/o/${orgId}/statement/${customer.kind}/${customer.id}/pdf${tail ? `?${tail}` : ""}`;
}

/** The customer's name as the statement page names it: the billing name, else the record's name. */
async function customerOf(orgId: string, customer: StatementCustomer): Promise<{ name: string | null; companyId: string | null } | null> {
  const supabase = await createClient();
  if (customer.kind === "contact") {
    const { data, error } = await supabase
      .from("contacts")
      .select("full_name, billing_name, company_id, deleted_at")
      .eq("organization_id", orgId)
      .eq("id", customer.id)
      .maybeSingle();
    if (error) throw new Error(`statement pdf contact: ${error.message}`);
    if (!data || data.deleted_at) return null;
    return { name: data.billing_name?.trim() || data.full_name || null, companyId: data.company_id };
  }
  const { data, error } = await supabase
    .from("companies")
    .select("name, billing_name, deleted_at")
    .eq("organization_id", orgId)
    .eq("id", customer.id)
    .maybeSingle();
  if (error) throw new Error(`statement pdf company: ${error.message}`);
  if (!data || data.deleted_at) return null;
  return { name: data.billing_name?.trim() || data.name || null, companyId: null };
}

/** GET /o/<org>/statement/<contact|company>/<id>/pdf[?lf=&lt=] */
export async function handleStaffStatementPdf(request: Request, orgId: string, kind: string, id: string): Promise<Response> {
  if (!isUuid(orgId) || !isUuid(id) || (kind !== "contact" && kind !== "company")) return text(404, NOT_FOUND);
  const customer: StatementCustomer = { kind, id };
  const context = await getOrgContext(orgId);
  if (!(await seesBalances(orgId))) return text(403, NOT_ALLOWED);
  const record = await customerOf(orgId, customer);
  if (!record) return text(404, NOT_FOUND);
  // BAL-02's customer: a contact of a company has the company's statement (the card links there)
  if (record.companyId) return text(409, COMPANY);

  const where = { contact: kind === "contact" ? id : null, company: kind === "company" ? id : null };
  const url = new URL(request.url);
  const today = zoneDate(new Date(), context.org.timeZone);
  const period = ledgerPeriod(today, url.searchParams.get("lf"), url.searchParams.get("lt"));
  const [ledger, debt] = await Promise.all([getLedger(orgId, where, period), getDebtSummary(orgId, where.contact, where.company)]);
  if (!ledger.allowed || !debt.allowed) return text(403, NOT_ALLOWED);
  if (ledger.partial || debt.partial) return text(403, STATEMENT_PDF_PARTIAL);

  const [design, branding, details] = await Promise.all([getQuoteDesign(orgId), getOrgBranding(orgId), getDocumentDetails(orgId)]);
  const show = design.showBusinessDetails;
  const legal = details.legalName?.trim() || null;
  const business: StatementBusiness = {
    name: context.org.name,
    legalName: show && legal && legal !== context.org.name ? legal : null,
    taxId: show ? details.taxId : null,
    address: show ? documentAddress(details) : null,
    phone: show ? details.phone : null,
    email: show ? details.email : null,
  };
  // TAX-02: the business's current bank details, read with the user's session (owners and admins only, by RLS), while the
  // statement's switch shows them
  let bank: DocumentBank | null = null;
  if (design.showBankDetailsStatement && (context.role === "owner" || context.role === "admin")) {
    const row = await getBankDetails(orgId);
    if (row.bankAccount) bank = { bankName: row.bankName, branch: row.bankBranch, account: row.bankAccount, accountName: row.bankAccountName };
  }

  const doc = ledgerStatementPdfDocument(
    {
      business,
      color: quoteColor(design, branding.color),
      customerName: record.name,
      today: debt.today,
      ledger,
      overdueAgorot: debt.overdue_debt,
      aging: debt.open_debt > 0 ? debt.aging : null,
      bank,
    },
    await loadPdfLogo(design.showLogo ? branding.logoUrl : null),
  );
  const bytes = await renderPdf(doc);
  return new Response(new Uint8Array(bytes), { status: 200, headers: pdfHeaders(statementPdfFileName(record.name, debt.today), bytes.length) });
}
