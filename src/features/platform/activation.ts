import { formatDateTime, formatNumber } from "@/lib/format";

/** A length of time in Hebrew: minutes under an hour, hours under two days, else days. */
export function formatSpan(hours: number): string {
  const h = Math.max(0, hours);
  if (h < 1) return `${formatNumber(Math.round(h * 60))} דקות`;
  if (h < 48) return `${formatNumber(Math.round(h * 10) / 10)} שעות`;
  return `${formatNumber(Math.round(h / 24))} ימים`;
}

const hoursBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

/**
 * GAP-06, for the platform org card: when the first real lead got its answer,
 * how fast after the lead arrived, and how long after the organization signed up.
 */
export function activationText(activatedAt: string, leadCreatedAt: string, orgCreatedAt: string): string {
  return `${formatDateTime(activatedAt)} · מענה אחרי ${formatSpan(hoursBetween(leadCreatedAt, activatedAt))} · ${formatSpan(hoursBetween(orgCreatedAt, activatedAt))} מההרשמה`;
}
