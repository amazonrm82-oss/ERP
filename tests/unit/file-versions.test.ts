import { describe, expect, it } from "vitest";

import { versionGroups } from "@/features/files/versions";

const f = (id: string, previousId: string | null = null) => ({ id, previousId, createdAt: id });

// REC-07: files grouped into their histories
describe("file versions (REC-07)", () => {
  it("shows each history once, at its current version, with the earlier ones newest first", () => {
    const groups = versionGroups([f("v3", "v2"), f("other"), f("v2", "v1"), f("v1")]);
    expect(groups.map((g) => [g.current.id, g.earlier.map((e) => e.id)])).toEqual([
      ["v3", ["v2", "v1"]],
      ["other", []],
    ]);
  });

  it("an earlier version the reader does not get ends the line, and a loop cannot hang", () => {
    expect(versionGroups([f("b", "a")]).map((g) => [g.current.id, g.earlier.length])).toEqual([["b", 0]]);
    const loop = versionGroups([f("x", "y"), f("y", "x"), f("z")]);
    expect(loop.map((g) => g.current.id)).toEqual(["z"]);
  });
});
