import { describe, expect, it } from "vitest";

import { companyNamePattern, sameCompanyName } from "@/features/data-quality/company-name";
import { emailWarning, phoneWarning, suggestDomain, typoDistance } from "@/features/data-quality/typing";

// DQL-02: warnings while typing (never a block).
describe("phone warning", () => {
  it("accepts valid Israeli numbers in the usual spellings", () => {
    for (const ok of ["050-1234567", "0501234567", "+972 50 123 4567", "972501234567", "02-1234567", "03 1234567", "077-1234567", "1-800-123-456", "1700123456", "*2700", "+1 212 555 0100", "0044 20 7946 0958", ""]) {
      expect(phoneWarning(ok), ok).toBeNull();
    }
  });

  it("warns about a mobile number with a digit too few or too many", () => {
    expect(phoneWarning("050-123456")?.message).toContain("10 ספרות");
    expect(phoneWarning("050-12345678")?.message).toContain("10 ספרות");
  });

  it("warns about a landline that is too short, and about a foreign number of the wrong length", () => {
    expect(phoneWarning("03-123456")).not.toBeNull();
    expect(phoneWarning("+44 12")).not.toBeNull();
    expect(phoneWarning("12")).not.toBeNull();
  });

  it("offers the leading 0 when it is missing", () => {
    expect(phoneWarning("501234567")).toEqual({ message: "חסר 0 בתחילת המספר?", suggestion: "0501234567" });
  });
});

describe("email warning", () => {
  it("suggests the provider for common domain typos", () => {
    expect(emailWarning("dana@gmial.com")).toEqual({ message: "התכוונתם ל-gmail.com?", suggestion: "dana@gmail.com" });
    for (const [typo, fixed] of [
      ["a@gmai.com", "a@gmail.com"],
      ["a@gmail.con", "a@gmail.com"],
      ["a@gmail.co.il", "a@gmail.com"],
      ["a@hotmial.com", "a@hotmail.com"],
      ["a@walla.co", "a@walla.co.il"],
      ["a@wala.co.il", "a@walla.co.il"],
      ["a@yahoo.cm", "a@yahoo.com"],
      ["a@outlok.com", "a@outlook.com"],
      ["a@icloud.co", "a@icloud.com"],
    ]) {
      expect(emailWarning(typo)?.suggestion, typo).toBe(fixed);
    }
  });

  it("leaves real domains and business domains alone", () => {
    for (const ok of ["a@gmail.com", "a@walla.co.il", "a@walla.com", "a@mail.com", "a@live.com", "a@me.com", "a@hotmail.co.uk", "a@bezeqint.net", "a@acme.co.il", "a@my-shop.com", "A@GMAIL.COM", ""]) {
      expect(emailWarning(ok), ok).toBeNull();
    }
  });

  it("says when the address is not whole yet", () => {
    expect(emailWarning("dana")).not.toBeNull();
    expect(emailWarning("dana@gmail")).not.toBeNull();
    expect(emailWarning("a@b@c.com")).not.toBeNull();
  });

  it("counts a swap of two letters as one typo", () => {
    expect(typoDistance("gmial.com", "gmail.com")).toBe(1);
    expect(suggestDomain("gmaill.com")).toBe("gmail.com");
  });
});

describe("company name match", () => {
  it("escapes like wildcards and turns PostgREST's * into one character", () => {
    expect(companyNamePattern("  A*B  ")).toBe("A_B");
    expect(companyNamePattern("100% שיווק_בע\"מ")).toBe("100\\% שיווק\\_בע\"מ");
    expect(companyNamePattern("a\\b")).toBe("a\\\\b");
    expect(companyNamePattern("***")).not.toContain("*");
  });

  it("compares the exact name, ignoring case and outer spaces", () => {
    expect(sameCompanyName(" Acme ", "acme")).toBe(true);
    // a name "A*B" must not match "AxB" or "A long B"
    expect(sameCompanyName("AxB", "A*B")).toBe(false);
    expect(sameCompanyName("A long B", "A*B")).toBe(false);
  });
});
