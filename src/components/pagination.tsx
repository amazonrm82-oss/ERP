import { ButtonLink } from "@/components/ui/button";
import { ChevronIcon } from "@/components/ui/icons";

type Props = {
  page: number;
  hasMore: boolean;
  // builds the URL of a page, keeping the current filters
  hrefFor: (page: number) => string;
};

/** Previous / next links for a paged list. Renders nothing for a single page. */
export function Pagination({ page, hasMore, hrefFor }: Props) {
  if (page <= 1 && !hasMore) {
    return null;
  }
  return (
    <nav aria-label="דפדוף" className="mt-4 flex items-center justify-between gap-3">
      {page > 1 ? (
        <ButtonLink href={hrefFor(page - 1)} variant="secondary" size="sm">
          <ChevronIcon className="size-4 rtl:rotate-180" />
          הקודם
        </ButtonLink>
      ) : (
        <span />
      )}
      <p className="text-sm text-ink-soft">עמוד {page}</p>
      {hasMore ? (
        <ButtonLink href={hrefFor(page + 1)} variant="secondary" size="sm">
          הבא
          <ChevronIcon className="size-4 ltr:rotate-180" />
        </ButtonLink>
      ) : (
        <span />
      )}
    </nav>
  );
}
