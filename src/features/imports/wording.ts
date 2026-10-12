// Hebrew counts in the import summary, singular and plural.
import { formatNumber } from "@/lib/format";

/** The title of the list of rows imported with a warning. */
export function warnedRowsTitle(count: number): string {
  return count === 1 ? "שורה אחת יובאה עם הערה:" : `${formatNumber(count)} שורות יובאו עם הערה:`;
}

/** The line under a cut list: how many rows are not shown. */
export function moreRowsText(count: number): string {
  return count === 1 ? "ועוד שורה אחת." : `ועוד ${formatNumber(count)} שורות.`;
}
