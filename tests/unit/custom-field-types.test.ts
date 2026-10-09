import { describe, expect, it } from "vitest";

import type { FieldDefinition } from "@/features/custom-fields/types";
import { displayCustomFields, inputValue, israeliIdNumber, parseCustomFields } from "@/features/custom-fields/values";

const field = (type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: type,
  key: type,
  label: type,
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
  ...extra,
});

function parse(def: FieldDefinition, ...values: string[]) {
  const form = new FormData();
  for (const v of values) form.append(`cf_${def.key}`, v);
  return parseCustomFields([def], form);
}

describe("the custom field types that had no screen (FLD-01)", () => {
  it("sum: typed in shekels, stored in agorot, shown as money", () => {
    const def = field("currency");
    expect(parse(def, "1,250.50").values.currency).toBe(125050);
    expect(parse(def, "abc").errors.cf_currency).toBeTruthy();
    expect(inputValue(def, { currency: 125050 })).toBe("1250.5");
    expect(displayCustomFields([def], { currency: 125050 })[0].text).toContain("1,250.50");
  });

  it("percent and rating", () => {
    expect(parse(field("percent"), "12.5%").values.percent).toBe(12.5);
    expect(parse(field("rating"), "4").values.rating).toBe(4);
    expect(parse(field("rating"), "6").errors.cf_rating).toBeTruthy();
    expect(displayCustomFields([field("rating")], { rating: 4 })[0].text).toBe("4 מתוך 5");
  });

  it("multiple choice: from several inputs or one text with commas, in the options' order", () => {
    const def = field("multi_select", { options: ["אדום", "ירוק", "כחול"] });
    expect(parse(def, "כחול", "אדום").values.multi_select).toEqual(["אדום", "כחול"]);
    expect(parse(def, "ירוק, כחול").values.multi_select).toEqual(["ירוק", "כחול"]);
    expect(parse(def, "סגול").errors.cf_multi_select).toBeTruthy();
    expect(parse(def).values.multi_select).toBeNull();
    expect(parse({ ...def, isRequired: true }).errors.cf_multi_select).toBeTruthy();
    expect(displayCustomFields([def], { multi_select: ["אדום", "כחול"] })[0].text).toBe("אדום, כחול");
  });

  it("date and time: stored as an instant in Israel's time zone, and back", () => {
    const def = field("datetime");
    const stored = parse(def, "2026-07-01T14:30").values.datetime as string;
    expect(new Date(stored).toISOString()).toBe("2026-07-01T11:30:00.000Z");
    expect(inputValue(def, { datetime: stored })).toBe("2026-07-01T14:30");
    expect(parse(def, "2026-02-30T10:00").errors.cf_datetime).toBeTruthy();
  });

  it("a member of the business, by id", () => {
    const def = field("user", { choices: [{ value: "11111111-1111-4111-8111-111111111111", label: "דנה" }] });
    expect(parse(def, "11111111-1111-4111-8111-111111111111").values.user).toBe("11111111-1111-4111-8111-111111111111");
    expect(parse(def, "22222222-2222-4222-8222-222222222222").errors.cf_user).toBeTruthy();
    expect(displayCustomFields([def], { user: "11111111-1111-4111-8111-111111111111" })[0].text).toBe("דנה");
  });

  it("Israeli ID and company numbers have a check digit", () => {
    expect(israeliIdNumber("000000018")).toBe("000000018");
    expect(israeliIdNumber("18")).toBeNull(); // too short to be a number someone types
    expect(israeliIdNumber("123456782")).toBe("123456782");
    expect(israeliIdNumber("123456789")).toBeNull();
    expect(israeliIdNumber("51-428562-6")).toBe("514285626");
    expect(parse(field("il_id"), "123456789").errors.cf_il_id).toBeTruthy();
    expect(parse(field("il_company_id"), "514285626").values.il_company_id).toBe("514285626");
  });
});
