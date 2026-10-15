import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BUFFER_MAX as TYPE_BUFFER_MAX } from "@/features/meeting-types/schema";
import { BUFFER_MAX, meetingSchema } from "@/features/meetings/schema";

// CAL-10: the meeting form's buffers ("" = the type's, filled by the database), 0..240 like the database checks.
const base = { title: "פגישה", meeting_type: "in_person", date: "2027-01-04", start_time: "10:00", end_time: "11:00" };

describe("meeting buffers in the form (CAL-10)", () => {
  it("empty is the type's (null), a whole number of minutes is kept, the range is 0..240", () => {
    const parse = (before: string, after: string) => meetingSchema.safeParse({ ...base, buffer_before_minutes: before, buffer_after_minutes: after });
    const empty = parse("", " ");
    expect(empty.success && [empty.data.buffer_before_minutes, empty.data.buffer_after_minutes]).toEqual([null, null]);
    const set = parse("0", "240");
    expect(set.success && [set.data.buffer_before_minutes, set.data.buffer_after_minutes]).toEqual([0, 240]);
    expect(parse("241", "0").success).toBe(false);
    expect(parse("-5", "0").success).toBe(false);
    expect(parse("7.5", "0").success).toBe(false);
    // a form without the fields: the type's
    const missing = meetingSchema.safeParse(base);
    expect(missing.success && [missing.data.buffer_before_minutes, missing.data.buffer_after_minutes]).toEqual([null, null]);
  });

  it("the largest buffer is the same on a type, on a meeting and in the database", () => {
    expect(TYPE_BUFFER_MAX).toBe(BUFFER_MAX);
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_meeting_buffers.sql"));
    const sql = readFileSync(path.join(dir, file as string), "utf8");
    expect(sql).toContain(`check (buffer_before_minutes between 0 and ${BUFFER_MAX})`);
    expect(sql).toContain(`check (buffer_after_minutes between 0 and ${BUFFER_MAX})`);
  });
});
