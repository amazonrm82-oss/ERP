import "server-only";

import type { TimelineSubject } from "@/features/activities/schema";
import { getUserNames } from "@/features/shell/queries";
import { createClient } from "@/lib/supabase/server";

import { FILES_BUCKET, opensInBrowser, SUBJECT_COLUMN } from "./types";
import { versionGroups } from "./versions";

export type RecordFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploaderName: string | null;
  createdAt: string;
  // REC-07: the timeline entry it is attached to, and the earlier version it replaces
  activityId: string | null;
  previousId: string | null;
  // a short-lived link to show a small preview of an image
  thumbnailUrl: string | null;
  // FLD-06 part B: a file field's file (the field's label), and whether it is the field's current value. A replaced field
  // file stays as the earlier version of the new one (owner, 26 October 2026, answer (ב)) and is listed with the record's files.
  fieldKey: string | null;
  fieldLabel: string | null;
  inField: boolean;
};

const RECORD_TABLE = { lead: "leads", contact: "contacts", company: "companies", deal: "deals" } as const;

export async function listFiles(orgId: string, subject: TimelineSubject): Promise<RecordFile[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("files")
    .select("id, name, mime_type, size_bytes, storage_path, uploaded_by, created_at, activity_id, previous_id, custom_field_key")
    .eq("organization_id", orgId)
    .eq(SUBJECT_COLUMN[subject.kind], subject.id)
    // FXS-07: an upload that has not been confirmed is not shown
    .is("unconfirmed_since", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`files query failed: ${error.message}`);
  // FLD-06 part B: which field files are a field's current value, and the fields' labels
  const fieldKeys = [...new Set(data.flatMap((f) => (f.custom_field_key ? [f.custom_field_key] : [])))];
  const current = new Set<string>();
  const labels = new Map<string, string>();
  if (fieldKeys.length > 0) {
    const [record, definitions] = await Promise.all([
      supabase.from(RECORD_TABLE[subject.kind]).select("custom_fields").eq("organization_id", orgId).eq("id", subject.id).maybeSingle(),
      supabase.from("field_definitions").select("key, label").eq("organization_id", orgId).eq("object_type", subject.kind).in("key", fieldKeys),
    ]);
    if (record.error) throw new Error(`files query failed: ${record.error.message}`);
    if (definitions.error) throw new Error(`files query failed: ${definitions.error.message}`);
    const values = record.data?.custom_fields;
    if (values && typeof values === "object" && !Array.isArray(values)) {
      for (const key of fieldKeys) {
        const value = (values as Record<string, unknown>)[key];
        if (typeof value === "string") current.add(`${key}:${value}`);
      }
    }
    for (const d of definitions.data) labels.set(d.key, d.label);
  }
  const images = data.filter((f) => f.mime_type.startsWith("image/") && opensInBrowser(f.mime_type));
  const thumbs = new Map<string, string>();
  if (images.length > 0) {
    const { data: signed, error: signError } = await supabase.storage.from(FILES_BUCKET).createSignedUrls(
      images.map((f) => f.storage_path),
      600,
    );
    // a thumbnail is a nicety: when the links cannot be made, the files are listed without one
    if (!signError) for (const s of signed) if (s.path && s.signedUrl) thumbs.set(s.path, s.signedUrl);
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
    activityId: f.activity_id,
    previousId: f.previous_id,
    thumbnailUrl: thumbs.get(f.storage_path) ?? null,
    fieldKey: f.custom_field_key,
    fieldLabel: f.custom_field_key ? (labels.get(f.custom_field_key) ?? null) : null,
    inField: f.custom_field_key !== null && current.has(`${f.custom_field_key}:${f.id}`),
  }));
}

/** REC-07: a file shown under its timeline entry (the current version; the files card has the history). */
export type NoteFile = { id: string; name: string; mimeType: string; sizeBytes: number; versions: number };

/** The files on these timeline entries that the user may see (RLS follows each entry), by entry. */
export async function listNoteFiles(orgId: string, activityIds: string[]): Promise<Map<string, NoteFile[]>> {
  const byNote = new Map<string, NoteFile[]>();
  if (activityIds.length === 0) return byNote;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("files")
    .select("id, name, mime_type, size_bytes, created_at, activity_id, previous_id")
    .eq("organization_id", orgId)
    .in("activity_id", activityIds)
    .is("unconfirmed_since", null)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(`note files query failed: ${error.message}`);
  const groups = versionGroups(data.map((f) => ({ ...f, previousId: f.previous_id, createdAt: f.created_at })));
  for (const { current, earlier } of groups) {
    const note = current.activity_id as string;
    const list = byNote.get(note) ?? [];
    list.push({ id: current.id, name: current.name, mimeType: current.mime_type, sizeBytes: current.size_bytes, versions: earlier.length + 1 });
    byNote.set(note, list);
  }
  return byNote;
}
