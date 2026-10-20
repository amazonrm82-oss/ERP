import { ActionButton } from "@/components/action-button";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { FileHolder, HolderFile, HolderFiles as HolderFilesData, HolderPage } from "../holder";
import { deleteHolderFileAction } from "../holder-actions";
import { formatBytes, opensInBrowser } from "../types";
import { HolderFileButton } from "./holder-file-button";

type Props = {
  orgId: string;
  page: HolderPage;
  holder: FileHolder;
  // this holder's files, if any
  files: HolderFilesData | undefined;
  // uploader names by user id
  names: Map<string, string>;
  // may record documents (payments) here: attach, and remove one's own
  canRecord: boolean;
  userId: string;
  isAdmin: boolean;
  // what the document or payment is called, for screen readers
  label: string;
};

/**
 * DOC-01 / PAY-01 follow-ups: under a document or a payment, its current file (opens in the browser), its earlier versions,
 * a button to attach a file or a new one, and removal for the uploader or an admin.
 */
export function HolderFiles({ orgId, page, holder, files, names, canRecord, userId, isAdmin, label }: Props) {
  const current = files?.current ?? null;
  const earlier = files?.earlier ?? [];
  // the database decides; this only hides a button that would fail
  const canRemove = (file: HolderFile) => canRecord && (file.uploadedBy === userId || isAdmin);
  return (
    <>
      {current ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
          <FileLink orgId={orgId} file={current} />
          <span className="text-ink-soft">
            {earlier.length > 0 ? `גרסה ${earlier.length + 1} · ` : ""}
            {formatBytes(current.sizeBytes)} · {formatDateTime(current.createdAt)}
            {current.uploadedBy && names.get(current.uploadedBy) ? ` · ${names.get(current.uploadedBy)}` : ""}
          </span>
          {canRemove(current) ? (
            <ActionButton
              action={deleteHolderFileAction.bind(null, orgId, page, holder, current.id)}
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
                    action={deleteHolderFileAction.bind(null, orgId, page, holder, old.id)}
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
      {canRecord ? <HolderFileButton orgId={orgId} page={page} holder={holder} latestId={files?.latestId ?? null} label={label} /> : null}
    </>
  );
}

/** A file: opens in the browser (PDF and common images), else downloads. */
function FileLink({ orgId, file }: { orgId: string; file: HolderFile }) {
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
