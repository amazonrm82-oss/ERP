import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { HolderFiles } from "@/features/files/components/holder-files";
import { listHolderFiles } from "@/features/files/holder-queries";
import type { MoneySubject } from "@/features/payments/money-subject";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { documentsPath } from "../paths";
import { getDocumentsAccess, listRecordDocuments } from "../queries";
import { DOCUMENT_TYPE_LABELS } from "../schema";
import { CancelDocumentButton, RecordDocumentButton } from "./document-forms";

type Props = { orgId: string; subject: MoneySubject };

/**
 * DOC-01: the accounting documents issued outside the system and recorded on this deal or contact (type, number, date,
 * amount). Owners, admins and managers record and cancel them, and whoever holds the personal key `documents`; a record
 * is never deleted. Shown while the plan has the `documents` key. Each document may carry its file (a PDF or an image of
 * what was issued): the same people attach it, a new file becomes the current one and the earlier ones stay as versions.
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
  const titleId = `documents-${subject.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title="מסמכים חשבונאיים"
        action={access.canRecord ? <RecordDocumentButton orgId={orgId} subject={subject} today={zoneDate(new Date(), context.org.timeZone)} /> : null}
      />
      <CardBody className="p-0">
        {documents.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-soft">עוד לא נרשמו מסמכים. כאן רושמים חשבוניות וקבלות שהופקו בתוכנת הנהלת החשבונות.</p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((doc) => {
              const label = `${DOCUMENT_TYPE_LABELS[doc.docType]} ${doc.number}`;
              return (
                <li key={doc.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">
                      {DOCUMENT_TYPE_LABELS[doc.docType]}{" "}
                      <bdi dir="ltr" className="tabular-nums">
                        {doc.number}
                      </bdi>
                      {doc.cancelled ? (
                        <>
                          {" "}
                          <Badge tone="warning">בוטל</Badge>
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
                  <span className="flex shrink-0 items-center gap-1">
                    <span className={`font-medium whitespace-nowrap tabular-nums ${doc.cancelled ? "text-ink-soft line-through" : ""}`}>{formatMoney(doc.amountAgorot)}</span>
                    {access.canRecord && !doc.cancelled ? <CancelDocumentButton orgId={orgId} subject={subject} documentId={doc.id} label={label} /> : null}
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

