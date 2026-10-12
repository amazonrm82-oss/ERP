import { describe, expect, it } from "vitest";

import { parseNote, safeHref, sanitizeNote } from "@/features/activities/markdown";
import { callLogSchema, NOTE_RAW_MAX, noteEditSchema, noteSchema } from "@/features/activities/schema";

// The quadratic versions took 3.7 to 12 seconds on these inputs; the linear ones take a few
// milliseconds. A generous budget keeps the test meaningful without failing on a loaded CI runner.
const TIME_BUDGET_MS = 1000;

// RVW-3: a hostile note must not hold the server. Too long is refused before any cleaning,
// and the cleaning itself is linear.

const TOO_LONG = "ההערה ארוכה מדי (עד 5,000 תווים).";

// the regex sanitizeNote used before RVW-3, kept here as the reference for its output
function oldSanitize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩﻿]/g, "")
    .split("\n")
    .map((line) =>
      line.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, (whole, words: string, address: string, offset: number) => {
        if (offset > 0 && line[offset - 1] === "\\") return whole;
        return safeHref(address) ? whole : words;
      }),
    )
    .join("\n");
}

const HOSTILE: Array<[string, string]> = [
  ["100,000 [", "[".repeat(100_000)],
  ["[a]( repeated", "[a](".repeat(25_000)],
  ["** repeated", "**".repeat(50_000)],
  ["[a] repeated", "[a]".repeat(33_000)],
  ["[[...]( then no )", "[".repeat(50_000) + "](" + "x".repeat(50_000)],
  ["[x](javascript: repeated", "[x](javascript:".repeat(10_000)],
  ["\\[ repeated", "\\[".repeat(50_000)],
];

describe("RVW-3: hostile notes", () => {
  for (const [name, text] of HOSTILE) {
    it(`sanitizes ${name} quickly`, () => {
      const started = performance.now();
      sanitizeNote(text);
      expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
    });
  }

  it("shows a hostile note of the stored size quickly", () => {
    for (const [, text] of HOSTILE) {
      const started = performance.now();
      parseNote(text.slice(0, 5000));
      expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
    }
  });

  it("refuses a too-long note with the length message, before cleaning", () => {
    const body = "[".repeat(100_000);
    for (const schema of [noteSchema, noteEditSchema, callLogSchema]) {
      const started = performance.now();
      const result = schema.safeParse({ type: "note", outcome: "answered", body, private_field: null, private: null });
      expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([TOO_LONG]);
    }
    // just over the raw limit, even when trimming would leave little: still refused, never stored unsanitized
    const padded = " ".repeat(NOTE_RAW_MAX) + "[x](javascript:alert(1))";
    expect(noteSchema.safeParse({ type: "note", body: padded }).error?.issues[0]?.message).toBe(TOO_LONG);
  });

  it("keeps the limit at 5,000 characters after cleaning", () => {
    expect(noteSchema.safeParse({ type: "note", body: "א".repeat(5000) }).success).toBe(true);
    expect(noteSchema.safeParse({ type: "note", body: "א".repeat(5001) }).error?.issues[0]?.message).toBe(TOO_LONG);
    // a textarea sends line breaks as \r\n: 5,000 characters as typed still fit
    const typed = "א\n".repeat(2500);
    expect(noteSchema.safeParse({ type: "note", body: typed.replace(/\n/g, "\r\n") }).success).toBe(true);
  });

  it("gives the same result as the old regex", () => {
    const samples = [
      "ראו [כאן](javascript:alert(1)) ו-[שם](https://ok.example)",
      "[a [b](javascript:x) c",
      "\\[x](javascript:1) [y](javascript:2)",
      "[](javascript:1)[x](https://a.example)[y](ftp://b)",
      "[a]b[c](d)",
      "[a](b\n[c](javascript:d)\r\n[e](mailto:x@y.example)",
      "[[[x]](y)",
      "](a)[b](",
      "[a](tel:+972501234567) [b](www.example.com) [c]( https://x.example )",
    ];
    // and random strings over the characters that matter
    const alphabet = ["[", "]", "(", ")", "\\", "a", " ", "\n", "https://x.example", "javascript:"];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      let text = "";
      const length = rand(30);
      for (let j = 0; j < length; j++) text += alphabet[rand(alphabet.length)];
      samples.push(text);
    }
    for (const sample of samples) {
      expect(sanitizeNote(sample)).toBe(oldSanitize(sample));
    }
  });
});
