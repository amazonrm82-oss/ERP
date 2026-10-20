import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ALLOWED_TYPES, DOCUMENT_FILE_TYPES, isDocumentFileType, opensInBrowser, uploadProblemMessage } from "@/features/files/types";

// FXS-07: the bucket's allowed types (app.file_allowed_types) equal the app's list, and only safe types open in the browser.
const dir = join(process.cwd(), "supabase/migrations");
const sqlTypes = (): string[] => {
  const file = readdirSync(dir).filter((f) => f.endsWith("_upload_confirmation.sql"))[0];
  const sql = readFileSync(join(dir, file), "utf8");
  const body = sql.slice(sql.indexOf("create or replace function app.file_allowed_types()"));
  const array = body.slice(body.indexOf("array["), body.indexOf("]::text[]"));
  return [...array.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe("upload confirmation (FXS-07)", () => {
  it("the bucket's list is the app's list", () => {
    expect(sqlTypes()).toEqual(Object.keys(ALLOWED_TYPES));
  });

  it("only PDFs and common images open in the browser; SVG and HTML never do", () => {
    for (const t of ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]) expect(opensInBrowser(t)).toBe(true);
    for (const t of ["image/svg+xml", "text/html", "image/heic", "text/plain", "application/zip", "IMAGE/PNG", ""]) expect(opensInBrowser(t)).toBe(false);
  });

  it("every refusal of the database has a message, and an unknown one falls back", () => {
    for (const reason of ["missing", "empty", "size", "type", "quota"]) expect(uploadProblemMessage(reason)).toMatch(/\S/);
    expect(uploadProblemMessage("size")).toContain("25 MB");
    expect(uploadProblemMessage("other")).toBe(uploadProblemMessage("missing"));
    expect(uploadProblemMessage(undefined)).toBe(uploadProblemMessage("missing"));
  });
});

// DOC-01 follow-up: a document's file types (app.document_file_types in the document_files migration) equal the app's list
describe("files on accounting documents", () => {
  const documentSqlTypes = (): string[] => {
    const file = readdirSync(dir).filter((f) => f.endsWith("_document_files.sql"))[0];
    const sql = readFileSync(join(dir, file), "utf8");
    const body = sql.slice(sql.indexOf("create or replace function app.document_file_types()"));
    const array = body.slice(body.indexOf("array["), body.indexOf("]::text[]"));
    return [...array.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  it("the database's list is the app's list, PDF and images only, all of them allowed record files", () => {
    expect(documentSqlTypes()).toEqual([...DOCUMENT_FILE_TYPES]);
    for (const t of DOCUMENT_FILE_TYPES) {
      expect(t in ALLOWED_TYPES).toBe(true);
      expect(t === "application/pdf" || t.startsWith("image/")).toBe(true);
    }
    expect(isDocumentFileType("application/pdf")).toBe(true);
    expect(isDocumentFileType("application/zip")).toBe(false);
    expect(isDocumentFileType("image/svg+xml")).toBe(false);
  });
});
