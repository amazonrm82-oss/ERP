"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { SearchIcon } from "@/components/ui/icons";
import { paths } from "@/lib/paths";

type Entry = { slug: string; title: string; summary: string; text: string };

// Hebrew search: ignore niqqud, geresh and final-letter forms, so "לידים" finds "ליד".
function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[֑-ׇ]/g, "")
    .replace(/[׳״"'`]/g, "")
    .replace(/ך/g, "כ")
    .replace(/ם/g, "מ")
    .replace(/ן/g, "נ")
    .replace(/ף/g, "פ")
    .replace(/ץ/g, "צ");
}

/** Search box over the help articles. Every word typed must appear in the article. */
export function HelpSearch({ entries }: { entries: Entry[] }) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const index = useMemo(() => entries.map((e) => ({ ...e, haystack: normalize(e.text) })), [entries]);
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const results = words.length ? index.filter((e) => words.every((w) => e.haystack.includes(w))) : [];

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
                  <Link href={paths.helpArticle(r.slug)} className="block px-4 py-3 hover:bg-canvas">
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
