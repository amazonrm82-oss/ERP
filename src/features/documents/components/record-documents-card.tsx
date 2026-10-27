import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AllocateButton, LinkProformaButton } from "@/features/allocations/components/allocation-forms";
import { AllocationRows } from "@/features/allocations/components/allocation-rows";
import { NO_CREDIT } from "@/features/allocations/credit";
import { getAllocationAccess, getMoneyState, getSubjectCredit, listAllocations, listCreditOffsets } from "@/features/allocations/queries";
import { CreditOffsetRows } from "@/features/allocations/components/credit-offset-rows";
import { documentStateChip, takesPayments } from "@/features/allocations/state";
import { HolderFiles } from "@/features/files/components/holder-files";
import { listHolderFiles } from "@/features/files/holder-queries";
import type { MoneySubject } from "@/features/payments/money-subject";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { documentsPath } from "../paths";
import { getDocumentsAccess, listRecordDocuments } from "../queries";
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
 */
export async function RecordDocumentsCard({ orgId, subject }: Props) {
  const access = await getDocumentsAccess(orgId);
  if (!access.inPlan) return null;
  const [{ documents, names }, context] = await Promise.all([listRecordDocuments(orgId, subject), getOrgContext(orgId)]);
  if (documents.length === 0 && !access.canRecord) return null;
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
  const numbers = new Map(documents.map((d) => [d.id, d.number]));
  const today = zoneDate(new Date(), context.org.timeZone);
  const titleId = `documents-${subject.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title="מסמכים חשבונאיים"
        action={
          access.canRecord ? <RecordDocumentButton
              orgId={orgId}
              subject={subject}
              today={today}
              credit={credit.total}
              // GAP-12: an opening balance is a contact's (or a company's, on its own card), never a deal's or an order's
              canOpening={access.canOpening && subject.kind === "contact"}
            /> : null
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
                    </p>
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
                    {canChangeDoc && !doc.cancelled && hasBalance && state?.state !== "transferred" ? (
                      <DueDateButton orgId={orgId} subject={subject} documentId={doc.id} label={label} dueDate={doc.dueDate} />
                    ) : null}
                    {access.canRecord && !doc.cancelled && doc.docType === "tax_invoice" && !doc.proformaId ? (
                      <LinkProformaButton orgId={orgId} page={subject} invoiceId={doc.id} invoiceLabel={label} />
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

