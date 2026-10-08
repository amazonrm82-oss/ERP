import { describe, expect, it } from "vitest";

import { IMPORT_TARGETS, suggestMapping } from "@/features/imports/fields";
import { normalizeDate, restorePhone } from "@/features/imports/server";

describe("import helpers", () => {
  it("puts back the leading 0 that Excel drops from a phone", () => {
    expect(restorePhone("521234567")).toBe("0521234567");
    expect(restorePhone("31234567")).toBe("031234567");
    expect(restorePhone("0521234567")).toBe("0521234567");
    expect(restorePhone("+972521234567")).toBe("+972521234567");
    expect(restorePhone("12345")).toBe("12345");
  });

  it("reads Israeli day-first dates", () => {
    expect(normalizeDate("31/12/1980")).toBe("1980-12-31");
    expect(normalizeDate("1.2.1990")).toBe("1990-02-01");
    expect(normalizeDate("1980-12-31")).toBe("1980-12-31");
    expect(normalizeDate(" 5-6-2001 ")).toBe("2001-06-05");
    // anything else is left for the validation to refuse
    expect(normalizeDate("yesterday")).toBe("yesterday");
  });
});

describe("column mapping", () => {
  it("matches Hebrew and English headers, each target once", () => {
    expect(suggestMapping(["שם מלא", "נייד", "E-mail", "שם החברה", "עמודה אחרת"], IMPORT_TARGETS.lead)).toEqual([
      "full_name",
      "phone",
      "email",
      "company_name",
      "",
    ]);
    // a second phone column is not mapped again
    expect(suggestMapping(["טלפון", "טלפון נוסף"], IMPORT_TARGETS.contact)).toEqual(["phone", ""]);
  });

  it("matches a header that contains a known name", () => {
    expect(suggestMapping(["מספר טלפון של הלקוח"], IMPORT_TARGETS.lead)).toEqual(["phone"]);
    expect(suggestMapping(["", "  "], IMPORT_TARGETS.lead)).toEqual(["", ""]);
  });
});
