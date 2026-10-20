// The pure parts of SearchPicker (search-picker.tsx), unit tested without a browser.

export type SearchPickerHit = { id: string; label: string; detail?: string | null };
export type SearchPickerChoice = { id: string; label: string } | null;

/** Characters typed before the picker searches. */
export const SEARCH_PICKER_MIN_CHARS = 2;
/** Most hits a search shows. */
export const SEARCH_PICKER_MAX_HITS = 20;
/** Quiet time after the last key before a search runs, in milliseconds. */
export const SEARCH_PICKER_DELAY_MS = 200;

/** The query the picker sends: trimmed, and nothing at all while it is shorter than the minimum. */
export function pickerQuery(typed: string, min: number = SEARCH_PICKER_MIN_CHARS): string | null {
  const query = typed.trim();
  return query.length >= min ? query : null;
}

/**
 * The option a key moves to in a list of `count` options (-1 = none). Down and up wrap around, Home and End go to the
 * ends; from none, down goes to the first and up to the last. An empty list has none.
 */
export function moveActive(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 || current >= count - 1 ? 0 : current + 1;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return Math.min(current, count - 1);
  }
}

/**
 * The hidden input that carries the picked option's label next to its id, so a form a server refused can show the same
 * choice again (formValues keeps every string the form sent; the server never reads it).
 */
export function pickerLabelName(name: string): string {
  return `${name}__label`;
}

/** The choice a form starts with: the id it holds, named by the label it holds, else by `fallback`. None without an id. */
export function initialChoice(id: string | null | undefined, label: string | null | undefined, fallback: string): SearchPickerChoice {
  if (!id) return null;
  const name = (label ?? "").trim();
  return { id, label: name === "" ? fallback : name };
}

/** What the live region says about a finished search. */
export function hitsAnnouncement(count: number, max: number = SEARCH_PICKER_MAX_HITS): string {
  if (count === 0) return "לא נמצאו תוצאות.";
  if (count === 1) return "נמצאה תוצאה אחת. בחירה בחיצים ובאנטר.";
  return count >= max ? `נמצאו ${count} תוצאות ראשונות. אפשר לדייק את החיפוש.` : `נמצאו ${count} תוצאות. בחירה בחיצים ובאנטר.`;
}
