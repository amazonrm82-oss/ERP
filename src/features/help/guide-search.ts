// TRU-04: search in the guides from inside the system. Pure and unit-tested; the help center inside the business runs it
// on the server (src/features/guide/search-server.ts) over the articles and the "?" texts of the main screens, so the
// corpus never goes to the browser. Hebrew is folded like every other search (helpFold = searchNorm: no niqqud, geresh
// or quotes, final letters as regular ones). Every word typed must appear in the guide's title or text; title matches
// rank first, then the number of body matches. The snippet is plain text cut around the first match, never HTML.

import { helpFold, queryWords } from "./search";

export type GuideKind = "article" | "screen";

export type GuideDoc = {
  key: string;
  kind: GuideKind;
  /** the article the result opens (a screen's text opens its article) */
  slug: string;
  title: string;
  /** the words of the guide besides the title, plain text */
  text: string;
  draft: boolean;
};

/** A piece of the snippet; `hit` marks a typed word, shown highlighted. */
export type SnippetPart = { text: string; hit: boolean };

export type GuideResult = { key: string; kind: GuideKind; slug: string; title: string; snippet: SnippetPart[]; draft: boolean };

/** A typed query is cut to this length before it is searched. */
export const GUIDE_QUERY_MAX = 100;
/** How many results the center shows at most. */
export const GUIDE_RESULT_LIMIT = 20;

/** The query from `?q=` (a repeated parameter takes the first), trimmed and cut to GUIDE_QUERY_MAX. */
export function guideQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").trim().slice(0, GUIDE_QUERY_MAX);
}

/**
 * Folds a text and keeps, for every folded character, the index of the original character it came from, so a match in
 * the folded text can be cut out of the original one. helpFold works character by character, so folding each one alone
 * gives the same string.
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const piece = helpFold(text[i]);
    for (let j = 0; j < piece.length; j++) map.push(i);
    folded += piece;
  }
  return { folded, map };
}

function countOf(haystack: string, word: string): number {
  let count = 0;
  for (let at = haystack.indexOf(word); at >= 0; at = haystack.indexOf(word, at + word.length)) count++;
  return count;
}

/** Ranks the guides for a query: null when a word is missing; higher is better (title words weigh more than any body count). */
export function guideScore(doc: GuideDoc, words: string[]): number | null {
  const title = helpFold(doc.title);
  const text = helpFold(doc.text);
  let titleHits = 0;
  let bodyHits = 0;
  for (const word of words) {
    const inTitle = title.includes(word);
    const inBody = countOf(text, word);
    if (!inTitle && inBody === 0) return null;
    if (inTitle) titleHits++;
    bodyHits += inBody;
  }
  return titleHits * 10_000 + Math.min(bodyHits, 9_999);
}

const SNIPPET_BEFORE = 50;
const SNIPPET_LENGTH = 160;

/**
 * A short piece of `text` around the first typed word found in it, with the typed words marked. Cut at spaces where it can,
 * "…" where text was left out. With no word in the text, its beginning.
 */
export function guideSnippet(text: string, words: string[]): SnippetPart[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const { folded, map } = foldWithMap(clean);
  let first = -1;
  for (const word of words) {
    const at = folded.indexOf(word);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  const origin = first >= 0 ? map[first] : 0;
  let start = Math.max(0, origin - SNIPPET_BEFORE);
  if (start > 0) {
    const space = clean.indexOf(" ", start);
    start = space >= 0 && space < origin ? space + 1 : start;
  }
  let end = Math.min(clean.length, start + SNIPPET_LENGTH);
  if (end < clean.length) {
    const space = clean.lastIndexOf(" ", end);
    if (space > origin) end = space;
  }

  // marks: every typed word inside the window, merged when they touch
  const marks: [number, number][] = [];
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) {
      const from = map[at];
      const to = map[at + word.length - 1] + 1;
      if (to <= start || from >= end) continue;
      marks.push([Math.max(from, start), Math.min(to, end)]);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }

  const parts: SnippetPart[] = [];
  let at = start;
  for (const [from, to] of merged) {
    if (from > at) parts.push({ text: clean.slice(at, from), hit: false });
    parts.push({ text: clean.slice(from, to), hit: true });
    at = to;
  }
  if (at < end) parts.push({ text: clean.slice(at, end), hit: false });
  if (start > 0) parts.unshift({ text: "…", hit: false });
  if (end < clean.length) parts.push({ text: "…", hit: false });
  return parts;
}

/** The guides that hold every typed word, best first; a tie keeps the list's order. Empty for an empty query. */
export function searchGuides(docs: GuideDoc[], query: string, limit = GUIDE_RESULT_LIMIT): GuideResult[] {
  const words = queryWords(query.slice(0, GUIDE_QUERY_MAX));
  if (words.length === 0) return [];
  return docs
    .map((doc, index) => ({ doc, index, score: guideScore(doc, words) }))
    .filter((r): r is { doc: GuideDoc; index: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ doc }) => ({
      key: doc.key,
      kind: doc.kind,
      slug: doc.slug,
      title: doc.title,
      snippet: guideSnippet(doc.text, words),
      draft: doc.draft,
    }));
}
