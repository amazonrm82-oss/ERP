import "server-only";

import type { EmailAttachmentRef } from "./providers/types";

/**
 * EML-01 (owner (195) א): the files of an email are read from Storage ONLY at the paths public.email_job_compose answered
 * for the job's live lease, with the worker's client (src/features/jobs/run-server.ts hands it in; this file imports no
 * key). Only the private bucket record-files, only a path "<business>/<file id>" of the job's own business. Nothing is
 * kept or logged; the bytes go to the adapter as base64.
 */
export const EMAIL_ATTACHMENT_BUCKET = "record-files";
/** A file not read within the time left of its email's reads (send-handler.ts, 30 s for all files together) is not sent now. */
export const EMAIL_ATTACHMENT_TIMEOUT_MS = 30_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH = new RegExp(`^(${UUID})/${UUID}$`);

export type StorageReader = {
  storage: { from(bucket: string): { download(path: string): Promise<{ data: Blob | null; error: unknown }> } };
};

/** Whether a reference may be read for a job of this business. */
export function attachmentRefAllowed(ref: EmailAttachmentRef, organizationId: string): boolean {
  const match = PATH.exec(ref.path);
  return ref.bucket === EMAIL_ATTACHMENT_BUCKET && match !== null && match[1] === organizationId;
}

/** The file's bytes as base64, or null when it may not be read or cannot be read now. */
export async function downloadEmailAttachment(
  client: StorageReader,
  ref: EmailAttachmentRef,
  organizationId: string,
  timeoutMs: number = EMAIL_ATTACHMENT_TIMEOUT_MS,
): Promise<string | null> {
  if (!attachmentRefAllowed(ref, organizationId)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, Math.min(timeoutMs, EMAIL_ATTACHMENT_TIMEOUT_MS)));
  });
  const read = (async () => {
    try {
      const { data, error } = await client.storage.from(EMAIL_ATTACHMENT_BUCKET).download(ref.path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer()).toString("base64");
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
