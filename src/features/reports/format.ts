import { formatMoney, formatNumber } from "@/lib/format";

import type { ColumnKind } from "./definitions";

/** A report cell as shown on screen. */
export function formatCell(kind: ColumnKind, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  switch (kind) {
    case "money":
      return formatMoney(value);
    case "percent":
      return `${formatNumber(value)}%`;
    case "days":
      return `${formatNumber(value)} ימים`;
    case "minutes":
      if (value < 60) return `${formatNumber(Math.round(value))} דק'`;
      if (value < 60 * 48) return `${formatNumber(Math.round((value / 60) * 10) / 10)} שעות`;
      return `${formatNumber(Math.round((value / 1440) * 10) / 10)} ימים`;
    default:
      return formatNumber(value);
  }
}

/** A report cell in a CSV file: plain numbers (shekels, not agorot) so Excel can sum them. */
export function csvCell(kind: ColumnKind, value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return String(kind === "money" ? value / 100 : value);
  }
  // quote, and defuse spreadsheet formulas typed into names (=, +, -, @)
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}
