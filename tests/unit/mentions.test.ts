import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NoteText } from "@/features/activities/components/note-text";
import { notePlainText, parseNote, sanitizeNote } from "@/features/activities/markdown";
import { noteEditSchema, noteSchema, PRIVATE_NO_MENTIONS, TOO_MANY_MENTIONS } from "@/features/activities/schema";
import { mentionAt, mentionIds, mentionName, mentionToken } from "@/features/mentions/token";

const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// REC-02: a mention is "@[Name](user:<id>)" inside the plain text of a note.
describe("mention tokens (REC-02)", () => {
  it("writes and reads a token", () => {
    const token = mentionToken(A, "דנה כהן");
    expect(token).toBe(`@[דנה כהן](user:${A})`);
    expect(mentionAt(`היי ${token}!`, 4)).toEqual({ userId: A, name: "דנה כהן", length: token.length });
    expect(mentionAt(`היי ${token}`, 3)).toBeNull();
  });

  it("a name loses brackets and line breaks, is cut to 100 characters, and is never empty", () => {
    expect(mentionName("  דנה [המנהלת]\nכהן ")).toBe("דנה המנהלת כהן");
    expect(mentionName("א".repeat(150))).toHaveLength(100);
    expect(mentionName("[]")).toBe("משתמש");
    // counted in code points, like Postgres: an emoji is one character, never cut in half
    expect(Array.from(mentionName("😀".repeat(150)))).toHaveLength(100);
  });

  it("a name of up to 100 code points is a mention, 101 is not (also with emoji)", () => {
    for (const ch of ["א", "😀"]) {
      expect(mentionIds(`@[${ch.repeat(100)}](user:${A})`)).toEqual([A]);
      expect(mentionIds(`@[${ch.repeat(101)}](user:${A})`)).toEqual([]);
      expect(sanitizeNote(`@[${ch.repeat(100)}](user:${A})`)).toBe(`@[${ch.repeat(100)}](user:${A})`);
      expect(sanitizeNote(`@[${ch.repeat(101)}](user:${A})`)).toBe(`@${ch.repeat(101)}`);
    }
  });

  it("finds each id once, in lower case, and ignores what is not a token", () => {
    const text = `${mentionToken(A, "א")} ${mentionToken(B.toUpperCase(), "ב")} ${mentionToken(A, "א")} [א](user:${A}) @[](user:${A}) @[x](user:123)`;
    expect(mentionIds(text)).toEqual([A, B]);
  });

  it("uses the same grammar as the database (app.mention_ids in the migration)", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    // found by name, so renumbering the migration at merge does not break this test
    const name = readdirSync(dir).find((f) => f.endsWith("_record_mentions.sql"));
    expect(name).toBeDefined();
    const file = readFileSync(join(dir, name ?? ""), "utf8");
    expect(file).toContain(
      "'@\\[[^]\\n]{1,100}\\]\\(user:([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\\)'",
    );
  });
});

describe("mentions in a note (REC-02)", () => {
  it("parses a mention, also inside bold, and keeps it when the note is cleaned", () => {
    const text = `שלום ${mentionToken(A, "דנה")}, **${mentionToken(B, "רון")}**`;
    expect(parseNote(text)).toEqual([
      {
        kind: "paragraph",
        lines: [
          [
            { kind: "text", text: "שלום " },
            { kind: "mention", userId: A, name: "דנה" },
            { kind: "text", text: ", " },
            { kind: "bold", children: [{ kind: "mention", userId: B, name: "רון" }] },
          ],
        ],
      },
    ]);
    expect(sanitizeNote(text)).toBe(text);
    // without the "@" it is a link to a scheme that is not allowed, and only its words stay
    expect(sanitizeNote(`[דנה](user:${A})`)).toBe("דנה");
  });

  it("shows the current name, highlighted, or the name it was written with", () => {
    const text = `היי ${mentionToken(A, "שם ישן")} ו${mentionToken(B, "רון")}`;
    const html = renderToStaticMarkup(createElement(NoteText, { text, names: { [A]: "דנה לוי" } }));
    expect(html).toContain("bg-accent-soft");
    expect(html).toContain("@דנה לוי");
    expect(html).toContain("@רון");
    expect(html).not.toContain("user:");
    expect(html).not.toContain("שם ישן");
  });

  it("plain text shows @name", () => {
    expect(notePlainText(`היי ${mentionToken(A, "דנה")}`)).toBe("היי @דנה");
  });

  it("a private note cannot mention anyone, and at most 20 people per note", () => {
    const one = mentionToken(A, "דנה");
    const privateNote = noteSchema.safeParse({ type: "note", body: one, private: "on" });
    expect(privateNote.success).toBe(false);
    expect(privateNote.error?.issues.map((i) => i.message)).toContain(PRIVATE_NO_MENTIONS);
    expect(noteSchema.safeParse({ type: "note", body: one, private: null }).success).toBe(true);

    const privateEdit = noteEditSchema.safeParse({ body: one, private_field: "1", private: "on" });
    expect(privateEdit.error?.issues.map((i) => i.message)).toContain(PRIVATE_NO_MENTIONS);
    // a call has no privacy box; a mention there is fine
    expect(noteEditSchema.safeParse({ body: one, private_field: null, private: null }).success).toBe(true);

    const ids = Array.from({ length: 21 }, (_, i) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const many = ids.map((id) => mentionToken(id, "x")).join(" ");
    expect(noteSchema.safeParse({ type: "note", body: many, private: null }).error?.issues.map((i) => i.message)).toContain(TOO_MANY_MENTIONS);
    expect(noteSchema.safeParse({ type: "note", body: ids.slice(0, 20).map((id) => mentionToken(id, "x")).join(" "), private: null }).success).toBe(true);
  });
});
