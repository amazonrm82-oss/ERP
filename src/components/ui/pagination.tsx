import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { BackIcon, ForwardIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type Props = {
  page: number;
  // builds the URL of a page, keeping the list's other params
  hrefFor: (page: number) => string;
  className?: string;
} & (
  | { pageCount: number; hasMore?: never }
  // lists that do not count their rows know only whether one more page exists
  | { hasMore: boolean; pageCount?: never }
);

/**
 * The one previous / next (FXU-14). Links, so the back button and a shared link
 * keep the page. Renders nothing when everything fits on one page.
 */
export function Pagination({ page, hrefFor, className, ...rest }: Props) {
  const hasNext = rest.pageCount !== undefined ? page < rest.pageCount : rest.hasMore;
  if (page <= 1 && !hasNext) {
    return null;
  }
  const off = cn(buttonClasses("secondary", "sm"), "pointer-events-none");
  return (
    <nav aria-label="דפדוף" className={cn("mt-4 flex items-center justify-between gap-3", className)}>
      {page > 1 ? (
        <ButtonLink href={hrefFor(page - 1)} rel="prev" variant="secondary" size="sm">
          <BackIcon className="size-4" />
          הקודם
        </ButtonLink>
      ) : (
        <span aria-disabled="true" className={off}>
          <BackIcon className="size-4" />
          הקודם
        </span>
      )}
      <p className="text-sm text-ink-soft tabular-nums">{rest.pageCount !== undefined ? `עמוד ${page} מתוך ${rest.pageCount}` : `עמוד ${page}`}</p>
      {hasNext ? (
        <ButtonLink href={hrefFor(page + 1)} rel="next" variant="secondary" size="sm">
          הבא
          <ForwardIcon className="size-4" />
        </ButtonLink>
      ) : (
        <span aria-disabled="true" className={off}>
          הבא
          <ForwardIcon className="size-4" />
        </span>
      )}
    </nav>
  );
}
