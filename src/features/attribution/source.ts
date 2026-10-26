import { attributionRows, type AttributionRow } from "@/features/intake/attribution";

// SEG-02: the first and last source of a lead or contact, as the cards and the lists show them. The first source is
// source_id + campaign + utm (a lead's is locked once set, DQL-04); the last source is the latest automatic inquiry's
// (form, business card, site widget, booking page), written by the server only.

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

/** "פייסבוק · אביב": the source and the campaign in one short line, or null when both are empty. */
export function sourceLine(name: string | null, campaign: string | null): string | null {
  const parts = [name?.trim(), campaign?.trim()].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

/** The lines of a source block: the source, then the campaign and UTM values the way the first-touch block shows them. */
export function sourceRows(source: { name: string | null; campaign: string | null; utm: unknown; atText?: string | null }): AttributionRow[] {
  const rows: AttributionRow[] = [];
  if (source.name) rows.push({ label: "מקור", value: source.name });
  rows.push(
    ...attributionRows({
      campaign: source.campaign?.trim() || null,
      utm: source.utm,
      referrer_url: null,
      landing_url: null,
      gclid: null,
      fbclid: null,
      ctwa_clid: null,
      meta_lead_id: null,
    }),
  );
  if (source.atText) rows.push({ label: "התקבלה", value: source.atText });
  return rows;
}

/**
 * DQL-04: whether a person may change a lead's or contact's first source once any part of it is set. Owners and admins
 * may; everyone else may only fill it while it is wholly empty (mirrors the trigger app.first_source_lock).
 */
export function mayChangeFirstSource(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** No first source at all: no source, no campaign, no UTM value (utm.extra alone does not count); = app.first_source_empty. */
export function firstSourceEmpty(record: { sourceId: string | null; campaign: string | null | undefined; utm: unknown }): boolean {
  const utm = record.utm && typeof record.utm === "object" && !Array.isArray(record.utm) ? (record.utm as Record<string, unknown>) : {};
  return !record.sourceId && !record.campaign?.trim() && Object.keys(utm).every((key) => key === "extra");
}

export type FirstSourceLock = { source: boolean; campaign: boolean; utm: string[] };

/**
 * The parts of the first source shown read-only to someone who may not change them. Lead's decision (26 October 2026): the
 * first source is locked as a whole once any part is set, so either everything is locked or nothing is.
 */
export function lockedFirstSource(record: { sourceId: string | null; campaign: string | null | undefined; utm: unknown }): FirstSourceLock {
  return firstSourceEmpty(record) ? { source: false, campaign: false, utm: [] } : { source: true, campaign: true, utm: [...UTM_KEYS] };
}
