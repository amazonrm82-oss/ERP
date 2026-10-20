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

// DOC-01 / PAY-01 follow-ups: a recorded accounting document or payment takes a PDF or an image only (app.document_file_types)
export const DOCUMENT_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"] as const;
export const DOCUMENT_ACCEPT = DOCUMENT_FILE_TYPES.join(",");
export const ATTACHMENT_TYPE_PROBLEM = "למסמך או לתשלום אפשר לצרף רק PDF או תמונה.";
export function isDocumentFileType(type: string): boolean {
  return (DOCUMENT_FILE_TYPES as readonly string[]).includes(type);
}

// FXS-07: the types that open inside the browser (?view=1, thumbnails). Everything else downloads, SVG above all
// (files from before the bucket refused it): an SVG opened on the storage domain can run a script.
const INLINE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);
export function opensInBrowser(mimeType: string): boolean {
  return INLINE_TYPES.has(mimeType);
}

// FXS-07: why confirm_file_upload() refused what arrived (reason codes of the database function)
const UPLOAD_PROBLEMS: Record<string, string> = {
  missing: "הקובץ לא הגיע במלואו. נסו להעלות אותו שוב.",
  empty: "הקובץ ריק.",
  size: "הקובץ גדול מ-25 MB.",
  type: "סוג הקובץ שהתקבל אינו מותר. אפשר: PDF, תמונות, Word, Excel, PowerPoint, טקסט, CSV ו-ZIP.",
  quota: "נגמר נפח האחסון בחבילה. אפשר למחוק קבצים ישנים.",
};
export function uploadProblemMessage(reason: unknown): string {
  return (typeof reason === "string" && UPLOAD_PROBLEMS[reason]) || UPLOAD_PROBLEMS.missing;
}

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
