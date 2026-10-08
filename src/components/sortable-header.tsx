import Link from "next/link";

import { cn } from "@/lib/cn";

type Props = {
  label: string;
  // "ascending" / "descending" when the list is sorted by this column
  direction: "ascending" | "descending" | null;
  href: string;
  className?: string;
};

/** A column header that sorts the list by its column (a link, so the sort lives in the URL). */
export function SortableHeader({ label, direction, href, className }: Props) {
  return (
    <th scope="col" aria-sort={direction ?? undefined} className={className}>
      <Link href={href} scroll={false} className={cn("inline-flex items-center gap-1 underline-offset-4 hover:text-ink hover:underline", direction && "text-ink")}>
        {label}
        <span aria-hidden="true" className="text-xs">
          {direction === "ascending" ? "▲" : direction === "descending" ? "▼" : "↕"}
        </span>
        <span className="sr-only">{direction === "ascending" ? ", ממוין בסדר עולה" : direction === "descending" ? ", ממוין בסדר יורד" : ", מיון לפי העמודה"}</span>
      </Link>
    </th>
  );
}
