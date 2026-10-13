import { describe, expect, it } from "vitest";

import {
  copyCloseDate,
  copyCustomFields,
  copyName,
  copyStage,
  DEAL_NAME_MAX,
  duplicateDealSchema,
  firstOpenStage,
  followUpDealSchema,
  followUpName,
  skippedNotice,
  skippedParam,
} from "@/features/deals/copy";
import type { FieldDefinition } from "@/features/custom-fields/types";

const stages = [
  { id: "s1", kind: "open" as const },
  { id: "s2", kind: "open" as const },
  { id: "won", kind: "won" as const },
  { id: "lost", kind: "lost" as const },
];

describe("duplicating a deal and a follow-up deal (DEAL-11)", () => {
  it("names the copy and the follow-up, within the column's limit", () => {
    expect(copyName("אתר חדש")).toBe("עותק של אתר חדש");
    expect(followUpName(" אתר חדש ")).toBe("המשך: אתר חדש");
    const long = "א".repeat(DEAL_NAME_MAX);
    expect(copyName(long)).toHaveLength(DEAL_NAME_MAX);
    expect(followUpName(long)).toHaveLength(DEAL_NAME_MAX);
    expect(duplicateDealSchema.safeParse({ name: copyName(long), keep_stage: null }).success).toBe(true);
  });

  it("never cuts an emoji in half", () => {
    const name = copyName("😀".repeat(100));
    expect(name.length).toBeLessThanOrEqual(DEAL_NAME_MAX);
    expect(name.endsWith("😀")).toBe(true);
  });

  it("starts in the first open stage unless the user keeps an open stage", () => {
    expect(firstOpenStage(stages)?.id).toBe("s1");
    expect(copyStage(stages, "s2", false)?.id).toBe("s1");
    expect(copyStage(stages, "s2", true)?.id).toBe("s2");
    // a closed deal's stage is never kept: the copy is open
    expect(copyStage(stages, "won", true)?.id).toBe("s1");
    expect(copyStage(stages, "lost", true)?.id).toBe("s1");
    expect(copyStage([{ id: "w", kind: "won" as const }], "w", true)).toBeNull();
  });

  it("leaves out a close date that has passed", () => {
    expect(copyCloseDate("2026-10-12", "2026-10-13")).toBeNull();
    expect(copyCloseDate("2026-10-13", "2026-10-13")).toBe("2026-10-13");
    expect(copyCloseDate(null, "2026-10-13")).toBeNull();
  });

  it("copies custom fields that are active and still accepted by the form's rule, and names the others", () => {
    const field = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
      id: key,
      key,
      label: `שדה ${key}`,
      type,
      options: [],
      isRequired: true,
      isActive: true,
      helpText: null,
      ...extra,
    });
    const definitions = [
      field("size", "select", { options: ["S", "M"] }),
      field("tags", "multi_select", { options: ["a", "b"] }),
      field("note", "text"),
      field("gone", "select", { options: ["x"] }),
      field("price", "currency"),
      field("rate", "rating"),
      field("mail", "email"),
      field("rep", "user", { choices: [{ value: "u1", label: "דנה" }] }),
      field("done", "checkbox"),
    ];
    const values = {
      size: "M",
      tags: ["a", "z"],
      note: "שלום",
      old: "field deleted",
      gone: "y",
      empty: null,
      price: 123456,
      rate: 7,
      mail: "a@b.co",
      rep: "former-member",
      done: false,
    };
    const result = copyCustomFields(values, definitions);
    expect(result.values).toEqual({ size: "M", note: "שלום", price: 123456, mail: "a@b.co", done: false });
    expect(result.skipped).toEqual(["tags", "gone", "rate", "rep"]);
    expect(copyCustomFields(null, definitions)).toEqual({ values: {}, skipped: [] });
    expect(copyCustomFields(["x"], definitions)).toEqual({ values: {}, skipped: [] });
  });

  it("tells the new deal's page which fields were left out", () => {
    const definitions = [
      { key: "size", label: "מידה" },
      { key: "rate", label: "דירוג" },
    ];
    expect(skippedParam([])).toBeNull();
    expect(skippedParam(["size", "rate"])).toBe("size,rate");
    expect(skippedParam("all")).toBe("all");
    expect(skippedNotice("size", definitions)).toBe('העסקה שוכפלה בלי השדה "מידה", כי הערך שלו כבר לא תקין.');
    expect(skippedNotice("size,rate", definitions)).toContain('"מידה", "דירוג"');
    expect(skippedNotice("all", definitions)).toBe("העסקה שוכפלה בלי השדות הנוספים, כי חלק מהערכים כבר לא תקינים.");
    // junk and fields that no longer exist say nothing
    for (const junk of [undefined, "", ["size"], "<script>", "unknown", "Size"]) {
      expect(skippedNotice(junk, definitions)).toBeNull();
    }
  });

  it("reads the windows' checkboxes", () => {
    expect(duplicateDealSchema.parse({ name: "x", keep_stage: "on" }).keep_stage).toBe(true);
    expect(duplicateDealSchema.parse({ name: "x", keep_stage: null }).keep_stage).toBe(false);
    const id = "4b0b1f4e-3f2a-4c1e-9d1a-0a1b2c3d4e5f";
    expect(followUpDealSchema.parse({ name: "x", pipeline_id: id, link: "on" })).toEqual({ name: "x", pipeline_id: id, link: true });
    expect(followUpDealSchema.safeParse({ name: "", pipeline_id: id, link: null }).success).toBe(false);
    expect(followUpDealSchema.safeParse({ name: "x", pipeline_id: "", link: null }).success).toBe(false);
  });
});
