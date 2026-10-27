import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canEditNoteHint, canPinHint, isPinnableType, LOGGED_TYPES, noteSchema, parseTimelineFilter } from "@/features/activities/schema";
import { CONTACT_TYPES } from "@/features/leads/waiting";
import { markSharedNote, SHARE_NOTE_TYPE, SHARED_FROM_PHONE, sharedNoteBody, withoutShareMark } from "@/features/share/share";

const migration = () => {
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  const file = readdirSync(dir).find((name: string) => name.endsWith("_share_note_type.sql"));
  return readFileSync(path.join(dir, file ?? "missing"), "utf8");
};

/** WAB-06 (owner, 27 October 2026, answer (ב)): a note from a share is its own type, a person's note that is not contact. */
describe("share note (WAB-06)", () => {
  it("is marked once on its first line, also when a retry already carries the mark", () => {
    expect(markSharedNote("שלום")).toBe(`${SHARED_FROM_PHONE}\nשלום`);
    expect(markSharedNote(`${SHARED_FROM_PHONE}\nשלום`)).toBe(`${SHARED_FROM_PHONE}\nשלום`);
    expect(markSharedNote(`  ${SHARED_FROM_PHONE}  \r\nשלום`)).toBe(`${SHARED_FROM_PHONE}\nשלום`);
    expect(markSharedNote("")).toBe(SHARED_FROM_PHONE);
    expect(markSharedNote(SHARED_FROM_PHONE)).toBe(SHARED_FROM_PHONE);
    // the mark in the middle is just text
    expect(markSharedNote(`שלום\n${SHARED_FROM_PHONE}`)).toBe(`${SHARED_FROM_PHONE}\nשלום\n${SHARED_FROM_PHONE}`);
    expect(withoutShareMark(`${SHARED_FROM_PHONE}\nא\nב`)).toBe("א\nב");
    expect(sharedNoteBody(`${SHARED_FROM_PHONE}\nx`, false)).toBe(`${SHARED_FROM_PHONE}\nx`);
  });

  it("matches the database: the type name and the mark the trigger asks for", () => {
    const sql = migration();
    expect(SHARE_NOTE_TYPE).toBe("share_note");
    expect(sql).toContain(`split_part(new.body, chr(10), 1) <> '${SHARED_FROM_PHONE}'`);
  });

  it("is not contact: the waiting-leads mirror of app.contact_types() leaves it out", () => {
    expect(CONTACT_TYPES as readonly string[]).not.toContain(SHARE_NOTE_TYPE);
    expect(migration()).not.toMatch(/create or replace function app\.contact_types/);
  });

  it("is never offered by the log form", () => {
    expect(LOGGED_TYPES.map((t) => t.value as string)).not.toContain(SHARE_NOTE_TYPE);
    expect(noteSchema.safeParse({ type: SHARE_NOTE_TYPE, body: "x" }).success).toBe(false);
  });

  it("is a person's note on the timeline: pinned, edited by its author for 24 hours, under the notes tab", () => {
    expect(isPinnableType(SHARE_NOTE_TYPE)).toBe(true);
    const now = Date.parse("2026-10-27T12:00:00Z");
    const item = { type: SHARE_NOTE_TYPE, createdBy: "u1", createdAt: "2026-10-27T10:00:00Z" };
    expect(canEditNoteHint(item, { userId: "u1", role: "member", canWrite: true }, now)).toBe(true);
    expect(canEditNoteHint(item, { userId: "u2", role: "member", canWrite: true }, now)).toBe(false);
    expect(canPinHint(item, { userId: "u2", role: "manager", canWrite: true, managesRecordTeam: true })).toBe(true);
    expect(parseTimelineFilter("note").types).toContain(SHARE_NOTE_TYPE);
    expect(parseTimelineFilter("system").excludeTypes).toContain(SHARE_NOTE_TYPE);
  });
});
