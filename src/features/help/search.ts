// UX-05 (ג): Hebrew search in the help center. The text is folded like every other search (searchNorm: no niqqud,
// geresh or quotes, final letters as regular ones), and every word typed must appear in the article.

import { searchNorm } from "@/lib/search-norm";

export type HelpSearchEntry = { slug: string; title: string; summary: string; text: string };

/** Folds a text for the help search: searchNorm, plus the backtick some keyboards type for a geresh. */
export function helpFold(value: string): string {
  return searchNorm(value).replace(/`/g, "");
}

/** The words of a query, folded; empty when there is nothing to look for. */
export function queryWords(query: string): string[] {
  return helpFold(query).split(/\s+/).filter(Boolean);
}

/** The entries whose text holds every word, in their own order (title matches first). */
export function searchHelp<T extends HelpSearchEntry>(entries: T[], query: string): T[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits = entries
    .map((entry) => ({ entry, title: helpFold(entry.title), text: helpFold(`${entry.title} ${entry.summary} ${entry.text}`) }))
    .filter((e) => words.every((w) => e.text.includes(w)));
  const inTitle = (e: (typeof hits)[number]) => words.some((w) => e.title.includes(w));
  return [...hits.filter(inTitle), ...hits.filter((e) => !inTitle(e))].map((e) => e.entry);
}
