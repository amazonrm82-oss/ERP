import { CUSTOM_PREFIX, columnChoicesSchema, type CatalogColumn } from "@/features/list-columns/columns";

// Which fields a card of the deals board shows (DEAL-09). Each user picks them;
// the choice is kept in list_preferences under the list key "deal_board" (same
// shape as a list's columns, width unused). Shared by the server and the panel.

export const BOARD_PREFERENCE = "deal_board" as const;

// The deal's name is always shown and is not in the catalog. The stage menu is a control, not a field.
export const BOARD_FIELDS: CatalogColumn[] = [
  { key: "amount", label: "סכום" },
  // DEAL-01/02: the "stuck" badge (time in stage), no next step, and the last activity
  { key: "stuck", label: "תקועה" },
  { key: "contact", label: "איש קשר" },
  { key: "company", label: "חברה" },
  { key: "owner", label: "אחראי" },
  { key: "expected_close", label: "צפי סגירה" },
  { key: "days_in_stage", label: "ימים בשלב" },
  { key: "next_task", label: "המשימה הבאה" },
  { key: "tags", label: "תגיות" },
  // DEAL-03: shown only on a deal that has them (a lost one)
  { key: "competitor", label: "מתחרה" },
  { key: "loss_reason", label: "סיבת הפסד" },
];

// What a card showed before the choice existed
export const BOARD_DEFAULT_FIELDS = ["amount", "stuck", "contact"];

// keeps the card short on a phone
export const MAX_BOARD_FIELDS = 8;

/** Every field a card can show: the built-in ones, then the organization's deal custom fields. */
export function boardCatalog(fields: Array<{ key: string; label: string }>): CatalogColumn[] {
  return [...BOARD_FIELDS, ...fields.map((field) => ({ key: `${CUSTOM_PREFIX}${field.key}`, label: field.label }))];
}

/**
 * The fields to show: the saved choice, keeping only fields that still exist,
 * once each, at most MAX_BOARD_FIELDS; the defaults when nothing usable was saved.
 * An empty saved choice is kept (only the name is shown).
 */
export function resolveBoardFields(saved: unknown, catalog: CatalogColumn[]): string[] {
  const parsed = columnChoicesSchema.safeParse(saved);
  if (saved === null || saved === undefined || !parsed.success) {
    return [...BOARD_DEFAULT_FIELDS];
  }
  const known = new Set(catalog.map((column) => column.key));
  const seen = new Set<string>();
  return parsed.data
    .map((choice) => choice.key)
    .filter((key) => known.has(key) && !seen.has(key) && seen.add(key))
    .slice(0, MAX_BOARD_FIELDS);
}

/** What the board must read for these fields (no lookups for fields nobody shows). */
export function boardNeeds(keys: string[]): { company: boolean; nextTask: boolean; custom: boolean } {
  return {
    company: keys.includes("company"),
    nextTask: keys.includes("next_task"),
    custom: keys.some((key) => key.startsWith(CUSTOM_PREFIX)),
  };
}

/** Whole 24-hour days since a time (0 for less than a day, or for a time in the future). */
export function daysSince(iso: string, now: Date): number {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/** "נכנסה לשלב היום" / "יום אחד בשלב" / "5 ימים בשלב" */
export function daysInStageLabel(days: number, format: (n: number) => string): string {
  if (days <= 0) return "נכנסה לשלב היום";
  if (days === 1) return "יום אחד בשלב";
  return `${format(days)} ימים בשלב`;
}
