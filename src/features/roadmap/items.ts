// TRU-01: the roadmap. Pure, so parsing, ordering and the form rules are unit-tested.
// Every text shown here is written by the Mexuz team; a customer's request text never reaches another customer.

export const ROADMAP_STATUSES = ["building", "planned", "done"] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_STATUS_LABELS: Record<RoadmapStatus, string> = {
  building: "בבנייה עכשיו",
  planned: "מתוכנן",
  done: "נבנה",
};

export const ROADMAP_TITLE_MAX = 120;
export const ROADMAP_DESCRIPTION_MAX = 1000;
export const ROADMAP_REQUESTS_MAX = 200;
export const ROADMAP_SORT_MIN = -100_000;
export const ROADMAP_SORT_MAX = 100_000;

export function isRoadmapStatus(value: unknown): value is RoadmapStatus {
  return typeof value === "string" && (ROADMAP_STATUSES as readonly string[]).includes(value);
}

/** What a business sees: published items, the vote count, whether this business voted, whether the caller may vote. */
export type RoadmapItem = {
  id: string;
  title: string;
  description: string;
  status: RoadmapStatus;
  votes: number;
  voted: boolean;
  canVote: boolean;
};

/** What the platform screen sees: every item, with the linked support request ids (never shown to a business; null for
 * the platform roles that do not read support requests: finance and readonly). */
export type AdminRoadmapItem = {
  id: string;
  title: string;
  description: string;
  status: RoadmapStatus;
  published: boolean;
  sortOrder: number;
  requestIds: string[] | null;
  votes: number;
};

/** The platform list: at most the newest ROADMAP_ADMIN_LIST_MAX items, and how many exist in all. */
export const ROADMAP_ADMIN_LIST_MAX = 500;
export type AdminRoadmapList = { items: AdminRoadmapItem[]; total: number };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const rows = (data: unknown) =>
  Array.isArray(data) ? data.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object") : [];
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

export function parseRoadmapItems(data: unknown): RoadmapItem[] {
  return rows(data)
    .filter((row) => isRoadmapStatus(row.status) && str(row.id) !== "")
    .map((row) => ({
      id: str(row.id),
      title: str(row.title),
      description: str(row.description),
      status: row.status as RoadmapStatus,
      votes: Math.max(0, Math.trunc(num(row.votes))),
      voted: row.voted === true,
      canVote: row.can_vote === true,
    }));
}

export function parseAdminRoadmapItems(data: unknown): AdminRoadmapItem[] {
  return rows(data)
    .filter((row) => isRoadmapStatus(row.status) && str(row.id) !== "")
    .map((row) => ({
      id: str(row.id),
      title: str(row.title),
      description: str(row.description),
      status: row.status as RoadmapStatus,
      published: row.published === true,
      sortOrder: Math.trunc(num(row.sort_order)),
      requestIds: Array.isArray(row.request_ids) ? row.request_ids.filter((id): id is string => typeof id === "string") : null,
      votes: Math.max(0, Math.trunc(num(row.votes))),
    }));
}

/** platform_list_roadmap_items' answer {items, total}; total is never below the items shown. */
export function parseAdminRoadmap(data: unknown): AdminRoadmapList {
  const obj = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const items = parseAdminRoadmapItems(obj.items);
  return { items, total: Math.max(items.length, Math.trunc(num(obj.total))) };
}

/** The line under a list cut at the newest 500, or null when every item is shown. */
export function adminListCutText(list: AdminRoadmapList): string | null {
  if (list.total <= list.items.length) return null;
  return `מוצגים ${list.items.length.toLocaleString("he-IL")} הפריטים החדשים מתוך ${list.total.toLocaleString("he-IL")}.`;
}

/** Items grouped by status, in the order the page shows them (building, planned, done); empty groups left out. */
export function groupByStatus<T extends { status: RoadmapStatus }>(items: readonly T[]): { status: RoadmapStatus; items: T[] }[] {
  return ROADMAP_STATUSES.map((status) => ({ status, items: items.filter((item) => item.status === status) })).filter(
    (group) => group.items.length > 0,
  );
}

/** "קול אחד" / "3 קולות": the count of businesses that voted. */
export function votesText(votes: number): string {
  if (votes === 0) return "אין עדיין קולות";
  if (votes === 1) return "קול אחד";
  return `${votes.toLocaleString("he-IL")} קולות`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Support request ids pasted by staff (one per line, or anything holding an id); duplicates removed, lower case. */
export function parseRequestIds(text: string): { ids: string[]; rest: string } {
  const ids = [...new Set((text.match(UUID) ?? []).map((id) => id.toLowerCase()))];
  const rest = text.replace(UUID, "").replace(/[\s,;]+/g, "");
  return { ids, rest };
}
