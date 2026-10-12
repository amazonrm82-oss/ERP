// REC-11: the pure parts of the "unsaved changes" warning, kept apart from the DOM so they can be unit tested.

type Entry = [string, FormDataEntryValue];

/**
 * A stable text of what a form would send. Two snapshots are equal exactly when
 * submitting would send the same values, so "dirty" means changed against the
 * values the form started with, not merely touched (typing a letter and deleting
 * it again is clean). React's hidden `$ACTION_…` fields are left out; a file
 * counts by name and size.
 */
export function formSnapshot(entries: Iterable<Entry>): string {
  // order within one name matters (a list), order between names does not
  const byName = new Map<string, string[]>();
  for (const [name, value] of entries) {
    if (name.startsWith("$ACTION")) continue;
    const text = typeof value === "string" ? value : value.size > 0 || value.name ? `file:${value.name}:${value.size}` : "";
    const list = byName.get(name) ?? [];
    list.push(text);
    byName.set(name, list);
  }
  return JSON.stringify([...byName.keys()].sort().map((name) => [name, byName.get(name)]));
}

export function isDirty(baseline: string | null, current: string): boolean {
  return baseline !== null && baseline !== current;
}

export type LinkClick = {
  href: string;
  // the link's target attribute ("" when none)
  target: string;
  download: boolean;
  // MouseEvent.button
  button: number;
  // ctrl, meta, shift or alt held: the browser opens a new tab or window, the form stays
  modifier: boolean;
};

/** Whether clicking this link leaves the page the form is on (and so should ask first). */
export function linkLeavesPage(click: LinkClick, current: string): boolean {
  if (click.button !== 0 || click.modifier || click.download) return false;
  if (click.target && click.target !== "_self") return false;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current);
    to = new URL(click.href, from);
  } catch {
    return false;
  }
  // mailto:, tel:, javascript: and the like do not unload the page
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  if (to.origin === from.origin) {
    // a jump within the same page (#section) keeps the form
    if (to.pathname === from.pathname && to.search === from.search) return false;
    // a file download (/o/<org>/files/<id>) or a list export answers with a file: the page stays
    if (/^\/o\/[^/]+\/files\/[^/]+\/?$/.test(to.pathname) || /^\/o\/[^/]+\/[a-z-]+\/export\/?$/.test(to.pathname)) return false;
  }
  return true;
}
