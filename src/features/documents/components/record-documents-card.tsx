import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatBytes, opensInBrowser } from "@/features/files/types";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatDateTime, formatMoney, zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import { deleteDocumentFileAction } from "../file-actions";
import { getDocumentsAccess, listDocumentFiles, listRecordDocuments, type DocumentFile } from "../queries";
import { DOCUMENT_TYPE_LABELS } from "../schema";
import { DocumentFileButton } from "./document-file-button";
import { CancelDocumentButton, RecordDocumentButton } from "./document-forms";

type Props = { orgId: string; subject: { kind: "deal" | "contact"; id: string } };

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
  const { files, names: uploaders } = await listDocumentFiles(
    orgId,
    documents.map((d) => d.id),
  );
  const isAdmin = context.role === "owner" || context.role === "admin";
  // the uploader or an admin removes a file (the database decides; this only hides a button that would fail)
  const canRemove = (file: DocumentFile) => access.canRecord && (file.uploadedBy === context.user.id || isAdmin);
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
              const docFiles = files.get(doc.id);
              const current = docFiles?.current ?? null;
              const earlier = docFiles?.earlier ?? [];
              const latestId = docFiles?.latestId ?? null;
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
                    {current ? (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
                        <FileLink orgId={orgId} file={current} />
                        <span className="text-ink-soft">
                          {earlier.length > 0 ? `גרסה ${earlier.length + 1} · ` : ""}
                          {formatBytes(current.sizeBytes)} · {formatDateTime(current.createdAt)}
                          {current.uploadedBy && uploaders.get(current.uploadedBy) ? ` · ${uploaders.get(current.uploadedBy)}` : ""}
                        </span>
                        {canRemove(current) ? (
                          <ActionButton
                            action={deleteDocumentFileAction.bind(null, orgId, subject, current.id)}
                            pendingText="מוחקים…"
                            variant="danger-ghost"
                            srLabel={`${current.name}, ${label}`}
                            confirm={earlier.length > 0 ? "למחוק את הקובץ הזה? הגרסה הקודמת תחזור להיות הנוכחית. אי אפשר לשחזר." : "למחוק את הקובץ? אי אפשר לשחזר."}
                          >
                            מחיקה
                          </ActionButton>
                        ) : null}
                      </div>
                    ) : null}
                    {earlier.length > 0 ? (
                      <details className="mt-1 text-sm">
                        <summary className="cursor-pointer text-ink-soft">גרסאות קודמות ({earlier.length})</summary>
                        <ul className="mt-1 space-y-1">
                          {earlier.map((old, index) => (
                            <li key={old.id} className="flex flex-wrap items-center gap-x-2">
                              <span className="text-ink-soft">גרסה {earlier.length - index}:</span>
                              <FileLink orgId={orgId} file={old} />
                              <span className="text-ink-soft">{formatDateTime(old.createdAt)}</span>
                              {canRemove(old) ? (
                                <ActionButton
                                  action={deleteDocumentFileAction.bind(null, orgId, subject, old.id)}
                                  pendingText="מוחקים…"
                                  variant="danger-ghost"
                                  srLabel={`גרסה ${earlier.length - index} של ${old.name}, ${label}`}
                                  confirm="למחוק את הגרסה הקודמת הזאת? אי אפשר לשחזר."
                                >
                                  מחיקה
                                </ActionButton>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {access.canRecord ? <DocumentFileButton orgId={orgId} subject={subject} documentId={doc.id} latestId={latestId} label={label} /> : null}
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
      </CardBody>
    </Card>
  );
}

/** A document's file: opens in the browser (PDF and common images), else downloads. */
function FileLink({ orgId, file }: { orgId: string; file: DocumentFile }) {
  const viewable = opensInBrowser(file.mimeType);
  return (
    <a
      href={`${paths.file(orgId, file.id)}${viewable ? "?view=1" : ""}`}
      target={viewable ? "_blank" : undefined}
      rel="noopener"
      className="min-w-0 truncate font-medium text-accent-strong underline-offset-4 hover:underline"
    >
      {file.name}
      {viewable ? <span className="sr-only"> (נפתח בחלון חדש)</span> : null}
    </a>
  );
}
