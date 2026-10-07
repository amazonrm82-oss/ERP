import type { SubjectKind } from "@/features/activities/schema";

export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const FILES_BUCKET = "record-files";

// What may be uploaded: documents, images and archives. No HTML, SVG or scripts,
// which a browser could run when the file is opened.
export const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "תמונה",
  "image/png": "תמונה",
  "image/gif": "תמונה",
  "image/webp": "תמונה",
  "image/heic": "תמונה",
  "text/plain": "טקסט",
  "text/csv": "CSV",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.ms-excel": "Excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.ms-powerpoint": "PowerPoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "application/zip": "ZIP",
};
export const ACCEPT = Object.keys(ALLOWED_TYPES).join(",");

export const SUBJECT_COLUMN: Record<SubjectKind, "lead_id" | "contact_id" | "company_id" | "deal_id"> = {
  lead: "lead_id",
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
