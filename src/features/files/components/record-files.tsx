import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { TimelineSubject } from "@/features/activities/schema";
import { printedFileLine } from "@/features/print/print";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

import { deleteFileAction } from "../actions";
import { listFiles } from "../queries";
import { ALLOWED_TYPES, formatBytes, opensInBrowser } from "../types";
import { versionGroups } from "../versions";
import { FileUploader } from "./file-uploader";
import { NewVersionButton } from "./new-version-button";

type Props = { orgId: string; subject: TimelineSubject; canWrite: boolean; userId: string; isAdmin: boolean };

/** Files card of a record: upload (drag and drop or pick), then the list, newest first. */
export async function RecordFiles({ orgId, subject, canWrite, userId, isAdmin }: Props) {
  const files = await listFiles(orgId, subject);
  // REC-07: each file once, at its current version, with its earlier versions under it
  const groups = versionGroups(files);

  return (
    // GAP-11 (owner, 14 October 2026): on paper, name, date and uploader of each file, no content
    // or links; a record with no files prints no files section
    <Card aria-labelledby="files-title" className={files.length === 0 ? "print:hidden" : undefined}>
      <CardHeader id="files-title" title={groups.length ? `קבצים (${groups.length})` : "קבצים"} />
      <CardBody className="space-y-4">
        {canWrite ? (
          <div className="print:hidden">
            <FileUploader orgId={orgId} subject={subject} />
          </div>
        ) : null}
        {files.length === 0 ? (
          <p className="text-md text-ink-soft">אין קבצים.</p>
        ) : (
          <ul className="divide-y divide-line">
            {groups.map(({ current: file, earlier }) => {
              const viewable = opensInBrowser(file.mimeType);
              return (
                <li key={file.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-3">
                    {file.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link
                      <img src={file.thumbnailUrl} alt="" className="size-11 shrink-0 rounded-md border border-line object-cover print:hidden" />
                    ) : (
                      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-md bg-canvas text-xs font-semibold text-ink-soft print:hidden">
                        {ALLOWED_TYPES[file.mimeType] ?? "קובץ"}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <a
                        href={`${paths.file(orgId, file.id)}${viewable ? "?view=1" : ""}`}
                        target={viewable ? "_blank" : undefined}
                        rel="noopener"
                        className="block truncate font-medium text-accent-strong underline-offset-4 hover:underline print:hidden"
                      >
                        {file.name}
                      </a>
                      <p className="hidden break-words font-medium print:block">{file.name}</p>
                      <p className="hidden text-sm text-ink-soft print:block">{printedFileLine(formatDateTime(file.createdAt), file.uploaderName)}</p>
                      <p className="text-sm text-ink-soft print:hidden">
                        {earlier.length > 0 ? `גרסה ${earlier.length + 1} · ` : ""}
                        {formatBytes(file.sizeBytes)} · {formatDateTime(file.createdAt)}
                        {file.uploaderName ? ` · ${file.uploaderName}` : ""}
                        {file.activityId ? " · מצורף להערה בציר הזמן" : ""}
                      </p>
                    </div>
                    {canWrite ? (
                      <span className="print:hidden">
                        <NewVersionButton orgId={orgId} subject={subject} fileId={file.id} activityId={file.activityId} fileName={file.name} />
                      </span>
                    ) : null}
                    {canWrite && (file.uploadedBy === userId || isAdmin) ? (
                      <ActionButton
                        action={deleteFileAction.bind(null, orgId, subject, file.id)}
                        pendingText="מוחקים…"
                        variant="danger-ghost"
                        srLabel={file.name}
                        confirm={earlier.length > 0 ? "למחוק את הגרסה הזאת? הגרסה הקודמת תחזור להיות הנוכחית. אי אפשר לשחזר." : "למחוק את הקובץ? אי אפשר לשחזר."}
                      >
                        מחיקה
                      </ActionButton>
                    ) : null}
                  </div>
                  {earlier.length > 0 ? (
                    <details className="mt-2 ps-14 print:hidden">
                      <summary className="cursor-pointer text-sm text-ink-soft">גרסאות קודמות ({earlier.length})</summary>
                      <ul className="mt-1 space-y-1">
                        {earlier.map((old, index) => (
                          <li key={old.id} className="flex flex-wrap items-center gap-2 text-sm">
                            <a href={paths.file(orgId, old.id)} className="text-accent-strong underline-offset-4 hover:underline">
                              גרסה {earlier.length - index}: {old.name}
                            </a>
                            <span className="text-ink-soft">
                              {formatBytes(old.sizeBytes)} · {formatDateTime(old.createdAt)}
                              {old.uploaderName ? ` · ${old.uploaderName}` : ""}
                            </span>
                            {canWrite && (old.uploadedBy === userId || isAdmin) ? (
                              <ActionButton
                                action={deleteFileAction.bind(null, orgId, subject, old.id)}
                                pendingText="מוחקים…"
                                variant="danger-ghost"
                                srLabel={`גרסה ${earlier.length - index} של ${old.name}`}
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
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
