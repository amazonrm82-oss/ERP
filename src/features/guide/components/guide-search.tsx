import Form from "next/form";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import type { GuideResult } from "@/features/help/guide-search";
import { GUIDE_QUERY_MAX } from "@/features/help/guide-search";
import { paths } from "@/lib/paths";

import { draftLabel } from "../tour";

export const GUIDE_EMPTY_TEXT = "לא נמצאו מדריכים מתאימים";

/** "נמצא מדריך אחד" / "נמצאו 3 מדריכים": read out politely when the results change. */
export function guideCountText(count: number): string {
  if (count === 0) return GUIDE_EMPTY_TEXT;
  if (count === 1) return "נמצא מדריך אחד";
  return `נמצאו ${count} מדריכים`;
}

/**
 * TRU-04: the search box of the help center inside the business and its results. The search runs on the server
 * (search-server.ts, `?q=`), so the page gets only titles, snippets and links; every text is rendered as text.
 */
export function GuideSearch({ orgId, query, results }: { orgId: string; query: string; results: GuideResult[] | null }) {
  return (
    <div>
      <Form action={paths.orgHelp(orgId)} role="search" aria-label="חיפוש במדריכים" className="flex flex-wrap items-end gap-2">
        <TextField
          key={query}
          label="חיפוש במדריכים"
          hideLabel
          name="q"
          type="search"
          maxLength={GUIDE_QUERY_MAX}
          defaultValue={query}
          placeholder="במה אפשר לעזור? למשל: ייבוא מאקסל"
          className="min-w-0 flex-[1_1_14rem]"
        />
        <Button type="submit" variant="secondary">
          חיפוש
        </Button>
      </Form>

      <div className="mt-3" role="status" aria-live="polite">
        {results === null ? null : (
          <>
            <p className={results.length === 0 ? "text-ink-soft" : "sr-only"}>{guideCountText(results.length)}</p>
            {results.length > 0 ? (
              <ul className="divide-y divide-line rounded-lg border border-line" aria-label="תוצאות החיפוש במדריכים">
                {results.map((r) => (
                  <li key={r.key}>
                    <Link href={paths.orgHelpArticle(orgId, r.slug)} className="block px-4 py-3 hover:bg-canvas">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-accent-strong">{r.title}</span>
                        {r.kind === "screen" ? <span className="text-sm text-ink-soft">עזרה למסך</span> : null}
                        {draftLabel(r.draft) ? <Badge tone="warning">{draftLabel(r.draft)}</Badge> : null}
                      </span>
                      {r.snippet.length > 0 ? (
                        <span className="mt-1 block text-sm text-ink-soft">
                          {r.snippet.map((part, i) =>
                            part.hit ? (
                              <mark key={i} className="rounded-sm bg-accent-soft px-0.5 font-semibold text-accent-strong">
                                {part.text}
                              </mark>
                            ) : (
                              <span key={i}>{part.text}</span>
                            ),
                          )}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
