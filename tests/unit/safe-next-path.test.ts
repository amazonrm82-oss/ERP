import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/paths";

describe("safeNextPath (FXS-01): where to go after signing in", () => {
  it("keeps paths on this site, with their query and fragment", () => {
    expect(safeNextPath("/o/abc/leads")).toBe("/o/abc/leads");
    expect(safeNextPath("/o/abc/leads?q=משה&page=2#x")).toBe("/o/abc/leads?q=%D7%9E%D7%A9%D7%94&page=2#x");
    expect(safeNextPath("/invite/token")).toBe("/invite/token");
  });

  it("falls back to / for anything that leaves the site", () => {
    for (const next of [
      null,
      undefined,
      "",
      "https://evil.example",
      "evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example", // browsers drop the tab and land on //evil.example
      "/\n/evil.example",
      "/\r/evil.example",
      "/.//evil.example", // normalises to //evil.example
      "/\u0000/x",
      "javascript:alert(1)",
      " /o/abc",
    ]) {
      expect(safeNextPath(next)).toBe("/");
    }
  });

  it("an encoded slash stays encoded, so it is still a path on this site", () => {
    expect(safeNextPath("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });
});
