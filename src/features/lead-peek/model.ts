// UX-01: the lead side panel's rules that need no database (unit-tested). Owner's answers 214-218, 10 November 2026.

import { paths } from "@/lib/paths";

/** The mark on the row of the lead open in the panel (owner (214) ב (9)): a light background and an accent edge at its start. */
export const PEEK_ROW_MARK =
  "bg-canvas rtl:shadow-[inset_-3px_0_0_var(--color-accent)] ltr:shadow-[inset_3px_0_0_var(--color-accent)]";

/** At most this many "מה ביקש" fields (UX-01 (2), owner (218) א). */
export const PEEK_ASKED_MAX = 4;
/** The last timeline items the panel shows (UX-01 (5)). */
export const PEEK_TIMELINE_MAX = 5;
/** The custom field the default picks for "quantity", by its label. */
export const QUANTITY_LABEL = "כמות";

export type PeekAskedField = { key: string; label: string; text: string | null; ltr?: boolean };

/**
 * The default "מה ביקש" fields (owner (218) א): the requested product, the custom field called "כמות" (else the first
 * active custom field), the next active custom field, then the message. Empty fields are left out; at most
 * PEEK_ASKED_MAX. `custom` is the business's active custom fields in their order, already formatted.
 * (The business's own choice, a "פאנל צד" group in card_layouts, is a follow-up.)
 */
export function defaultAskedFields(input: {
  requestedProduct: string | null;
  custom: ReadonlyArray<{ key: string; label: string; text: string | null; ltr?: boolean }>;
  message: string | null;
}): PeekAskedField[] {
  const quantity = input.custom.find((field) => field.label.trim() === QUANTITY_LABEL) ?? input.custom[0] ?? null;
  const next = input.custom.find((field) => field !== quantity) ?? null;
  const custom = [quantity, next].filter((field): field is NonNullable<typeof field> => field !== null);
  const fields: PeekAskedField[] = [
    { key: "requested_product", label: "מוצר מבוקש", text: input.requestedProduct },
    ...custom.map((field) => ({ key: `cf:${field.key}`, label: field.label, text: field.text, ltr: field.ltr })),
    { key: "message", label: "הודעה", text: input.message },
  ];
  return fields.filter((field) => field.text !== null && field.text.trim() !== "").slice(0, PEEK_ASKED_MAX);
}

/** The previous and next lead of the list as it is shown (↑ / ↓), or null at either end or when the lead is not on the page. */
export function peekNeighbours(ids: ReadonlyArray<string>, id: string): { previous: string | null; next: string | null } {
  const at = ids.indexOf(id);
  if (at < 0) return { previous: null, next: null };
  return { previous: at > 0 ? ids[at - 1] : null, next: at < ids.length - 1 ? ids[at + 1] : null };
}

/** The list's address with `peek` set (or removed with null), keeping every other parameter. */
export function peekHref(listPath: string, params: URLSearchParams, id: string | null): string {
  const next = new URLSearchParams(params);
  next.delete("peek");
  if (id) next.set("peek", id);
  const suffix = next.toString();
  return suffix ? `${listPath}?${suffix}` : listPath;
}

type Query = Record<string, string | string[] | undefined>;

export type PeekLinks = {
  // the lead the address asks the panel to show
  peekId: string | null;
  // the page's own parameters without `peek`
  params: URLSearchParams;
  // a row's link: the panel; the open lead's own row: its full page (UX-01: a second click on the name)
  hrefFor: (leadId: string) => string;
  closeHref: string;
  // the same for a client component (the board), which cannot take a function from the server
  rows: PeekRows;
};

export type PeekRows = { orgId: string; listPath: string; params: string; peekId: string | null };

/** A row's link from PeekRows: the panel, or the full page for the lead already open in it. */
export function peekRowHref(rows: PeekRows, leadId: string): string {
  return leadId === rows.peekId ? paths.lead(rows.orgId, leadId) : peekHref(rows.listPath, new URLSearchParams(rows.params), leadId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The panel's links on a list page (the leads table and board, the waiting list, My day). */
export function peekLinks(orgId: string, listPath: string, query: Query): PeekLinks {
  const params = new URLSearchParams();
  let peekId: string | null = null;
  for (const [key, value] of Object.entries(query)) {
    const one = Array.isArray(value) ? value[0] : value;
    if (!one) continue;
    if (key === "peek") peekId = UUID.test(one) ? one.toLowerCase() : null;
    else params.set(key, one);
  }
  const rows: PeekRows = { orgId, listPath, params: params.toString(), peekId };
  return {
    peekId,
    params,
    hrefFor: (leadId) => peekRowHref(rows, leadId),
    closeHref: peekHref(listPath, params, null),
    rows,
  };
}

/**
 * What the panel lets this person do (owner's answers 187 ב, 213 ב, 216 ב):
 * - "take_only": a lead nobody owns that the person sees only because it is offered to take (public.unowned_lead):
 *   read, call / WhatsApp / email (which take it first), and "לקחתי"; nothing is written before taking.
 * - "work": a lead the person reads: log a call, a note and a task when they write in the business; change the status
 *   and mark it not relevant only when they may edit it.
 * - "read": someone who does not write (a viewer, a support session, a business that is read only).
 */
export type PeekMode = "work" | "take_only" | "read";

export type PeekRights = {
  mode: PeekMode;
  // the call / note / task buttons
  canLog: boolean;
  // the status chip and "לא רלוונטי"
  canEdit: boolean;
  // "לקחתי", and call / WhatsApp / email take the lead first (216 ב)
  canTake: boolean;
};

export function peekRights(input: {
  offeredOnly: boolean;
  canWrite: boolean;
  canEditRecord: boolean;
  ownerId: string | null;
  statusKind: string | null | undefined;
  converted: boolean;
}): PeekRights {
  const open = input.statusKind === "open" && !input.converted;
  const canTake = input.canWrite && input.ownerId === null && open;
  if (input.offeredOnly) return { mode: input.canWrite ? "take_only" : "read", canLog: false, canEdit: false, canTake };
  if (!input.canWrite) return { mode: "read", canLog: false, canEdit: false, canTake: false };
  return { mode: "work", canLog: !input.converted, canEdit: input.canEditRecord && !input.converted, canTake };
}

/** A call-back's date and time (UX-01 "לחזור ב…"): both given, in the future. Null = fine, else the Hebrew problem. */
export function callBackProblem(date: string, time: string, now: Date, dueIso: (date: string, time: string) => string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "יש לבחור תאריך.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return "יש לבחור שעה.";
  if (Date.parse(dueIso(date, time)) <= now.getTime()) return "הזמן הזה כבר עבר. בחרו זמן מאוחר יותר.";
  return null;
}

/** The time a "לחזור ב…" day starts with (owner (214) ב (5)). */
export const CALL_BACK_TIME = "10:00";

export type CallBackShortcut = "hour" | "tomorrow" | "week";
export type CallBackPick = { date: string; time: string; moved: boolean };

/**
 * "לחזור ב…" (owner (214) ב (5)): the default and "מחר" are the next working day at 10:00; "בעוד שעה" is now + 1 hour
 * on the business's clock, rounded up to 5 minutes; "בעוד שבוע" is in 7 days at 10:00. A day the business does not
 * work becomes the next working day (`moved`, so the screen can say so). `today` and `nowTime` are the business's
 * date and HH:MM; `workingDay` is nextWorkingDay with its calendar.
 */
export function callBackPick(
  shortcut: CallBackShortcut,
  today: string,
  nowTime: string,
  workingDay: (day: string) => string,
  addDaysTo: (day: string, count: number) => string,
): CallBackPick {
  if (shortcut === "hour") {
    const [h, m] = nowTime.split(":").map(Number);
    let minutes = Math.ceil((h * 60 + m + 60) / 5) * 5;
    const date = minutes >= 24 * 60 ? addDaysTo(today, 1) : today;
    minutes %= 24 * 60;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    return { date, time, moved: false };
  }
  const plain = addDaysTo(today, shortcut === "week" ? 7 : 1);
  const date = workingDay(plain);
  return { date, time: CALL_BACK_TIME, moved: date !== plain };
}

/**
 * Owner (214) ב (7): "נכנס לפני X" is left out while the "לא נענה X" chip shows, because both count from the time the
 * lead came in and would say the same thing twice.
 */
export function showCreatedAgo(waiting: boolean): boolean {
  return !waiting;
}

/** A timeline item's link (owner (214) ב (8)): the lead's full page at that entry. */
export function timelineItemHref(orgId: string, leadId: string, entryAnchor: string): string {
  return `${paths.lead(orgId, leadId)}#${entryAnchor}`;
}
