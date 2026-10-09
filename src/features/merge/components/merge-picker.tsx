"use client";

import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";

import { searchAction, type SearchHit } from "@/features/search/actions";
import { paths } from "@/lib/paths";
import { RECORD_TYPES } from "@/lib/record-types";

import { type MergeType } from "../fields";


/** Find the other record to merge with, by name, phone or email. */
export function MergePicker({ orgId, type, keepId }: { orgId: string; type: MergeType; keepId: string }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  // the query the hits answer, so "not found" is said only about a finished search (FXU-12)
  const [answered, setAnswered] = useState("");
  const [pending, startTransition] = useTransition();
  const inputId = useId();

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      startTransition(async () => {
        const found = await searchAction(orgId, q);
        setHits(found.filter((h) => h.group === RECORD_TYPES[type].table && !h.key.endsWith(keepId)));
        setAnswered(q);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, orgId, type, keepId]);

  const q = query.trim();
  const shown = q.length >= 2 ? hits : [];
  const notFound = q.length >= 2 && !pending && answered === q && hits.length === 0;
  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium">
        חיפוש הרשומה הכפולה
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="שם, טלפון או אימייל"
        className="block min-h-11 w-full rounded-md border border-line-control bg-surface px-3"
      />
      <p aria-live="polite" className="mt-2 text-sm text-ink-soft">
        {notFound ? "לא נמצאה רשומה מתאימה. נסו שם, טלפון או אימייל אחר." : ""}
      </p>
      <ul className="divide-y divide-line">
        {shown.map((hit) => {
          const id = hit.key.split(":")[1];
          return (
            <li key={hit.key}>
              <Link href={paths.merge(orgId, type, keepId, id)} className="block px-1 py-2.5 hover:bg-canvas">
                <span className="block font-medium text-accent-strong">
                  <bdi>{hit.title}</bdi>
                </span>
                {hit.subtitle ? (
                  <span className="block text-sm text-ink-soft">
                    <bdi>{hit.subtitle}</bdi>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
