// QUO-06: the Unicode bidirectional algorithm (UAX #9) for the PDF module, for one paragraph without explicit
// embeddings (the documents never carry them; LRE/RLE/PDF/LRO/RLO and the isolate marks are dropped, X9).
// A PDF has no layout engine of its own: every line is written in visual order, left to right, so Hebrew runs
// are reversed here while numbers, phones, emails and Latin words keep their own left-to-right order.
//
// Covered: P2/P3 (paragraph direction from the first strong character, or as given), W1-W7, N1-N2, I1-I2,
// L1 (trailing white space takes the paragraph level), L2 (reversal per line) and L4 (mirrored brackets). Combining
// marks stay after their base letter (L3), so niqqud keeps its place when a Hebrew word is reversed.

export type BidiType = "L" | "R" | "AL" | "EN" | "ES" | "ET" | "AN" | "CS" | "NSM" | "BN" | "B" | "S" | "WS" | "ON";

export type Direction = "rtl" | "ltr";

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const DIGIT = /\p{Nd}/u;
const SPACE = /\p{Zs}/u;

function hebrewPoint(cp: number): boolean {
  return (
    (cp >= 0x0591 && cp <= 0x05bd) || cp === 0x05bf || cp === 0x05c1 || cp === 0x05c2 || cp === 0x05c4 || cp === 0x05c5 || cp === 0x05c7 || cp === 0xfb1e
  );
}

/** The bidi class of one code point (the parts of UnicodeData.txt a business document meets). */
export function bidiType(cp: number): BidiType {
  if (cp >= 0x30 && cp <= 0x39) return "EN";
  if (cp === 0x09 || cp === 0x1f || cp === 0x0b) return "S";
  if (cp === 0x0a || cp === 0x0d || cp === 0x1c || cp === 0x1d || cp === 0x1e || cp === 0x85 || cp === 0x2029) return "B";
  if (cp === 0x200e) return "L";
  if (cp === 0x200f) return "R";
  if (cp === 0x061c) return "AL";
  // explicit embeddings, overrides and isolates; zero-width joiners and the like
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff || cp === 0xad) {
    return "BN";
  }
  if (cp < 0x20 || cp === 0x7f) return "BN";
  if (cp === 0x2b || cp === 0x2d || cp === 0x2212 || cp === 0x207a || cp === 0x207b || cp === 0xfe62 || cp === 0xfe63 || cp === 0xff0b || cp === 0xff0d) return "ES";
  if (
    cp === 0x23 || cp === 0x24 || cp === 0x25 || cp === 0xa2 || cp === 0xa3 || cp === 0xa4 || cp === 0xa5 || cp === 0xb0 || cp === 0xb1 ||
    cp === 0x2030 || cp === 0x2031 || cp === 0x2032 || cp === 0x2033 || cp === 0x2034 || cp === 0x2213 || cp === 0x066a ||
    (cp >= 0x20a0 && cp <= 0x20cf)
  ) {
    return "ET";
  }
  if (cp === 0x2c || cp === 0x2e || cp === 0x2f || cp === 0x3a || cp === 0xa0 || cp === 0x060c || cp === 0x202f || cp === 0x2044 || cp === 0xfe50 || cp === 0xfe52 || cp === 0xfe55) {
    return "CS";
  }
  if (cp === 0x20 || cp === 0x0c || cp === 0x2028 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x205f || cp === 0x3000) return "WS";
  // Hebrew
  if (hebrewPoint(cp)) return "NSM";
  if ((cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0x07c0 && cp <= 0x085f) || (cp >= 0xfb1d && cp <= 0xfb4f) || (cp >= 0x10800 && cp <= 0x10fff)) return "R";
  // Arabic, Syriac, Thaana and their presentation forms
  if (cp >= 0x0660 && cp <= 0x0669) return "AN";
  if (cp >= 0x06f0 && cp <= 0x06f9) return "EN";
  if ((cp >= 0x0600 && cp <= 0x07bf) || (cp >= 0x0860 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) {
    const ch = String.fromCodePoint(cp);
    return MARK.test(ch) ? "NSM" : "AL";
  }
  const ch = String.fromCodePoint(cp);
  if (MARK.test(ch)) return "NSM";
  if (LETTER.test(ch) || DIGIT.test(ch)) return "L";
  if (SPACE.test(ch)) return "WS";
  return "ON";
}

/** The direction of a text by its first strong character (P2/P3), or null when it has none. */
export function firstStrong(text: string): Direction | null {
  for (const ch of text) {
    const type = bidiType(ch.codePointAt(0)!);
    if (type === "L") return "ltr";
    if (type === "R" || type === "AL") return "rtl";
  }
  return null;
}

const MIRROR: Record<string, string> = {
  "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<",
  "«": "»", "»": "«", "‹": "›", "›": "‹", "≤": "≥", "≥": "≤", "⁅": "⁆", "⁆": "⁅",
};

const strongOf = (type: BidiType): "L" | "R" | null => (type === "L" ? "L" : type === "R" || type === "AL" || type === "EN" || type === "AN" ? "R" : null);

export type BidiParagraph = {
  // code points of the paragraph, explicit formatting characters removed
  chars: string[];
  types: BidiType[];
  // the original classes (NSM marks a combining mark, kept after its base on reversal)
  original: BidiType[];
  levels: number[];
  level: 0 | 1;
};

/**
 * Resolves the embedding level of every character of one paragraph (no line breaks inside).
 * `direction` "auto" takes the first strong character and falls back to `fallback`.
 */
export function resolveParagraph(text: string, direction: Direction | "auto" = "auto", fallback: Direction = "rtl"): BidiParagraph {
  const chars: string[] = [];
  const original: BidiType[] = [];
  for (const ch of text) {
    const type = bidiType(ch.codePointAt(0)!);
    if (type === "BN") continue; // X9
    chars.push(ch);
    original.push(type === "B" ? "WS" : type);
  }
  const dir = direction === "auto" ? (firstStrong(chars.join("")) ?? fallback) : direction;
  const level: 0 | 1 = dir === "rtl" ? 1 : 0;
  const sos: "L" | "R" = level === 1 ? "R" : "L";
  const types = [...original];
  const n = types.length;

  // W1: a combining mark takes the class of the character before it
  for (let i = 0; i < n; i++) {
    if (types[i] === "NSM") types[i] = i === 0 ? sos : types[i - 1];
  }
  // W2: European digits after Arabic letters are Arabic numbers; W3: AL -> R
  let lastStrong: BidiType = sos;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === "L" || t === "R" || t === "AL") lastStrong = t;
    else if (t === "EN" && lastStrong === "AL") types[i] = "AN";
  }
  for (let i = 0; i < n; i++) if (types[i] === "AL") types[i] = "R";
  // W4: one separator between two numbers of the same kind joins them
  for (let i = 1; i < n - 1; i++) {
    if (types[i] === "ES" && types[i - 1] === "EN" && types[i + 1] === "EN") types[i] = "EN";
    else if (types[i] === "CS" && types[i - 1] === "EN" && types[i + 1] === "EN") types[i] = "EN";
    else if (types[i] === "CS" && types[i - 1] === "AN" && types[i + 1] === "AN") types[i] = "AN";
  }
  // W5: currency and percent signs next to European numbers are part of them
  for (let i = 0; i < n; i++) {
    if (types[i] !== "ET") continue;
    let end = i;
    while (end < n && types[end] === "ET") end++;
    const touches = (i > 0 && types[i - 1] === "EN") || (end < n && types[end] === "EN");
    for (let j = i; j < end; j++) types[j] = touches ? "EN" : "ET";
    i = end - 1;
  }
  // W6: remaining separators and terminators are neutral
  for (let i = 0; i < n; i++) if (types[i] === "ES" || types[i] === "ET" || types[i] === "CS") types[i] = "ON";
  // W7: European numbers after a Latin letter (or at the start of a left-to-right paragraph) are left-to-right
  lastStrong = sos;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === "L" || t === "R") lastStrong = t;
    else if (t === "EN" && lastStrong === "L") types[i] = "L";
  }
  // N1/N2: neutrals between two of the same direction take it, else the paragraph's
  for (let i = 0; i < n; i++) {
    if (strongOf(types[i]) !== null) continue;
    let end = i;
    while (end < n && strongOf(types[end]) === null) end++;
    const before = i === 0 ? sos : strongOf(types[i - 1])!;
    const after = end === n ? sos : strongOf(types[end])!;
    const resolved: BidiType = before === after ? before : level === 1 ? "R" : "L";
    for (let j = i; j < end; j++) types[j] = resolved;
    i = end - 1;
  }
  // I1/I2
  const levels = types.map((t) => {
    if (level === 0) return t === "R" ? 1 : t === "AN" || t === "EN" ? 2 : 0;
    return t === "L" || t === "EN" || t === "AN" ? 2 : 1;
  });
  return { chars, types, original, levels, level };
}

/**
 * One line of a resolved paragraph, from `start` to `end` (code point indexes), in visual order: the string to
 * write left to right. Trailing white space takes the paragraph level (L1); bracket pairs inside right-to-left
 * runs are mirrored (L4); LRM/RLM, which have no shape, are left out.
 */
export function visualLine(paragraph: BidiParagraph, start = 0, end = paragraph.chars.length): string {
  const chars = paragraph.chars.slice(start, end);
  const original = paragraph.original.slice(start, end);
  const levels = paragraph.levels.slice(start, end);
  // L1: white space at the end of the line goes back to the paragraph level
  for (let i = chars.length - 1; i >= 0 && (original[i] === "WS" || original[i] === "S"); i--) levels[i] = paragraph.level;
  // clusters: a base character and the combining marks after it travel together (L3)
  type Cluster = { text: string; level: number };
  const clusters: Cluster[] = [];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (levels[i] % 2 === 1 && MIRROR[ch]) ch = MIRROR[ch];
    if (ch === "‎" || ch === "‏" || ch === "؜") continue;
    if (original[i] === "NSM" && clusters.length > 0 && clusters[clusters.length - 1].level === levels[i]) {
      clusters[clusters.length - 1].text += ch;
    } else {
      clusters.push({ text: ch, level: levels[i] });
    }
  }
  if (clusters.length === 0) return "";
  // L2: from the highest level down to the lowest odd level, reverse every run at that level or above
  const highest = Math.max(...clusters.map((c) => c.level));
  const lowestOdd = Math.min(...clusters.map((c) => (c.level % 2 === 1 ? c.level : c.level + 1)));
  for (let lvl = highest; lvl >= lowestOdd; lvl--) {
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].level < lvl) continue;
      let j = i;
      while (j < clusters.length && clusters[j].level >= lvl) j++;
      const run = clusters.slice(i, j).reverse();
      clusters.splice(i, j - i, ...run);
      i = j - 1;
    }
  }
  return clusters.map((c) => c.text).join("");
}

/** A one-line text in visual order (no wrapping): `direction` as for resolveParagraph. */
export function toVisual(text: string, direction: Direction | "auto" = "auto", fallback: Direction = "rtl"): string {
  return visualLine(resolveParagraph(text, direction, fallback));
}
