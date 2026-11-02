import "server-only";

import { logoPublicUrl } from "@/features/branding/logo";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import { pdfHeaders } from "@/features/quotes/pdf-fingerprint";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import type { StatementCustomer } from "./link-actions";
import { publicStatementPdfDocument, STATEMENT_BANK_ELSEWHERE, statementPdfFileName } from "./pdf";
import { staffStatementFrom } from "./staff";

// BAL-04: the staff's PDF of a customer's statement, made for this request with the user's own session and never stored or
// counted in the PDF quota (owner, 1 November 2026, answer (2) א). Since the owner's answers of 2 November 2026 it is exactly
// the customer's document ((36) ב): public.statement_staff_view (security invoker) answers public.statement_public's content
// for the customer under RLS, BAL-01's rights and keys; a view that is partial (a row of the customer the user does not read)
// makes no file. The bank details print only for owners and admins while the statement's switch is on ((35) א); anyone else
// gets STATEMENT_BANK_ELSEWHERE in their place while the switch is on (the customer's page shows them then); with the switch
// off nobody gets either (lead's decision, 2 November 2026). No service key.

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** The card's words when part of the customer's money is hidden from the user (as for the statement link). */
export const STATEMENT_PDF_PARTIAL =
  "חלק מהמסמכים או התשלומים של הלקוח מוסתרים מכם, ולכן אי אפשר להפיק PDF של דף החשבון. בעלים או מנהלי מערכת יכולים להפיק אותו.";
const NOT_ALLOWED = "אין לכם הרשאה לראות את דף החשבון של הלקוח הזה.";
const NOT_FOUND = "הלקוח לא נמצא.";
const COMPANY = "לאיש קשר שמשויך לחברה, דף החשבון הוא של החברה. הורידו אותו מכרטיס החברה.";

/** The staff's PDF address for a customer. */
export function staffStatementPdfPath(orgId: string, customer: StatementCustomer): string {
  return `/o/${orgId}/statement/${customer.kind}/${customer.id}/pdf`;
}

/** GET /o/<org>/statement/<contact|company>/<id>/pdf */
export async function handleStaffStatementPdf(orgId: string, kind: string, id: string): Promise<Response> {
  if (!isUuid(orgId) || !isUuid(id) || (kind !== "contact" && kind !== "company")) return text(404, NOT_FOUND);
  // the business's gate before any read: the agreement, a closed business and two-step verification send the user where the
  // pages do (as the route did before the owner's answers of 2 November 2026)
  await getOrgContext(orgId);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("statement_staff_view", {
    p_org: orgId,
    p_contact: kind === "contact" ? id : null,
    p_company: kind === "company" ? id : null,
  });
  if (error) throw new Error(`statement_staff_view failed: ${error.code} ${error.message}`);
  const view = staffStatementFrom(data);
  if (!view) throw new Error("statement_staff_view: unexpected answer");
  if (view.state === "not-allowed") return text(403, NOT_ALLOWED);
  if (view.state === "partial") return text(403, STATEMENT_PDF_PARTIAL);
  if (view.state === "not-found") return text(404, NOT_FOUND);
  // BAL-02's customer: a contact of a company has the company's statement (the card links there)
  if (view.state === "company") return text(409, COMPANY);

  const { statement } = view;
  const doc = publicStatementPdfDocument(
    statement,
    await loadPdfLogo(logoPublicUrl(statement.logoPath)),
    view.bankElsewhere ? STATEMENT_BANK_ELSEWHERE : null,
  );
  const bytes = await renderPdf(doc);
  return new Response(new Uint8Array(bytes), { status: 200, headers: pdfHeaders(statementPdfFileName(statement.customerName, statement.today), bytes.length) });
}
