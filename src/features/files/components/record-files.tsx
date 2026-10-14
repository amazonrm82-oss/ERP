import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { TimelineSubject } from "@/features/activities/schema";
import { printedFileLine } from "@/features/print/print";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

import { deleteFileAction } from "../actions";
import { listFiles } from "../queries";
import { ALLOWED_TYPES, formatBytes } from "../types";
import { FileUploader } from "./file-uploader";

type Props = { orgId: string; subject: TimelineSubject; canWrite: boolean; userId: string; isAdmin: boolean };

/** Files card of a record: upload (drag and drop or pick), then the list, newest first. */
export async function RecordFiles({ orgId, subject, canWrite, userId, isAdmin }: Props) {
  const files = await listFiles(orgId, subject);

  return (
    // GAP-11 (owner, 14 October 2026): on paper, name, date and uploader of each file, no content
    // or links; a record with no files prints no files section
    <Card aria-labelledby="files-title" className={files.length === 0 ? "print:hidden" : undefined}>
      <CardHeader id="files-title" title={files.length ? `קבצים (${files.length})` : "קבצים"} />
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
            {files.map((file) => {
              const viewable = file.mimeType.startsWith("image/") || file.mimeType === "application/pdf";
              return (
                <li key={file.id} className="flex flex-wrap items-center gap-3 py-2.5">
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
                      {formatBytes(file.sizeBytes)} · {formatDateTime(file.createdAt)}
                      {file.uploaderName ? ` · ${file.uploaderName}` : ""}
                    </p>
                  </div>
                  {canWrite && (file.uploadedBy === userId || isAdmin) ? (
                    <ActionButton
                      action={deleteFileAction.bind(null, orgId, subject, file.id)}
                      pendingText="מוחקים…"
                      variant="danger-ghost"
                      srLabel={file.name}
                      confirm="למחוק את הקובץ? אי אפשר לשחזר."
                    >
                      מחיקה
                    </ActionButton>
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
