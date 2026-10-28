"use server";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import type { TimelineSubject } from "@/features/activities/schema";
import { parseMoneyState } from "@/features/allocations/state";
import { parseDebtSummary } from "@/features/balances/debt";
import { documentTitle, isDocumentType } from "@/features/documents/schema";
import { COLLECTION_REMINDER_KIND } from "@/features/whatsapp/templates";

import { getCollectionAccess } from "./queries";
import { dueDateText, reminderAmountText } from "./reminders";

// COL-04: what the WhatsApp button of a collection reminder task needs, read with the user's session (RLS decides: a
// document, contact or company the user cannot read is "not available", never revealed).

export type CollectionReminderMessage =
  | { state: "paid" }
  | { state: "no_phone"; name: string }
  | {
      state: "ready";
      phoneE164: string;
      subject: TimelineSubject;
      name: string;
      firstName: string | null;
      fullName: string | null;
      document: string;
      // null when the user does not see all of the customer's money (BAL-01): {סכום} stays for the person
      amount: string | null;
      dueDate: string | null;
      templateId: string | null;
    };

const NOT_AVAILABLE = "המסמך של התזכורת לא זמין לכם.";
const NOT_ALLOWED = "תזכורות גבייה שולחים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים, כשמודול הגבייה פעיל.";

export async function loadCollectionReminderAction(orgId: string, taskId: string): Promise<ActionResult<CollectionReminderMessage>> {
  const context = await actionContext(orgId, taskId);
  if (!context.ok) return context;
  const { supabase } = context;
  // as the collection screen: the plan keys (collection, documents, payments) and BAL-01's rule
  const access = await getCollectionAccess(orgId);
  if (!access.canOpen) return fail(NOT_ALLOWED);

  const task = await supabase.from("tasks").select("id, collection_document_id").eq("organization_id", orgId).eq("id", taskId).maybeSingle();
  if (task.error) return fail(dbErrorMessage(task.error));
  const documentId = task.data?.collection_document_id;
  if (!documentId) return fail(NOT_AVAILABLE);

  const doc = await supabase
    .from("accounting_documents")
    .select("id, doc_type, number, doc_date, due_date, status, deal_id, contact_id, company_id")
    .eq("organization_id", orgId)
    .eq("id", documentId)
    .maybeSingle();
  if (doc.error) return fail(dbErrorMessage(doc.error));
  if (!doc.data || !isDocumentType(doc.data.doc_type)) return fail(NOT_AVAILABLE);
  if (doc.data.status !== "active") return ok({ state: "paid" });

  const money = await supabase.rpc("money_allocation_state", { p_org: orgId, p_documents: [documentId], p_payments: [] });
  if (money.error) return fail(dbErrorMessage(money.error));
  const balance = parseMoneyState(money.data).documents.get(documentId)?.balance ?? 0;
  if (balance <= 0) return ok({ state: "paid" });

  // the customer to write to: the document's contact, else its deal's contact, else the document's company
  let contactId = doc.data.contact_id;
  let companyId = doc.data.company_id;
  if (doc.data.deal_id) {
    const deal = await supabase.from("deals").select("contact_id, company_id").eq("organization_id", orgId).eq("id", doc.data.deal_id).maybeSingle();
    if (deal.error) return fail(dbErrorMessage(deal.error));
    contactId = contactId ?? deal.data?.contact_id ?? null;
    companyId = companyId ?? deal.data?.company_id ?? null;
  }
  const contact = contactId
    ? await supabase.from("contacts").select("id, full_name, first_name, phone_e164, company_id").eq("organization_id", orgId).eq("id", contactId).maybeSingle()
    : null;
  if (contact?.error) return fail(dbErrorMessage(contact.error));

  // BAL-02's customer: the company (the document's, its contact's or its deal's), else the contact
  const customerCompany = doc.data.company_id ?? contact?.data?.company_id ?? companyId;
  const customerContact = customerCompany ? null : (contact?.data?.id ?? null);
  let summary: { allowed: boolean; partial?: boolean } | null = null;
  if (customerCompany || customerContact) {
    const debt = await supabase.rpc("customer_debt_summary", { p_org: orgId, p_contact: customerContact, p_company: customerCompany });
    if (debt.error) return fail(dbErrorMessage(debt.error));
    summary = parseDebtSummary(debt.data);
  }

  const document = documentTitle({ docType: doc.data.doc_type, number: doc.data.number, docDate: doc.data.doc_date });
  const filled = { document, amount: reminderAmountText(balance, summary), dueDate: dueDateText(doc.data.due_date) };

  const template = await supabase
    .from("whatsapp_templates")
    .select("id")
    .eq("organization_id", orgId)
    .eq("kind", COLLECTION_REMINDER_KIND)
    .maybeSingle();
  if (template.error) return fail(dbErrorMessage(template.error));
  const templateId = template.data?.id ?? null;

  if (contact?.data) {
    const name = contact.data.full_name ?? "איש הקשר";
    if (!contact.data.phone_e164) return ok({ state: "no_phone", name });
    return ok({
      state: "ready",
      phoneE164: contact.data.phone_e164,
      subject: { kind: "contact", id: contact.data.id },
      name,
      firstName: contact.data.first_name,
      fullName: contact.data.full_name,
      ...filled,
      templateId,
    });
  }
  if (companyId) {
    const company = await supabase.from("companies").select("id, name, phone_e164").eq("organization_id", orgId).eq("id", companyId).maybeSingle();
    if (company.error) return fail(dbErrorMessage(company.error));
    if (company.data) {
      if (!company.data.phone_e164) return ok({ state: "no_phone", name: company.data.name });
      return ok({
        state: "ready",
        phoneE164: company.data.phone_e164,
        subject: { kind: "company", id: company.data.id },
        name: company.data.name,
        firstName: null,
        fullName: company.data.name,
        ...filled,
        templateId,
      });
    }
  }
  return fail(NOT_AVAILABLE);
}
