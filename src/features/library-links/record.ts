// LIB-02: the record a library link is sent to (one of the four record types)

export type LibraryRecordKind = "lead" | "contact" | "company" | "deal";

export type LibraryRecord = { kind: LibraryRecordKind; id: string };

export const LIBRARY_RECORD_KINDS: readonly LibraryRecordKind[] = ["lead", "contact", "company", "deal"];

export function isLibraryRecordKind(value: unknown): value is LibraryRecordKind {
  return typeof value === "string" && (LIBRARY_RECORD_KINDS as readonly string[]).includes(value);
}
