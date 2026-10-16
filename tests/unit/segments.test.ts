import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { FilterTree } from "@/features/list-filters/model";
import { addedNotice, canWriteSegments, readSegmentFilter, SEGMENT_MEMBERS_MAX, segmentFilter, segmentListHref } from "@/features/segments/model";

const TREE: FilterTree = { match: "all", groups: [{ match: "any", conditions: [{ field: "status", op: "is", value: "s1" }] }] };

describe("segments (SEG-01)", () => {
  it("lets owners, admins and managers of a writable business write", () => {
    expect(canWriteSegments("owner", true)).toBe(true);
    expect(canWriteSegments("admin", true)).toBe(true);
    expect(canWriteSegments("manager", true)).toBe(true);
    expect(canWriteSegments("member", true)).toBe(false);
    expect(canWriteSegments("viewer", true)).toBe(false);
    expect(canWriteSegments("owner", false)).toBe(false);
  });

  it("reads a stored filter only when it is a list filter", () => {
    expect(segmentFilter(TREE)).toEqual(TREE);
    expect(segmentFilter({ match: "all", groups: [] })).toBeNull();
    expect(segmentFilter([1, 2])).toBeNull();
    expect(segmentFilter(null)).toBeNull();
    expect(readSegmentFilter(JSON.stringify(TREE))).toEqual(TREE);
    expect(readSegmentFilter("not json")).toBeNull();
    expect(readSegmentFilter(null)).toBeNull();
    expect(readSegmentFilter("x".repeat(4001))).toBeNull();
  });

  it("opens a dynamic segment as the list with its filter", () => {
    const href = segmentListHref("/o/1/leads", TREE);
    expect(href.startsWith("/o/1/leads?f=")).toBe(true);
    expect(JSON.parse(new URLSearchParams(href.split("?")[1]).get("f")!)).toEqual(TREE);
  });

  it("says what was added and what was skipped", () => {
    expect(addedNotice(3, 0, "חמים")).toBe('3 רשומות נוספו לסגמנט "חמים".');
    expect(addedNotice(1, 1, "חמים")).toBe('רשומה אחת נוספה לסגמנט "חמים". רשומה אחת דולגה: כבר בסגמנט, או שאין הרשאה.');
    expect(addedNotice(0, 2, "חמים")).toBe('לא נוספו רשומות לסגמנט "חמים". 2 דולגו: כבר בסגמנט, או שאין הרשאה.');
  });

  it("keeps the member cap equal to the database's", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_segments.sql"))!;
    const sql = readFileSync(join(dir, file), "utf8");
    expect(sql).toContain(`>= ${SEGMENT_MEMBERS_MAX}`);
  });
});
