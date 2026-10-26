import { isCalendarDate } from "@/lib/calendar-date";

/**
 * ADM-01 (subprocessors): the platform's list of subprocessors, managed by the platform owner
 * (platform_add/update/remove/end_subprocessor, migration platform_subprocessors). An entry in force is
 * locked; it ends only from a future day. A new entry, or a new name or day, starts at least
 * SUBPROCESSOR_NOTICE_DAYS after today, the advance notice the DPA promises.
 */
export const SUBPROCESSOR_NOTICE_DAYS = 14;

/** The cache tag of the public page's read; the platform screen's actions revalidate it after a change. */
export const SUBPROCESSORS_CACHE_TAG = "subprocessors-public";

export type Subprocessor = {
  name: string;
  purpose: string;
  dataCategories: string;
  location: string | null;
  website: string | null;
  /** YYYY-MM-DD, the first day it applies */
  effectiveFrom: string;
  /** YYYY-MM-DD, the first day it no longer applies; null = no end */
  endsOn: string | null;
};

export type AdminSubprocessor = Subprocessor & { id: string; cancelled: boolean };

/**
 * upcoming: starts after today, may still change. in_force: applies today. ended: its end day has come.
 * cancelled: removed before it started.
 */
export type SubprocessorStatus = "upcoming" | "in_force" | "ended" | "cancelled";

export const SUBPROCESSOR_STATUS_LABELS: Record<SubprocessorStatus, string> = {
  upcoming: "עתידי",
  in_force: "בתוקף",
  ended: "הסתיים",
  cancelled: "הוסר",
};

export function subprocessorStatus(entry: Pick<AdminSubprocessor, "effectiveFrom" | "endsOn" | "cancelled">, today: string): SubprocessorStatus {
  if (entry.cancelled) return "cancelled";
  if (entry.effectiveFrom > today) return "upcoming";
  if (entry.endsOn !== null && entry.endsOn <= today) return "ended";
  return "in_force";
}

/** The day `days` after `day` (YYYY-MM-DD). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The first day a new subprocessor may start. */
export function firstNoticeDay(today: string): string {
  return addDays(today, SUBPROCESSOR_NOTICE_DAYS);
}

/** The public page's two groups: those that apply today, and those announced for a later day. */
export function splitPublicList(list: readonly Subprocessor[], today: string): { current: Subprocessor[]; upcoming: Subprocessor[] } {
  const live = list.filter((entry) => entry.endsOn === null || entry.endsOn > today);
  return {
    current: live.filter((entry) => entry.effectiveFrom <= today),
    upcoming: live.filter((entry) => entry.effectiveFrom > today),
  };
}

/** One entry of public.subprocessors_public_page(), or null when the shape is not what the function returns. */
export function parsePublicEntry(value: unknown): Subprocessor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
  const name = text(v.name);
  const purpose = text(v.purpose);
  const data = text(v.data_categories);
  const from = text(v.effective_from);
  const endsOn = text(v.ends_on);
  if (!name || !purpose || !data || !from || !isCalendarDate(from) || (endsOn !== null && !isCalendarDate(endsOn))) return null;
  // the public page's function names the location "country" and returns no website
  return { name, purpose, dataCategories: data, location: text(v.country), website: null, effectiveFrom: from, endsOn };
}

/** public.subprocessors_public_page(): the live entries and the day of the list's latest change, or null on another shape. */
export function parsePublicList(value: unknown): { entries: Subprocessor[]; updatedOn: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.entries)) return null;
  const entries = v.entries.map(parsePublicEntry);
  if (!entries.every((entry): entry is Subprocessor => entry !== null)) return null;
  const updatedOn = typeof v.updated_on === "string" && isCalendarDate(v.updated_on) ? v.updated_on : null;
  return { entries, updatedOn };
}

/**
 * Text as the database stores it (app.subprocessor_clean): every run of whitespace, the no-break and other Unicode
 * spaces included, becomes one space, and the ends are trimmed. A spacing fix is therefore not new content.
 */
export function collapseSpaces(input: string): string {
  return input.replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, " ").trim();
}

/** The fields whose change an upcoming entry announces (with the 14 days), as the forms name them. */
export const ANNOUNCED_FIELDS = ["name", "purpose", "data_categories", "effective_from"] as const;

/** Whether saving the form changes what was announced: any announced field differs after collapsing whitespace. */
export function changesAnnouncement(baseline: Partial<Record<string, string>>, values: Partial<Record<string, string>>, fields: readonly string[]): boolean {
  return fields.some((field) => collapseSpaces(values[field] ?? "") !== collapseSpaces(baseline[field] ?? ""));
}

/**
 * The public page's read, as the cache stores it: a refusal ({refused: "rate"}) or any other shape throws, so it is
 * never cached and the page falls back to the static list.
 */
export function publicListOrThrow(data: unknown): { entries: Subprocessor[]; updatedOn: string | null } {
  const list = parsePublicList(data);
  if (!list) throw new Error("subprocessors_public_page: refused or unexpected answer");
  return list;
}

/** How long the public page stops asking after a failed read (rate refusal, error, missing key). */
export const PUBLIC_READ_BACKOFF_MS = 60_000;

/**
 * Wraps a read that may throw: a failure answers null and holds every call for `backoffMs`, so a failing read is not
 * retried on every request; a success passes through.
 */
export function withBackoff<T>(
  read: () => Promise<T>,
  backoffMs: number,
  now: () => number = Date.now,
  onFail: (error: unknown) => void = () => undefined,
): () => Promise<T | null> {
  let failedUntil = 0;
  return async () => {
    if (now() < failedUntil) return null;
    try {
      return await read();
    } catch (error) {
      failedUntil = now() + backoffMs;
      onFail(error);
      return null;
    }
  };
}

/** One log line for a failed public read: our own short reason only (codes, never a key, a URL or a body). */
export function publicReadFailureLine(error: unknown): string {
  const reason = error instanceof Error ? error.message.replace(/[^\w :.-]/g, "").slice(0, 120) : "unknown";
  return `subprocessors public read failed, showing the static list: ${reason}`;
}

/** A website as stored: https only, no spaces, up to 200 characters (the table's check). Empty = null. */
export function normalizeWebsite(input: string): string | null | undefined {
  const text = input.trim();
  if (text === "") return null;
  return /^https:\/\/\S+$/.test(text) && text.length <= 200 ? text : undefined;
}
