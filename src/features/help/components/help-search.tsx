"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { SearchIcon } from "@/components/ui/icons";

import { queryWords, searchHelp, type HelpSearchEntry } from "../search";

/**
 * Search box over the help articles (public /help and the center inside the app). Every word typed must appear in the
 * article; Hebrew is folded like every other search (searchHelp). `articleBase` is the address the articles live under.
 */
export function HelpSearch({ entries, articleBase }: { entries: HelpSearchEntry[]; articleBase: string }) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const words = queryWords(query);
  const results = useMemo(() => searchHelp(entries, query), [entries, query]);

  return (
    <div>
      <label htmlFor={inputId} className="sr-only">
        חיפוש במרכז העזרה
      </label>
      <div className="relative">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2 text-ink-soft" />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="במה אפשר לעזור? למשל: ייבוא מאקסל"
          className="min-h-12 w-full rounded-lg border border-line-control bg-surface ps-10 pe-3 text-base text-ink placeholder:text-ink-soft"
        />
      </div>
      {words.length ? (
        <div className="mt-3" aria-live="polite">
          {results.length === 0 ? (
            <p className="text-ink-soft">לא נמצאו מאמרים. נסו מילה אחרת.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {results.map((r) => (
                <li key={r.slug}>
                  <Link href={`${articleBase}/${r.slug}`} className="block px-4 py-3 hover:bg-canvas">
                    <span className="block font-medium text-accent-strong">{r.title}</span>
                    <span className="block text-sm text-ink-soft">{r.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
