"use client";

import { useEffect, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";

import { searchParentCompaniesAction, type ParentCompanyHit } from "../actions";

export type ParentChoice = { id: string; name: string } | null;

type Props = {
  orgId: string;
  // the company being edited ("" on the create form): never offered as its own parent
  companyId: string;
  initial: ParentChoice;
  error?: string;
};

/**
 * CON-07: pick the parent company, or none. The choice travels in the hidden input
 * `parent_company_id` ("" = none); the search box itself sends nothing.
 */
export function ParentCompanyPicker({ orgId, companyId, initial, error }: Props) {
  const [picked, setPicked] = useState<ParentChoice>(initial);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ParentCompanyHit[]>([]);
  // the query the hits answer, so "not found" is said only about a finished search
  const [answered, setAnswered] = useState("");
  const [pending, startTransition] = useTransition();
  const inputId = useId();
  const errorId = `${inputId}-error`;

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      startTransition(async () => {
        const found = await searchParentCompaniesAction(orgId, companyId, q);
        setHits(found);
        setAnswered(q);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, orgId, companyId]);

  const q = query.trim();
  const shown = q.length >= 2 ? hits : [];
  const notFound = q.length >= 2 && !pending && answered === q && hits.length === 0;

  return (
    <div>
      <input type="hidden" name="parent_company_id" value={picked?.id ?? ""} />
      {picked ? (
        <>
          <p className="mb-1.5 block text-sm font-medium text-ink">שייכת ל</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-3 py-2.5">
              <bdi>{picked.name}</bdi>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
              ביטול השיוך
            </Button>
          </div>
          {error ? (
            <p className="mt-1.5 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Label htmlFor={inputId}>שייכת ל</Label>
          <Input
            id={inputId}
            type="search"
            value={query}
            autoComplete="off"
            placeholder="חיפוש לפי שם, ח.פ. או עיר"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : `${inputId}-hint`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter in the search box must not send the company form
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          {error ? (
            <p id={errorId} className="mt-1.5 text-sm text-danger">
              {error}
            </p>
          ) : (
            <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-ink-soft">
              לא חובה. החברה תופיע בעמוד של החברה שנבחרה, ברשימת &quot;חברות שתחתיה&quot;.
            </p>
          )}
          <p aria-live="polite" className="text-sm text-ink-soft empty:hidden">
            {notFound ? "לא נמצאה חברה מתאימה." : ""}
          </p>
          {shown.length > 0 ? (
            <ul aria-label="חברות שנמצאו" className="mt-1 divide-y divide-line rounded-md border border-line">
              {shown.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="block min-h-11 w-full px-3 py-2 text-start hover:bg-canvas"
                    onClick={() => {
                      setPicked({ id: hit.id, name: hit.name });
                      setQuery("");
                      setHits([]);
                    }}
                  >
                    <span className="block font-medium text-accent-strong">
                      <bdi>{hit.name}</bdi>
                    </span>
                    {hit.city ? <span className="block text-sm text-ink-soft">{hit.city}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
