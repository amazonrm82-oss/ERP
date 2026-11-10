import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lockedSegments, withoutLockMarks } from "@/features/document-templates/locked";
import { documentBodyProblem } from "@/features/document-templates/schema";

// SGN-02, owner (224) ב: the locked sections of a document template. The same fixture runs against
// app.document_locked_segments in tests/db/324-signature-documents.test.ts.
const CASES = JSON.parse(readFileSync(join(__dirname, "fixtures/document-locked-sections.json"), "utf8")) as {
  body: string;
  problem: string | null;
  segments?: { locked: boolean; text: string }[];
}[];

describe("locked sections of a document template (224)", () => {
  it("splits every fixture case as the database does", () => {
    for (const c of CASES) {
      const split = lockedSegments(c.body);
      expect(split.problem, c.body).toBe(c.problem);
      if (c.problem === null) expect(split.segments, c.body).toEqual(c.segments);
    }
  });

  it("the markers are never part of the document; a malformed template is refused with a message", () => {
    expect(withoutLockMarks("א\n::: נעול\nב\n:::\nג")).toBe("א\nב\nג");
    expect(documentBodyProblem("::: נעול\nבלי סוף", "contact")).toMatch(/נסגר/);
    expect(documentBodyProblem("א\n::: נעול\nב\n:::", "contact")).toBeNull();
  });

  it("the migration mirrors the markers", () => {
    const migration = readFileSync(join(__dirname, "../../supabase/migrations/20261006021212_signature_documents.sql"), "utf8");
    expect(migration).toContain("v_mark ~ '^:::[ \\t]*נעול$'");
    expect(migration).toContain("v_mark = ':::'");
    expect(migration).toContain("if v_sections > 20 then");
  });
});
