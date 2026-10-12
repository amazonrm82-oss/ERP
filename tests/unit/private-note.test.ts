import { describe, expect, it } from "vitest";

import { noteEditSchema, noteSchema, PRIVATE_ONLY_NOTE } from "@/features/activities/schema";

// GAP-05: the note composer and the edit box say whether a note is private
describe("private note forms (GAP-05)", () => {
  it("a note is public unless the box is ticked", () => {
    expect(noteSchema.parse({ type: "note", body: "שלום", private: null }).private).toBe(false);
    expect(noteSchema.parse({ type: "note", body: "שלום", private: "on" }).private).toBe(true);
  });

  it("only a note can be private", () => {
    const result = noteSchema.safeParse({ type: "call", body: "שיחה", private: "on" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["private"], message: PRIVATE_ONLY_NOTE });
    expect(noteSchema.safeParse({ type: "call", body: "שיחה", private: null }).success).toBe(true);
  });

  it("the edit box changes privacy only when it shows the box", () => {
    expect(noteEditSchema.parse({ body: "x", private_field: null, private: null })).toMatchObject({ private_field: false });
    expect(noteEditSchema.parse({ body: "x", private_field: "1", private: null })).toMatchObject({ private_field: true, private: false });
    expect(noteEditSchema.parse({ body: "x", private_field: "1", private: "on" })).toMatchObject({ private_field: true, private: true });
  });
});
