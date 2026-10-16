"use client";

import type { TimelineSubject } from "@/features/activities/schema";
import { createClient } from "@/lib/supabase/client";

import { finishUploadAction, prepareUploadAction } from "./actions";
import { FILES_BUCKET } from "./types";

/** REC-07: what a new file is attached to: a timeline entry, and/or the earlier version it replaces. */
export type FileLink = { activityId?: string; previousId?: string };

/**
 * Uploads files one by one: a row on the server (which checks the rights, the plan's storage and the links), then
 * the object straight to Storage with the user's session. Answers the messages of the files that failed.
 */
export async function uploadFiles(
  orgId: string,
  subject: TimelineSubject,
  files: File[],
  link: FileLink = {},
  onProgress?: (index: number, file: File) => void,
): Promise<string[]> {
  const problems: string[] = [];
  const supabase = createClient();
  for (const [index, file] of files.entries()) {
    onProgress?.(index, file);
    const prepared = await prepareUploadAction(orgId, subject, { name: file.name, size: file.size, type: file.type || "application/octet-stream" }, link);
    if (!prepared.ok) {
      problems.push(prepared.message);
      continue;
    }
    const { error } = await supabase.storage.from(FILES_BUCKET).upload(prepared.path, file, { contentType: file.type, upsert: false });
    const finished = await finishUploadAction(orgId, subject, prepared.id, !error);
    if (error) problems.push(`ההעלאה של ${file.name} נכשלה. נסו שוב.`);
    else if (!finished.ok) problems.push(`${file.name}: ${finished.message}`);
  }
  return problems;
}
