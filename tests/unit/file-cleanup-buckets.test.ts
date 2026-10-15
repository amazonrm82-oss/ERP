import { describe, expect, it } from "vitest";

import { CLEANUP_BUCKETS, groupOrphans, isCleanupBucket } from "@/features/files/orphans";

// USR-01 and FLD-04: the nightly cleanup removes objects only from the three known buckets,
// whatever bucket name the database answers with.
describe("file cleanup bucket allow-list (USR-01)", () => {
  it("knows exactly record-files, avatars and org-logos", () => {
    expect([...CLEANUP_BUCKETS].sort()).toEqual(["avatars", "org-logos", "record-files"]);
    expect(isCleanupBucket("avatars")).toBe(true);
    expect(isCleanupBucket("record-files")).toBe(true);
    expect(isCleanupBucket("org-logos")).toBe(true);
    for (const value of ["other", "Avatars", "avatars ", "org-logo", "org_logos", "", null, undefined, 1, {}]) expect(isCleanupBucket(value)).toBe(false);
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
      { bucket: "org-logos", path: "org/logo" },
    ]);
    expect([...groups.keys()].sort()).toEqual(["avatars", "org-logos", "record-files"]);
    expect(groups.get("org-logos")).toEqual(["org/logo"]);
    expect(groups.get("record-files")).toEqual(["org/1", "org/2"]);
    expect(groups.get("avatars")).toEqual(["user/a"]);
  });

  it("an answer that is not a list gives nothing to remove", () => {
    for (const data of [null, undefined, "x", 3, { bucket: "avatars", path: "a/b" }]) expect(groupOrphans(data).size).toBe(0);
  });
});

describe("the database's bucket list matches (FLD-04)", () => {
  it("the latest orphan_files_bucket_check names the same buckets", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .filter((text) => text.includes("orphan_files_bucket_check check"))
      .at(-1);
    const list = /orphan_files_bucket_check check \(bucket in \(([^)]*)\)\)/.exec(sql ?? "")?.[1] ?? "";
    expect([...list.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()).toEqual([...CLEANUP_BUCKETS].sort());
  });
});
