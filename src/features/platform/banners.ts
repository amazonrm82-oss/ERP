// ADM-04: system banners on the platform screen. Pure, so parsing and the form rules are unit-tested.

export const BANNER_MAX_LENGTH = 300;
export const BANNER_MAX_ORGS = 200;

export const BANNER_SEVERITY_LABELS = { info: "מידע", warning: "אזהרה" } as const;
export type BannerSeverity = keyof typeof BANNER_SEVERITY_LABELS;

export const BANNER_TARGET_LABELS = { all: "כל העסקים", orgs: "עסקים מסוימים", plan: "עסקים בחבילה" } as const;
export type BannerTarget = keyof typeof BANNER_TARGET_LABELS;

export type AdminBanner = {
  id: string;
  body: string;
  severity: BannerSeverity;
  dismissable: boolean;
  target: BannerTarget;
  targetPlan: string | null;
  targetOrgs: { id: string; name: string }[];
  startsAt: string;
  endsAt: string;
  endedAt: string | null;
  dismissals: number;
};

export type BannerStatus = "upcoming" | "live" | "ended";
export const BANNER_STATUS_LABELS: Record<BannerStatus, string> = { upcoming: "מתוזמנת", live: "מוצגת עכשיו", ended: "הסתיימה" };

export function bannerStatus(banner: Pick<AdminBanner, "startsAt" | "endsAt" | "endedAt">, now: Date = new Date()): BannerStatus {
  if (banner.endedAt !== null || new Date(banner.endsAt) <= now) return "ended";
  return new Date(banner.startsAt) > now ? "upcoming" : "live";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export function parseAdminBanners(data: unknown): AdminBanner[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    .map((row) => ({
      id: str(row.id),
      body: str(row.body),
      severity: row.severity === "warning" ? "warning" : "info",
      dismissable: row.dismissable === true,
      target: row.target_kind === "orgs" || row.target_kind === "plan" ? row.target_kind : "all",
      targetPlan: typeof row.target_plan === "string" ? row.target_plan : null,
      targetOrgs: Array.isArray(row.target_orgs)
        ? row.target_orgs
            .filter((o): o is Record<string, unknown> => o !== null && typeof o === "object")
            .map((o) => ({ id: str(o.id), name: str(o.name) }))
        : [],
      startsAt: str(row.starts_at),
      endsAt: str(row.ends_at),
      endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
      dismissals: Number(row.dismissals) || 0,
    }));
}

/** One line: whitespace collapsed (the database stores it the same way). */
export function bannerText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Business ids pasted from the admin cards: any separator, each once, lower case. Text that is not an id is reported,
 * never guessed.
 */
export function parseOrgIds(value: string): { ids: string[]; rest: string } {
  const ids = [...new Set((value.match(UUID) ?? []).map((id) => id.toLowerCase()))];
  // a pasted card address (…/admin/orgs/<id>) counts as its id
  const rest = value.replace(/\S*\/admin\/orgs\//g, "").replace(UUID, "").replace(/[\s,;/]+/g, "");
  return { ids, rest };
}
