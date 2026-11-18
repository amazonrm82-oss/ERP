import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AllocateButton, LinkProformaButton } from "@/features/allocations/components/allocation-forms";
import { AllocationRows } from "@/features/allocations/components/allocation-rows";
import { NO_CREDIT } from "@/features/allocations/credit";
import { getAllocationAccess, getMoneyState, getSubjectCredit, listAllocations, listCreditOffsets } from "@/features/allocations/queries";
import { CreditOffsetRows } from "@/features/allocations/components/credit-offset-rows";
import { documentStateChip, takesPayments } from "@/features/allocations/state";
import { PromiseButton } from "@/features/collection/components/promise-button";
import { PromiseLine } from "@/features/collection/components/promise-line";
import { getCollectionAccess, listPromises } from "@/features/collection/queries";
import { HolderFiles } from "@/features/files/components/holder-files";
import { listHolderFiles } from "@/features/files/holder-queries";
import type { MoneySubject } from "@/features/payments/money-subject";
import { getInvoicingAccess } from "@/features/invoicing/queries";
import { creditDocumentPath, issueDocumentPath } from "@/features/invoicing/paths";
import { DocumentSendButton } from "@/features/document-links/components/document-send-button";
import { isDocumentLinkType } from "@/features/document-links/public";
import { canManageDocumentLinks, canSendDocuments, documentRecipients, existingDocumentLinks, getDocumentDelivery } from "@/features/document-links/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { documentsPath } from "../paths";
import { documentOrigin } from "../details";
import { getDocumentsAccess, listDocumentLines, listDocumentSources, listRecordDocuments } from "../queries";
import { DocumentDetailsLine, DocumentLinesList } from "./document-details";
import { DOCUMENT_TYPE_LABELS, documentTitle, isOpeningBalance, takesDueDate } from "../schema";
import { ApplyCreditButton, CancelDocumentButton, DueDateButton, RecordDocumentButton } from "./document-forms";

type Props = { orgId: string; subject: MoneySubject };

/**
 * DOC-01: the accounting documents issued outside the system and recorded on this deal or contact (type, number, date,
 * amount). Owners, admins and managers record and cancel them, and whoever holds the personal key `documents`; a record
 * is never deleted. Shown while the plan has the `documents` key. Each document may carry its file (a PDF or an image of
 * what was issued): the same people attach it, a new file becomes the current one and the earlier ones stay as versions.
 * GAP-12: an imported customer's opening balance (no number; a debt, or a negative amount for a credit) is recorded,
 * changed and cancelled by owners and admins only.
 * DOC-15: "שליחה ללקוח" (make and send a link) while the business is writable and the plan holds the key. A link that exists
 * but cannot be made now (the plan lost `documents`, the business is not writable, the document was cancelled) is still shown
 * in status-and-revoke mode to whoever has the link's rights, so it can be turned off and never comes back; without the key
 * the rest of the card stays hidden and only those links are listed.
 */
export async function RecordDocumentsCard({ orgId, subject }: Props) {
  const access = await getDocumentsAccess(orgId);
  if (!access.inPlan) return <DormantDocumentLinks orgId={orgId} subject={subject} />;
  const [{ documents, names }, context, invoicing] = await Promise.all([listRecordDocuments(orgId, subject), getOrgContext(orgId), getInvoicingAccess(orgId)]);
  if (documents.length === 0 && !access.canRecord && !invoicing.canIssue) return null;
  const { files, names: uploaders } = await listHolderFiles(
    orgId,
    "document",
    documents.map((d) => d.id),
  );
  // PAY-02: what each tax invoice and proforma was paid, and its balance and state
  const allocation = await getAllocationAccess(orgId);
  const ids = documents.map((d) => d.id);
  const [money, allocations, credit, offsets] = allocation.inPlan
    ? await Promise.all([
        getMoneyState(orgId, ids, []),
        listAllocations(orgId, { documents: ids }),
        // PAY-03: the customer's credit, offered to a new tax invoice or proforma by whoever may allocate
        access.canRecord && allocation.canAllocate ? getSubjectCredit(orgId, subject) : Promise.resolve(NO_CREDIT),
        // GAP-12: offsets of opening credits, on either side
        listCreditOffsets(orgId, ids),
      ])
    : [null, [], NO_CREDIT, []];
  // COL-03: the payment promises of these documents, while the plan holds collection
  const collection = await getCollectionAccess(orgId);
  const promises = collection.inPlan ? await listPromises(orgId, ids) : { effective: new Map(), own: new Map() };
  const numbers = new Map(documents.map((d) => [d.id, d.number]));
  // DOC-02: each document's lines, and what a new document may name as its source or original
  const [lines, sources] = await Promise.all([
    listDocumentLines(orgId, ids),
    access.canRecord ? listDocumentSources(orgId, subject, documents) : Promise.resolve({ quotes: [], originals: [] }),
  ]);
  const titles = new Map(documents.map((d) => [d.id, documentTitle(d)]));
  // DOC-15: the customer's link to each document, for whoever records or issues documents; where a new link cannot be made
  // (not writable, a cancelled document), an existing link is still shown to turn it off
  const canSend = documents.length > 0 && (await canSendDocuments(orgId, access.canRecord));
  const dormantCandidates = documents.filter((d) => isDocumentLinkType(d.docType) && d.number && (!canSend || d.cancelled)).map((d) => d.id);
  const dormantLinks =
    dormantCandidates.length > 0 && (await canManageDocumentLinks(orgId)) ? await existingDocumentLinks(orgId, dormantCandidates) : new Set<string>();
  const [delivery, recipients] = canSend
    ? await Promise.all([getDocumentDelivery(orgId), documentRecipients(orgId, documents.flatMap((d) => (d.contactId ? [d.contactId] : [])))])
    : ["system" as const, new Map()];
  const quoteLabels = new Map(sources.quotes.map((quote) => [quote.id, quote.label]));
  const today = zoneDate(new Date(), context.org.timeZone);
  const titleId = `documents-${subject.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title="מסמכים חשבונאיים"
        action={
          <span className="flex flex-wrap items-center gap-2">
          {/* DOC-07: issuing through the business's invoice provider, while it is connected and the person may issue */}
          {invoicing.canIssue ? (
            <Link href={issueDocumentPath(orgId, subject.kind, subject.id)} className={buttonClasses("secondary", "sm")}>
              הפקת מסמך
            </Link>
          ) : null}
          {access.canRecord ? <RecordDocumentButton
              orgId={orgId}
              subject={subject}
              today={today}
              credit={credit.total}
              // GAP-12: an opening balance is a contact's (or a company's, on its own card), never a deal's or an order's
              canOpening={access.canOpening && subject.kind === "contact"}
              sources={sources}
            /> : null}
          </span>
        }
      />
      <CardBody className="p-0">
        {documents.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-soft">עוד לא נרשמו מסמכים. כאן רושמים חשבוניות וקבלות שהופקו בתוכנת הנהלת החשבונות.</p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((doc) => {
              const label = documentTitle(doc);
              const opening = isOpeningBalance(doc.docType);
              // GAP-12: an opening balance is changed and cancelled by owners and admins only
              const canChangeDoc = access.canRecord && (!opening || access.canOpening);
              const state = money?.documents.get(doc.id);
              const chip = state ? documentStateChip(state) : null;
              const hasBalance = takesDueDate(doc.docType, doc.amountAgorot);
              // PAY-02 answer 7: overdue = past its due date with a balance left
              const overdue = !doc.cancelled && doc.dueDate !== null && doc.dueDate < today && takesPayments(state);
              // the document's effective promise (its own, else the customer's that covered it); the button edits its own
              const promise = promises.effective.get(doc.id);
              const ownPromise = promises.own.get(doc.id);
              return (
                <li key={doc.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">
                      {opening ? (
                        label
                      ) : (
                        <>
                          {DOCUMENT_TYPE_LABELS[doc.docType]}{" "}
                          <bdi dir="ltr" className="tabular-nums">
                            {doc.number}
                          </bdi>
                        </>
                      )}
                      {doc.cancelled ? (
                        <>
                          {" "}
                          <Badge tone="warning">בוטל</Badge>
                        </>
                      ) : chip ? (
                        <>
                          {" "}
                          <Badge tone={chip.tone}>{chip.label}</Badge>
                        </>
                      ) : null}
                      {overdue ? (
                        <>
                          {" "}
                          <Badge tone="danger">באיחור</Badge>
                        </>
                      ) : null}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {formatDate(`${doc.docDate}T12:00:00Z`)}
                      {doc.createdBy && names.get(doc.createdBy) ? ` · נרשם על ידי ${names.get(doc.createdBy)}` : ""}
                      {/* DOC-01's mark, DOC-02's provider */}
                      {opening ? "" : ` · ${documentOrigin(doc.provider)}`}
                    </p>
                    <DocumentDetailsLine doc={doc} quoteLabel={doc.quoteId ? (quoteLabels.get(doc.quoteId) ?? null) : null} originalLabel={doc.originalDocumentId ? (titles.get(doc.originalDocumentId) ?? null) : null} />
                    <DocumentLinesList lines={lines.get(doc.id) ?? []} />
                    {/* DOC-14: the credit's reason, as it was sent to the provider */}
                    {doc.creditReason ? (
                      <p className="text-sm break-words text-ink-soft">
                        סיבת הזיכוי: <bdi>{doc.creditReason}</bdi>
                      </p>
                    ) : null}
                    {doc.cancelled ? (
                      <p className="text-sm break-words text-ink-soft">
                        בוטל{doc.cancelledAt ? ` ב-${formatDate(doc.cancelledAt)}` : ""}
                        {doc.cancelledBy && names.get(doc.cancelledBy) ? ` על ידי ${names.get(doc.cancelledBy)}` : ""}
                        {doc.cancelReason ? (
                          <>
                            : <bdi>{doc.cancelReason}</bdi>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {state && hasBalance && !doc.cancelled && state.state !== "transferred" ? (
                      <p className="text-sm text-ink-soft">
                        שולם <span className="tabular-nums">{formatMoney(state.paid)}</span>
                        {" · "}יתרה <span className="tabular-nums">{formatMoney(state.balance)}</span>
                        {doc.dueDate ? ` · לתשלום עד ${formatDate(`${doc.dueDate}T12:00:00Z`)}` : ""}
                      </p>
                    ) : null}
                    {opening && doc.amountAgorot < 0 && !doc.cancelled ? (
                      <p className="text-sm text-ink-soft">
                        יתרת זכות של הלקוח
                        {state ? (
                          <>
                            {" · נותרו לקיזוז "}
                            <span className="tabular-nums">{formatMoney(state.credit ?? 0)}</span>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {/* COL-03: shown while the document still owes */}
                    {promise && !doc.cancelled && takesPayments(state) ? (
                      <PromiseLine date={promise.date} note={promise.note} today={today} customer={promise.kind === "customer"} />
                    ) : null}
                    <CreditOffsetRows documentId={doc.id} offsets={offsets} />
                    {doc.proformaId ? (
                      <p className="text-sm text-ink-soft">
                        מחליפה את חשבון העסקה{numbers.get(doc.proformaId) ? <bdi dir="ltr"> {numbers.get(doc.proformaId)}</bdi> : null}
                      </p>
                    ) : null}
                    <AllocationRows
                      orgId={orgId}
                      page={subject}
                      side="document"
                      allocations={allocations.filter((a) => a.documentId === doc.id)}
                      canChange={allocation.canChange}
                    />
                    <HolderFiles
                      orgId={orgId}
                      page={subject}
                      holder={{ kind: "document", id: doc.id }}
                      files={files.get(doc.id)}
                      names={uploaders}
                      canRecord={access.canRecord}
                      label={label}
                    />
                  </div>
                  <span className="flex shrink-0 flex-wrap items-center gap-1">
                    <span className={`font-medium whitespace-nowrap tabular-nums ${doc.cancelled ? "text-ink-soft line-through" : ""}`}>{formatMoney(doc.amountAgorot)}</span>
                    {allocation.canAllocate && !doc.cancelled && takesPayments(state) ? (
                      <AllocateButton orgId={orgId} page={subject} from={{ kind: "document", id: doc.id, label }} available={state?.balance ?? 0} />
                    ) : null}
                    {allocation.canAllocate && credit.total > 0 && !doc.cancelled && takesPayments(state) ? (
                      <ApplyCreditButton orgId={orgId} subject={subject} documentId={doc.id} label={label} />
                    ) : null}
                    {collection.canPromise && !doc.cancelled && hasBalance && takesPayments(state) ? (
                      <PromiseButton orgId={orgId} target={{ kind: "document", id: doc.id }} label={label} back={subject} current={ownPromise ?? null} today={today} />
                    ) : null}
                    {canChangeDoc && !doc.cancelled && hasBalance && state?.state !== "transferred" ? (
                      <DueDateButton orgId={orgId} subject={subject} documentId={doc.id} label={label} dueDate={doc.dueDate} />
                    ) : null}
                    {access.canRecord && !doc.cancelled && doc.docType === "tax_invoice" && !doc.proformaId ? (
                      <LinkProformaButton orgId={orgId} page={subject} invoiceId={doc.id} invoiceLabel={label} />
                    ) : null}
                    {/* DOC-14: a credit invoice through the provider that issued it, by whoever may credit */}
                    {invoicing.canCredit && !doc.cancelled && doc.provider !== null && doc.provider === invoicing.offered && (doc.docType === "tax_invoice" || doc.docType === "tax_invoice_receipt") ? (
                      <Link href={creditDocumentPath(orgId, doc.id)} className={buttonClasses("ghost", "sm")} aria-label={`זיכוי ${label}`}>
                        זיכוי
                      </Link>
                    ) : null}
                    {canSend && !doc.cancelled && isDocumentLinkType(doc.docType) && doc.number ? (
                      <DocumentSendButton
                        orgId={orgId}
                        documentId={doc.id}
                        title={label}
                        businessName={context.org.name}
                        recipient={(doc.contactId ? recipients.get(doc.contactId) : null) ?? { name: null, phoneE164: null, email: null }}
                        logOn={doc.contactId && recipients.has(doc.contactId) ? { kind: "contact", id: doc.contactId } : doc.dealId ? { kind: "deal", id: doc.dealId } : null}
                        providerEmails={delivery === "provider" && doc.provider !== null}
                      />
                    ) : dormantLinks.has(doc.id) ? (
                      <DocumentSendButton
                        orgId={orgId}
                        documentId={doc.id}
                        title={label}
                        businessName={context.org.name}
                        recipient={{ name: null, phoneE164: null, email: null }}
                        logOn={null}
                        providerEmails={false}
                        manageOnly
                      />
                    ) : null}
                    {canChangeDoc && !doc.cancelled ? <CancelDocumentButton orgId={orgId} subject={subject} documentId={doc.id} label={label} /> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {/* LST-09: the business-wide list */}
        <p className="border-t border-line px-4 py-2 text-sm">
          <Link href={documentsPath(orgId)} className="text-accent-strong underline-offset-4 hover:underline">
            לכל המסמכים
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * DOC-15: the plan lost the `documents` key, so the card is hidden; only the documents of this record whose customer link
 * still exists are listed, in status-and-revoke mode, to whoever has the link's rights (the database judges each one again).
 */
async function DormantDocumentLinks({ orgId, subject }: Props) {
  if (!(await canManageDocumentLinks(orgId))) return null;
  const [{ documents }, context] = await Promise.all([listRecordDocuments(orgId, subject), getOrgContext(orgId)]);
  const linkable = documents.filter((d) => isDocumentLinkType(d.docType) && d.number);
  if (linkable.length === 0) return null;
  const existing = await existingDocumentLinks(
    orgId,
    linkable.map((d) => d.id),
  );
  const shown = linkable.filter((d) => existing.has(d.id));
  if (shown.length === 0) return null;
  const titleId = `document-links-${subject.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title="קישורים ללקוח למסמכים" />
      <CardBody className="p-0">
        <p className="px-4 pt-3 text-sm text-ink-soft">המסמכים לא כלולים בחבילה כרגע, ולכן הקישורים לא פעילים. אפשר לבטל אותם.</p>
        <ul className="divide-y divide-line">
          {shown.map((doc) => {
            const label = documentTitle(doc);
            return (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="text-sm font-medium">{label}</span>
                <DocumentSendButton
                  orgId={orgId}
                  documentId={doc.id}
                  title={label}
                  businessName={context.org.name}
                  recipient={{ name: null, phoneE164: null, email: null }}
                  logOn={null}
                  providerEmails={false}
                  manageOnly
                />
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
