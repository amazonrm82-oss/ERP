// IMP-03: reading the cells of a deals or tasks file. Pure (no database): dates, times, money,
// choices, tag lists and the keys that point at a linked record. Used by deal-rows.ts and
// task-rows.ts and by their unit tests.

import { isCalendarDate } from "@/lib/calendar-date";
import { parseMoneyToAgorot } from "@/lib/format";
import { websiteDomain } from "@/features/company-domain/domains";

/** Folds a cell for comparing with a list of words: case, quotes, dashes and spaces do not count. */
export const fold = (text: string) => text.trim().toLowerCase().replace(/["'״׳`]/g, "").replace(/[_\-.:]+/g, " ").replace(/\s+/g, " ");

/** The key a name (stage, pipeline, tag, source) is compared by: trimmed, spaces folded, without case. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

const pad = (n: string) => n.padStart(2, "0");

/**
 * A date cell, optionally with a time: "31/12/2026", "31.12.2026 14:30", "2026-12-31",
 * "2026-12-31T14:30", "2026-12-31 14:30:00". Day first, as written in Israel. null when it is
 * not a real day or the time is not a real time.
 */
export function parseDateTimeCell(value: string): { date: string; time: string | null } | null {
  const v = value.trim();
  const match =
    v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/) ??
    v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T\s,]+(\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  if (!match) return null;
  const iso = match[1].length === 4;
  const date = iso ? `${match[1]}-${pad(match[2])}-${pad(match[3])}` : `${match[3]}-${pad(match[2])}-${pad(match[1])}`;
  if (!isCalendarDate(date)) return null;
  if (match[4] === undefined) return { date, time: null };
  const time = parseTimeCell(`${match[4]}:${match[5]}`);
  return time ? { date, time } : null;
}

/**
 * A date cell -> "YYYY-MM-DD", or null. A time after the day is dropped: Excel keeps one on many
 * date cells, and the wizard passes it on (cellText) for the task due column.
 */
export function parseDateCell(value: string): string | null {
  return parseDateTimeCell(value)?.date ?? null;
}

// what the wizard makes of an Excel date cell with a time of day (cellText): "2026-12-31 14:30"
const EXCEL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/;

/**
 * A custom field cell as the field's parser expects it: a date field drops the time of an Excel
 * date cell, a date-and-time field takes it as "YYYY-MM-DDTHH:MM". Anything else is left as is.
 */
export function customCellValue(type: string | undefined, value: string): string {
  const match = EXCEL_DATE_TIME.exec(value);
  if (!match) return value;
  if (type === "date") return match[1];
  if (type === "datetime") return `${match[1]}T${match[2]}`;
  return value;
}

/** "9:05", "09:05", "14:30:00" -> "HH:MM", or null. */
export function parseTimeCell(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${pad(String(hours))}:${match[2]}`;
}

/**
 * A money cell -> agorot. Takes "1,250.50", "₪1250", and a number Excel stored with a binary
 * tail (99.99000000000001); null for anything else (negative amounts included).
 */
export function parseMoneyCell(raw: string): number | null {
  const cleaned = raw.replace(/[₪,\s]/g, "");
  if (cleaned === "") return null;
  if (/^\d+\.\d{3,}$/.test(cleaned)) {
    const cents = Number(cleaned) * 100;
    const rounded = Math.round(cents);
    return Math.abs(cents - rounded) < 1e-6 && Number.isSafeInteger(rounded) ? rounded : null;
  }
  return parseMoneyToAgorot(cleaned);
}

/** "VIP, לקוח חוזר; צפון" -> the distinct names, as written (first spelling wins, without case). */
export function splitTags(raw: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const name = part.trim().replace(/\s+/g, " ");
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    names.push(name);
  }
  return names;
}

export const TAG_NAME_MAX = 40;

/** How a cell points at a person record (lead or contact): an email, else a phone. */
export type PersonKey = { kind: "email"; value: string } | { kind: "phone"; value: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An email (lower case) or a phone as typed; null when the cell is neither. */
export function personKey(raw: string): PersonKey | null {
  const v = raw.trim();
  if (EMAIL_RE.test(v)) return { kind: "email", value: v.toLowerCase() };
  const digits = v.replace(/\D/g, "");
  if (/^\+?[\d\s\-().]{3,24}$/.test(v) && digits.length >= 7 && digits.length <= 15) return { kind: "phone", value: v };
  return null;
}

/**
 * How a cell points at a company: by name, and when it also reads as a domain, an address or a
 * site ("acme.co.il", "info@acme.co.il", "https://www.acme.co.il") by that domain too. The name is
 * tried first: a company may be called "Wix.com".
 */
export function companyKey(raw: string): { name: string; domain: string | null } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (/\s/.test(name)) return { name, domain: null };
  const at = name.lastIndexOf("@");
  const host = websiteDomain(at >= 0 ? name.slice(at + 1) : name);
  return { name, domain: host && host.includes(".") ? host : null };
}

/** The value of a cell from a closed list, by its stored value, its Hebrew label or a synonym; null when none. */
export function choiceOf<T extends string>(raw: string, options: ReadonlyArray<{ value: T; label: string }>, synonyms: Record<string, T> = {}): T | null {
  const f = fold(raw);
  for (const option of options) {
    if (fold(option.value) === f || fold(option.label) === f) return option.value;
  }
  return synonyms[f] ?? null;
}
