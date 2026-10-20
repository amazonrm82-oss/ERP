import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { FileHolder, HolderFile, HolderFiles as HolderFilesData, HolderPage } from "../holder";
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
  // may record documents (payments) here: attach a file or a new version
  canRecord: boolean;
  // what the document or payment is called, for screen readers
  label: string;
};

/**
 * DOC-01 / PAY-01 follow-ups: under a document or a payment, its current file (opens in the browser), its earlier versions,
 * and a button to attach a file or a new one. Nobody removes one (owner, 20 October 2026): a new version replaces it and
 * the earlier ones stay.
 */
export function HolderFiles({ orgId, page, holder, files, names, canRecord, label }: Props) {
  const current = files?.current ?? null;
  const earlier = files?.earlier ?? [];
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
