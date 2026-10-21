// DOC-01 / PAY-01 follow-ups: a file may belong to a recorded accounting document or payment instead of a record (one
// subject each; migrations document_files, payment_files). Shared by the documents and payments cards.

export type FileHolderKind = "document" | "payment";
export type FileHolder = { kind: FileHolderKind; id: string };

export const HOLDER_COLUMN = { document: "accounting_document_id", payment: "payment_id" } as const satisfies Record<FileHolderKind, string>;

// the record page the holder is shown on (for revalidation): a deal, a contact or an order (ORD-06 part two)
export type HolderPage = { kind: "deal" | "contact" | "order"; id: string };

/** A holder's file, as shown. */
export type HolderFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
};

/**
 * A holder's current file (null while its only upload still waits) and its earlier versions, newest first. `latestId` is
 * the newest row of the line (it may still be waiting): a new file names it, and the database links the new one after it.
 */
export type HolderFiles = { current: HolderFile | null; earlier: HolderFile[]; latestId: string };
