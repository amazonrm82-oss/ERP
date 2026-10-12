import { describe, expect, it } from "vitest";

import { CLEANUP_BUCKETS, groupOrphans, isCleanupBucket } from "@/features/files/orphans";

// USR-01: the nightly cleanup removes objects only from the two known buckets,
// whatever bucket name the database answers with.
describe("file cleanup bucket allow-list (USR-01)", () => {
  it("knows exactly record-files and avatars", () => {
    expect([...CLEANUP_BUCKETS].sort()).toEqual(["avatars", "record-files"]);
    expect(isCleanupBucket("avatars")).toBe(true);
    expect(isCleanupBucket("record-files")).toBe(true);
    for (const value of ["other", "Avatars", "avatars ", "", null, undefined, 1, {}]) expect(isCleanupBucket(value)).toBe(false);
  });

  it("groups claimed objects by bucket and leaves out anything else", () => {
    const groups = groupOrphans([
      { bucket: "record-files", path: "org/1" },
      { bucket: "avatars", path: "user/a" },
      { bucket: "record-files", path: "org/2" },
      { bucket: "secrets", path: "x/y" },
      { bucket: "avatars", path: "" },
      { bucket: "avatars" },
      { path: "org/3" },
      "org/4",
      null,
      { bucket: "avatars", path: 5 },
    ]);
    expect([...groups.keys()].sort()).toEqual(["avatars", "record-files"]);
    expect(groups.get("record-files")).toEqual(["org/1", "org/2"]);
    expect(groups.get("avatars")).toEqual(["user/a"]);
  });

  it("an answer that is not a list gives nothing to remove", () => {
    for (const data of [null, undefined, "x", 3, { bucket: "avatars", path: "a/b" }]) expect(groupOrphans(data).size).toBe(0);
  });
});
