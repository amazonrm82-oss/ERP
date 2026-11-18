import { describe, expect, it } from "vitest";

import { DbReadError, errorCode, must } from "@/lib/db-read";

describe("must() (FXC-05)", () => {
  it("returns the data of a read that worked, null included", () => {
    expect(must({ data: [{ id: 1 }], error: null }, "rows")).toEqual([{ id: 1 }]);
    expect(must({ data: null, error: null }, "one row")).toBeNull();
  });

  it("throws on a failed read instead of looking like 'nothing found'", () => {
    expect(() => must({ data: null, error: { message: "timeout", code: "57014" } }, "leads")).toThrow(DbReadError);
    expect(() => must({ data: null, error: { message: "timeout" } }, "leads")).toThrow(/leads/);
  });

  it("names the read and the code only, never the database's own text (owner (436) א)", () => {
    const error = new DbReadError("leads", { message: "Key (email)=(dana@example.com) already exists", code: "23505", hint: "quote:frozen" });
    expect(error.message).toBe("database read failed: leads: 23505");
    expect(error.code).toBe("23505");
    expect(error.hint).toBe("quote:frozen");
    expect(new DbReadError("leads", { message: "x" }).message).toBe("database read failed: leads: no code");
  });

  it("errorCode answers the code, or 'no code' for none or the empty code of a network failure", () => {
    expect(errorCode({ code: "42501" })).toBe("42501");
    expect(errorCode({ code: "" })).toBe("no code");
    expect(errorCode({ code: null })).toBe("no code");
    expect(errorCode(null)).toBe("no code");
    expect(new DbReadError("leads", { message: "fetch failed", code: "" }).message).toBe("database read failed: leads: no code");
  });
});
