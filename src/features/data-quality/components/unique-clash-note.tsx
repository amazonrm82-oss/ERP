import Link from "next/link";

import { uniqueClashText, type UniqueClash } from "../duplicates";

/**
 * FLD-07: "ערך כפול בשדה …" with a link to the record that holds the value, when the user may open
 * it; otherwise the mark alone.
 */
export function UniqueClashNote({ clash, className }: { clash: UniqueClash; className?: string }) {
  return (
    <span className={className}>
      <span className="font-medium text-warning">{uniqueClashText(clash.label)}</span>
      {clash.other ? (
        <>
          {": "}
          <Link href={clash.other.href} className="text-accent-strong underline underline-offset-4">
            <bdi>{clash.other.name}</bdi>
          </Link>
        </>
      ) : (
        <span className="text-ink-soft"> (ברשומה שאין לכם גישה אליה)</span>
      )}
    </span>
  );
}
