import { describe, expect, it } from "vitest";

import { FIELD_OBJECTS } from "@/features/custom-fields/types";
import { MERGE_TYPES } from "@/features/merge/fields";
import { isRecordType, RECORD_TYPES, recordPage } from "@/lib/record-types";

describe("the record type registry (FXC-06)", () => {
  it("knows each type, and nothing that only looks like one", () => {
    for (const type of ["lead", "contact", "company", "deal", "task"]) expect(isRecordType(type)).toBe(true);
    for (const bad of ["note", "__proto__", "toString", "constructor", "", null, 3]) expect(isRecordType(bad)).toBe(false);
  });

  it("pages and lists", () => {
    expect(RECORD_TYPES.lead.list("o1")).toBe("/o/o1/leads");
    expect(recordPage("deal", "o1", "d1")).toBe("/o/o1/deals/d1");
    // tasks have no page of their own
    expect(recordPage("task", "o1", "t1")).toBe("/o/o1/tasks");
  });

  it("the feature lists agree with the registry", () => {
    for (const type of FIELD_OBJECTS) expect(RECORD_TYPES[type].customFields).toBe(true);
    for (const type of MERGE_TYPES) expect(RECORD_TYPES[type].mergeable).toBe(true);
    expect(RECORD_TYPES.task.tags).toBe(false);
  });
});
