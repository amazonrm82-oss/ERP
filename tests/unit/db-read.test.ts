import { describe, expect, it } from "vitest";

import { DbReadError, must } from "@/lib/db-read";

describe("must() (FXC-05)", () => {
  it("returns the data of a read that worked, null included", () => {
    expect(must({ data: [{ id: 1 }], error: null }, "rows")).toEqual([{ id: 1 }]);
    expect(must({ data: null, error: null }, "one row")).toBeNull();
  });

  it("throws on a failed read instead of looking like 'nothing found'", () => {
    expect(() => must({ data: null, error: { message: "timeout", code: "57014" } }, "leads")).toThrow(DbReadError);
    expect(() => must({ data: null, error: { message: "timeout" } }, "leads")).toThrow(/leads/);
  });
});
