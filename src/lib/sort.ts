// List sorting from the URL: `sort=name` is ascending, `sort=-name` descending.

export type Sort<K extends string> = { key: K; ascending: boolean };

/** The sort a list was asked for, if it is one of the list's sortable columns; otherwise the list's default. */
export function parseSort<K extends string>(value: string, keys: readonly K[], fallback: Sort<K>): Sort<K> {
  const ascending = !value.startsWith("-");
  const key = (ascending ? value : value.slice(1)) as K;
  return keys.includes(key) ? { key, ascending } : fallback;
}

/** The URL value for a sort. */
export function sortValue<K extends string>(sort: Sort<K>): string {
  return sort.ascending ? sort.key : `-${sort.key}`;
}

/** Clicking a column header: the same column flips its direction, another column starts with its natural one. */
export function nextSort<K extends string>(current: Sort<K>, key: K, startAscending: boolean): Sort<K> {
  return current.key === key ? { key, ascending: !current.ascending } : { key, ascending: startAscending };
}

// A custom field column (LST-03): "cf:<field key>", sorted by the field's value.
export type CustomSortKey = `cf:${string}`;

const CUSTOM_KEY = /^cf:([a-z][a-z0-9_]{0,39})$/;

/**
 * The database column for a sort key: a list's own column, or a custom field
 * (`custom_fields->key`: JSON order, so numbers sort as numbers and text as text).
 */
export function sortColumn<K extends string>(columns: Record<K, string>, key: K | CustomSortKey): string {
  const custom = CUSTOM_KEY.exec(key);
  return custom ? `custom_fields->${custom[1]}` : columns[key as K];
}
