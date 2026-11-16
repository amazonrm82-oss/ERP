// LND-14 (owner (388) א): the landing page's counters on the platform dashboard: visits, presses on a sign-up button and
// finished sign-ups, per day and per source (utm_source only), with the conversion rates. Counts only, read through
// public.platform_landing_measurement(days) (platform owner, support and readonly staff).

export type LandingCounts = { visits: number; signupClicks: number; signups: number };
export type LandingRow = LandingCounts & { day: string; source: string };
export type LandingMeasurement = { from: string | null; to: string | null; rows: LandingRow[] };

const count = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** The function's answer, read strictly (anything unexpected is left out). */
export function parseLandingMeasurement(data: unknown): LandingMeasurement {
  const obj = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const day = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const rows: LandingRow[] = [];
  for (const raw of Array.isArray(obj.rows) ? obj.rows : []) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const d = day(r.day);
    if (!d || typeof r.source !== "string" || r.source === "") continue;
    rows.push({ day: d, source: r.source, visits: count(r.visits), signupClicks: count(r.signup_clicks), signups: count(r.signups) });
  }
  return { from: day(obj.from), to: day(obj.to), rows };
}

const add = (a: LandingCounts, b: LandingCounts): LandingCounts => ({
  visits: a.visits + b.visits,
  signupClicks: a.signupClicks + b.signupClicks,
  signups: a.signups + b.signups,
});
const ZERO: LandingCounts = { visits: 0, signupClicks: 0, signups: 0 };

/**
 * The name a day's row is shown under: a source is named only on a day it had at least one visit; a name seen only on presses or
 * sign-ups that day (anyone can type any utm_source into the link) is shown as "other" (LND-14 review).
 */
export function shownSource(row: LandingRow): string {
  return row.visits > 0 || row.source === "direct" ? row.source : "other";
}

/** The period's totals, per source (most visits first) and per day (every day of the period, newest first, zeros included). */
export function summarizeLanding(m: LandingMeasurement): {
  total: LandingCounts;
  bySource: Array<LandingCounts & { source: string }>;
  byDay: Array<LandingCounts & { day: string }>;
} {
  const sources = new Map<string, LandingCounts>();
  const days = new Map<string, LandingCounts>();
  let total = ZERO;
  for (const row of m.rows) {
    total = add(total, row);
    const source = shownSource(row);
    sources.set(source, add(sources.get(source) ?? ZERO, row));
    days.set(row.day, add(days.get(row.day) ?? ZERO, row));
  }
  const bySource = [...sources.entries()]
    .map(([source, c]) => ({ source, ...c }))
    .sort((a, b) => b.visits - a.visits || b.signups - a.signups || a.source.localeCompare(b.source));
  const byDay: Array<LandingCounts & { day: string }> = [];
  if (m.from && m.to) {
    for (let d = new Date(`${m.to}T00:00:00Z`); d >= new Date(`${m.from}T00:00:00Z`) && byDay.length < 400; d.setUTCDate(d.getUTCDate() - 1)) {
      const key = d.toISOString().slice(0, 10);
      byDay.push({ day: key, ...(days.get(key) ?? ZERO) });
    }
  }
  return { total, bySource, byDay };
}

/** A rate as a whole percent, or "—" when there is nothing to divide by. */
export function rateText(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/** The source as shown: "direct" and "other" in Hebrew, anything else as it came. */
export function sourceLabel(source: string): string {
  if (source === "direct") return "ישיר (בלי מקור)";
  if (source === "other") return "אחר";
  return source;
}
