// ADM-04: the banners a business shows (public.system_banners_for). Pure, so the parsing is unit-tested.

export type BannerSeverity = "info" | "warning";

export type SystemBanner = { id: string; body: string; severity: BannerSeverity; dismissable: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps only well-formed rows (a malformed one is skipped, never shown half). */
export function parseSystemBanners(data: unknown): SystemBanner[] {
  if (!Array.isArray(data)) return [];
  const result: SystemBanner[] = [];
  for (const row of data) {
    if (row === null || typeof row !== "object") continue;
    const { id, body, severity, dismissable } = row as Record<string, unknown>;
    if (typeof id !== "string" || !UUID.test(id) || typeof body !== "string" || body.trim() === "") continue;
    if (severity !== "info" && severity !== "warning") continue;
    // an info banner can always be closed (the database says so too)
    result.push({ id, body, severity, dismissable: severity === "info" || dismissable === true });
  }
  return result;
}
