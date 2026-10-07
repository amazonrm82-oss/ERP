import "server-only";

import type { TimelineSubject } from "@/features/activities/schema";
import { getUserNames } from "@/features/shell/queries";
import { createClient } from "@/lib/supabase/server";

import { FILES_BUCKET, SUBJECT_COLUMN } from "./types";

export type RecordFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploaderName: string | null;
  createdAt: string;
  // a short-lived link to show a small preview of an image
  thumbnailUrl: string | null;
};

export async function listFiles(orgId: string, subject: TimelineSubject): Promise<RecordFile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("files")
    .select("id, name, mime_type, size_bytes, storage_path, uploaded_by, created_at")
    .eq("organization_id", orgId)
    .eq(SUBJECT_COLUMN[subject.kind], subject.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`files query failed: ${error.message}`);
  const images = data.filter((f) => f.mime_type.startsWith("image/") && f.mime_type !== "image/heic");
  const thumbs = new Map<string, string>();
  if (images.length > 0) {
    const { data: signed } = await supabase.storage.from(FILES_BUCKET).createSignedUrls(
      images.map((f) => f.storage_path),
      600,
    );
    for (const s of signed ?? []) if (s.path && s.signedUrl) thumbs.set(s.path, s.signedUrl);
  }
  const names = await getUserNames(data.map((f) => f.uploaded_by));
  return data.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mime_type,
    sizeBytes: f.size_bytes,
    uploadedBy: f.uploaded_by,
    uploaderName: f.uploaded_by ? (names.get(f.uploaded_by) ?? null) : null,
    createdAt: f.created_at,
    thumbnailUrl: thumbs.get(f.storage_path) ?? null,
  }));
}
