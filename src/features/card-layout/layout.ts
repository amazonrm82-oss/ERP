import { z } from "zod";

import type { FieldDefinition } from "@/features/custom-fields/types";

// FLD-08: the groups of fields on a record's details card. Stored in public.card_layouts
// (one row per organization and record type; no row = the default layout below).
// CARD_LAYOUT_BUILT_IN mirrors app.card_layout_builtin_keys() (tests/db/99-card-layouts.test.ts
// keeps them equal); the limits mirror the trigger app.card_layouts_check (hint card_layout:invalid).

export const CARD_LAYOUT_TYPES = ["lead", "contact", "company", "deal"] as const;
export type CardLayoutType = (typeof CARD_LAYOUT_TYPES)[number];

export function isCardLayoutType(value: unknown): value is CardLayoutType {
  return typeof value === "string" && (CARD_LAYOUT_TYPES as readonly string[]).includes(value);
}

export const CARD_LAYOUT_MAX_GROUPS = 20;
export const CARD_LAYOUT_MAX_FIELDS = 60;
export const CARD_LAYOUT_TITLE_MAX = 60;
export const CUSTOM_PREFIX = "cf:";

// the title of the final group that holds every field placed in no group
export const MORE_FIELDS_TITLE = "שדות נוספים";
// the title of the one group of the default layout
export const DEFAULT_GROUP_TITLE = "פרטים";
// the title the editor gives a group it adds
export const NEW_GROUP_TITLE = "קבוצה חדשה";

// Titles the app writes itself; a group so titled has no name from the business.
export const APP_GROUP_TITLES: readonly string[] = [DEFAULT_GROUP_TITLE, MORE_FIELDS_TITLE, NEW_GROUP_TITLE];

/** True when the business gave the group its own name (not one of the app's default titles). */
export function isNamedTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed !== "" && !APP_GROUP_TITLES.includes(trimmed);
}

/**
 * Whether each rendered group shows its heading (owner, 14 October 2026): with several groups every
 * heading shows; a single group shows its heading only when the business named it.
 */
export function groupHeadings(groups: Pick<CardLayoutGroup, "title">[]): boolean[] {
  if (groups.length === 1) return [isNamedTitle(groups[0].title)];
  return groups.map(() => true);
}

// The details card's own fields, in the order the card showed them before FLD-08.
export const CARD_LAYOUT_BUILT_IN: Record<CardLayoutType, Array<{ key: string; label: string }>> = {
  lead: [
    { key: "full_name", label: "שם מלא" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "company_name", label: "חברה" },
    { key: "source_id", label: "מקור" },
    { key: "requested_product_id", label: "מוצר מבוקש" },
    { key: "preferred_channel", label: "ערוץ מועדף" },
    { key: "owner_id", label: "אחראי" },
    { key: "budget", label: "תקציב" },
    { key: "last_contacted_at", label: "מגע אחרון" },
    { key: "created_at", label: "נוצר" },
    { key: "disqualify_reason", label: "סיבת פסילה" },
  ],
  contact: [
    { key: "full_name", label: "שם מלא" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "job_title", label: "תפקיד" },
    { key: "company_id", label: "חברה" },
    { key: "type", label: "סוג" },
    { key: "birth_date", label: "יום הולדת" },
    { key: "preferred_locale", label: "שפה מועדפת" },
    { key: "preferred_channel", label: "ערוץ מועדף" },
    { key: "source_id", label: "מקור" },
    { key: "owner_id", label: "אחראי" },
    { key: "created_at", label: "נוצר" },
  ],
  company: [
    { key: "type", label: "סוג" },
    { key: "parent_company_id", label: "שייכת ל" },
    { key: "country", label: "מדינת הרישום" },
    { key: "tax_id", label: "ח.פ. / מספר רישום" },
    { key: "industry", label: "ענף" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "website", label: "אתר" },
    { key: "city", label: "עיר" },
    { key: "address_line", label: "כתובת" },
    { key: "owner_id", label: "אחראי" },
    { key: "created_at", label: "נוצר" },
  ],
  deal: [
    { key: "amount", label: "שווי" },
    { key: "contact_id", label: "איש קשר" },
    { key: "company_id", label: "חברה" },
    { key: "expected_close_date", label: "סגירה צפויה" },
    { key: "recurring_kind", label: "סוג עסקה" },
    { key: "recurring_amount", label: "סכום חוזר" },
    { key: "recurring_start", label: "תאריך התחלה" },
    { key: "renewal_date", label: "תאריך חידוש" },
    { key: "closed_at", label: "נסגרה" },
    { key: "lost_reason", label: "סיבת הפסד" },
    { key: "competitor", label: "מתחרה" },
    { key: "owner_id", label: "אחראי" },
    { key: "created_at", label: "נוצרה" },
  ],
};

export type CardLayoutGroup = { title: string; columns: 1 | 2; fields: string[] };

const codePoints = (value: string) => [...value].length;

// White space at either end of a title: exactly what String.prototype.trim() removes. The trigger
// app.card_layouts_check refuses the same set, written out character by character.
export const TITLE_EDGE_SPACE = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;

const groupSchema = z
  .object({
    title: z.string().refine((t) => !TITLE_EDGE_SPACE.test(t) && codePoints(t) >= 1 && codePoints(t) <= CARD_LAYOUT_TITLE_MAX),
    columns: z.union([z.literal(1), z.literal(2)]),
    fields: z.array(z.string()),
  })
  .strict();

/** The shape the database accepts, without the custom-field lookup (the trigger does that). */
export function layoutSchema(type: CardLayoutType) {
  const builtIn = new Set(CARD_LAYOUT_BUILT_IN[type].map((f) => f.key));
  return z
    .array(groupSchema)
    .max(CARD_LAYOUT_MAX_GROUPS)
    .refine((groups) => {
      const keys = groups.flatMap((g) => g.fields);
      return (
        keys.length <= CARD_LAYOUT_MAX_FIELDS &&
        new Set(keys).size === keys.length &&
        keys.every((k) => builtIn.has(k) || /^cf:[a-z][a-z0-9_]{0,39}$/.test(k))
      );
    });
}

/** A stored value read back from the database; anything of the wrong shape counts as no layout. */
export function parseLayout(type: CardLayoutType, value: unknown): CardLayoutGroup[] | null {
  const parsed = layoutSchema(type).safeParse(value);
  return parsed.success ? (parsed.data as CardLayoutGroup[]) : null;
}

/**
 * The default layout: one group with the built-in fields in the card's own order, then the
 * active custom fields in their order. Shown when a business has no row; "back to default"
 * writes it (custom fields beyond the limit stay in the final group).
 */
export function defaultLayout(type: CardLayoutType, definitions: Pick<FieldDefinition, "key">[]): CardLayoutGroup[] {
  const fields = [...CARD_LAYOUT_BUILT_IN[type].map((f) => f.key), ...definitions.map((d) => `${CUSTOM_PREFIX}${d.key}`)];
  return [{ title: DEFAULT_GROUP_TITLE, columns: 1, fields: fields.slice(0, CARD_LAYOUT_MAX_FIELDS) }];
}

export type CatalogField = { key: string; label: string; custom: boolean };

/** Every field the card can show: the built-in ones, then the active custom fields. */
export function layoutCatalog(type: CardLayoutType, definitions: Pick<FieldDefinition, "key" | "label">[]): CatalogField[] {
  return [
    ...CARD_LAYOUT_BUILT_IN[type].map((f) => ({ ...f, custom: false })),
    ...definitions.map((d) => ({ key: `${CUSTOM_PREFIX}${d.key}`, label: d.label, custom: true })),
  ];
}

/**
 * What a card shows when the business has no saved layout: today's card, one group (its default title is
 * not shown) with every field it knows, in order, and no cap. The 60-field cap is for saved layouts only.
 */
export function unsavedLayout(known: readonly string[]): CardLayoutGroup[] {
  return [{ title: DEFAULT_GROUP_TITLE, columns: 1, fields: [...known] }];
}

/**
 * The groups to render: the layout's groups with keys the catalog no longer knows left out
 * (a hidden or deleted custom field), then a final group "שדות נוספים" with every field the
 * layout does not place, so a layout never hides a field. Empty groups are dropped.
 */
export function resolveLayout(layout: CardLayoutGroup[], known: readonly string[]): CardLayoutGroup[] {
  const knownSet = new Set(known);
  const placed = new Set<string>();
  const groups: CardLayoutGroup[] = [];
  for (const group of layout) {
    const fields = group.fields.filter((key) => knownSet.has(key) && !placed.has(key));
    fields.forEach((key) => placed.add(key));
    if (fields.length > 0) groups.push({ ...group, fields });
  }
  const rest = known.filter((key) => !placed.has(key));
  if (rest.length > 0) groups.push({ title: MORE_FIELDS_TITLE, columns: 1, fields: rest });
  return groups;
}

/** Splits a group's visible items into its columns (the first column takes the extra one). */
export function splitColumns<T>(items: T[], columns: 1 | 2): T[][] {
  if (columns === 1 || items.length < 2) return [items];
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/** What the editor saves: titles trimmed, unknown keys and repeats dropped, limits kept. */
export function cleanLayout(groups: CardLayoutGroup[], known: readonly string[]): CardLayoutGroup[] {
  const knownSet = new Set(known);
  const seen = new Set<string>();
  return groups.map((group) => ({
    title: group.title.trim(),
    columns: group.columns === 2 ? 2 : 1,
    fields: group.fields.filter((key) => {
      if (!knownSet.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  }));
}

/** Hebrew message for an editor state the database would refuse, else null. */
export function layoutProblem(groups: CardLayoutGroup[]): string | null {
  if (groups.length > CARD_LAYOUT_MAX_GROUPS) return `אפשר עד ${CARD_LAYOUT_MAX_GROUPS} קבוצות.`;
  if (groups.some((g) => g.title.trim() === "")) return "לכל קבוצה צריך כותרת.";
  if (groups.some((g) => codePoints(g.title.trim()) > CARD_LAYOUT_TITLE_MAX)) return `כותרת של קבוצה יכולה להיות עד ${CARD_LAYOUT_TITLE_MAX} תווים.`;
  if (groups.reduce((n, g) => n + g.fields.length, 0) > CARD_LAYOUT_MAX_FIELDS) return `אפשר לשים בקבוצות עד ${CARD_LAYOUT_MAX_FIELDS} שדות. שדה שלא בקבוצה מופיע ב"${MORE_FIELDS_TITLE}".`;
  return null;
}
