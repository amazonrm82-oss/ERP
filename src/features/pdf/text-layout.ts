// QUO-06: wrapping a text into lines of a given width and putting each line in visual order (bidi.ts).
// Pure: the width of a piece of text comes from `measure`, so the same code runs with the real font in the
// renderer and with a fixed-width stand-in in the unit tests.

import { resolveParagraph, visualLine, type Direction } from "./bidi";

export type Measure = (text: string) => number;

export type VisualLine = {
  // the line as written left to right on the page
  text: string;
  width: number;
  // the paragraph's direction: an rtl line is aligned to the right edge of its box, an ltr line to the left,
  // unless the caller aligns it
  direction: Direction;
};

const SPACE = /\s/u;

/**
 * Splits one paragraph (no newline) into lines no wider than `maxWidth`. Breaks after spaces; a word wider than
 * the line is cut between characters (a combining mark never leaves its letter). Levels are resolved on the whole
 * paragraph and each line is then reordered on its own (UAX #9 L1/L2), so a number that wraps keeps its digits'
 * order on both lines.
 */
export function wrapParagraph(text: string, maxWidth: number, measure: Measure, direction: Direction | "auto" = "auto"): VisualLine[] {
  const paragraph = resolveParagraph(text, direction);
  const dir: Direction = paragraph.level === 1 ? "rtl" : "ltr";
  const chars = paragraph.chars;
  if (chars.length === 0) return [];
  // break opportunities: after a run of spaces. A line's width is the sum of its words' and spaces' widths (each measured
  // once), so wrapping stays linear in the length of the text.
  const lines: Array<[number, number]> = [];
  const spaceWidth = measure(" ");
  let lineStart = 0;
  // the width of the line so far, with the spaces after its last word
  let lineWidthWithSpaces = 0;
  let i = 0;
  while (i < chars.length) {
    let wordEnd = i;
    while (wordEnd < chars.length && !SPACE.test(chars[wordEnd])) wordEnd++;
    let spacesEnd = wordEnd;
    while (spacesEnd < chars.length && SPACE.test(chars[spacesEnd])) spacesEnd++;
    const wordWidth = wordEnd > i ? measure(chars.slice(i, wordEnd).join("")) : 0;
    if (lineWidthWithSpaces + wordWidth <= maxWidth) {
      lineWidthWithSpaces += wordWidth + (spacesEnd - wordEnd) * spaceWidth;
      i = spacesEnd;
      continue;
    }
    if (i > lineStart) {
      // the word starts a new line
      lines.push([lineStart, i]);
      lineStart = i;
      lineWidthWithSpaces = 0;
      continue;
    }
    // a single word wider than the line: cut it between characters
    let cut = lineStart + 1;
    while (cut < wordEnd && measure(chars.slice(lineStart, cut + 1).join("")) <= maxWidth) cut++;
    while (cut < wordEnd && paragraph.original[cut] === "NSM") cut++;
    lines.push([lineStart, cut]);
    lineStart = cut;
    i = cut;
    lineWidthWithSpaces = 0;
  }
  if (lineStart < chars.length) lines.push([lineStart, chars.length]);
  return lines.map(([from, to]) => {
    const visual = visualLine(paragraph, from, to).replace(/^\s+|\s+$/gu, "");
    return { text: visual, width: measure(visual), direction: dir };
  });
}

/** A text with line breaks: each paragraph wrapped on its own (an empty paragraph keeps its empty line). */
export function wrapText(text: string, maxWidth: number, measure: Measure, direction: Direction | "auto" = "auto"): VisualLine[] {
  const out: VisualLine[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    const lines = wrapParagraph(paragraph, maxWidth, measure, direction);
    out.push(...(lines.length > 0 ? lines : [{ text: "", width: 0, direction: "rtl" as const }]));
  }
  // no trailing empty lines
  while (out.length > 1 && out[out.length - 1].text === "") out.pop();
  return out;
}
