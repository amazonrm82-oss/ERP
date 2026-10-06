import { zoneDate, zonedIso } from "@/lib/format";

export const PERIOD_OPTIONS = [
  { value: "this_month", label: "החודש" },
  { value: "last_month", label: "החודש שעבר" },
  { value: "last_30", label: "30 הימים האחרונים" },
  { value: "last_90", label: "90 הימים האחרונים" },
  { value: "this_year", label: "השנה" },
  { value: "custom", label: "טווח אחר" },
] as const;

export type PeriodKey = (typeof PERIOD_OPTIONS)[number]["value"];

export type Period = {
  key: PeriodKey;
  // calendar dates in the organization's time zone, both inclusive
  fromDate: string;
  toDate: string;
  // UTC instants for the database: [from, to)
  from: string;
  to: string;
  // the same length of time just before, for comparisons
  prevFrom: string;
  prevTo: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

function validDate(value: string | undefined): value is string {
  return Boolean(value && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)));
}

/** The report period from the query string; "this month" when missing or invalid. */
export function parsePeriod(params: { period?: string; from?: string; to?: string }, now: Date = new Date()): Period {
  const today = zoneDate(now);
  const [year, month] = today.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const key = (PERIOD_OPTIONS.some((o) => o.value === params.period) ? params.period : "this_month") as PeriodKey;

  let fromDate: string;
  let toDate: string;
  switch (key) {
    case "last_month": {
      const prev = month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, "0")}-01`;
      fromDate = prev;
      toDate = addDays(monthStart, -1);
      break;
    }
    case "last_30":
      fromDate = addDays(today, -29);
      toDate = today;
      break;
    case "last_90":
      fromDate = addDays(today, -89);
      toDate = today;
      break;
    case "this_year":
      fromDate = `${year}-01-01`;
      toDate = today;
      break;
    case "custom":
      if (validDate(params.from) && validDate(params.to) && params.from <= params.to && daysBetween(params.from, params.to) <= 3660) {
        fromDate = params.from;
        toDate = params.to;
        break;
      }
      fromDate = monthStart;
      toDate = today;
      break;
    default:
      fromDate = monthStart;
      toDate = today;
  }

  const length = daysBetween(fromDate, toDate) + 1;
  const prevToDate = addDays(fromDate, -1);
  const prevFromDate = addDays(prevToDate, -(length - 1));
  return {
    key,
    fromDate,
    toDate,
    from: zonedIso(fromDate, "00:00:00"),
    to: zonedIso(addDays(toDate, 1), "00:00:00"),
    prevFrom: zonedIso(prevFromDate, "00:00:00"),
    prevTo: zonedIso(fromDate, "00:00:00"),
  };
}
