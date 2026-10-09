import Link from "next/link";

import { ChevronIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type Props = {
  page: number;
  pageCount: number;
  // the link of a page number, with the list's other params kept
  hrefFor: (page: number) => string;
  className?: string;
};

const step = "inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-md";

/** Previous / next with "page x of y". Links, so the back button and a shared link keep the page. */
export function Pagination({ page, pageCount, hrefFor, className }: Props) {
  if (pageCount <= 1) {
    return null;
  }
  const prev = page > 1 ? hrefFor(page - 1) : null;
  const next = page < pageCount ? hrefFor(page + 1) : null;
  return (
    <nav aria-label="דפדוף" className={cn("flex items-center justify-between gap-3", className)}>
      {prev ? (
        <Link href={prev} rel="prev" className={cn(step, "text-ink hover:bg-canvas")}>
          <ChevronIcon className="size-4 rotate-180" />
          הקודם
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(step, "text-ink-soft opacity-60")}>
          <ChevronIcon className="size-4 rotate-180" />
          הקודם
        </span>
      )}
      <span className="text-sm text-ink-soft tabular-nums" aria-current="page">
        עמוד {page} מתוך {pageCount}
      </span>
      {next ? (
        <Link href={next} rel="next" className={cn(step, "text-ink hover:bg-canvas")}>
          הבא
          <ChevronIcon className="size-4" />
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(step, "text-ink-soft opacity-60")}>
          הבא
          <ChevronIcon className="size-4" />
        </span>
      )}
    </nav>
  );
}
