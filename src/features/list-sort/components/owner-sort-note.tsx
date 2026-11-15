import { cn } from "@/lib/cn";

import { OWNER_SORT_LIMIT_TEXT } from "../owner-sort";

/** OPS-09: shown once when a list asked to sort by owner and was too large for it, so it shows its default order. */
export function OwnerSortNote({ show, className }: { show: boolean; className?: string }) {
  if (!show) {
    return null;
  }
  return (
    <p role="status" className={cn("rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning", className)}>
      {OWNER_SORT_LIMIT_TEXT}. הרשימה מוצגת בסדר הרגיל.
    </p>
  );
}
