// USR-11 second part / WAB-03: the person's own daily summary email setting. Mirrors public.digest_settings (migration
// daily_digest): off by default, 07:30 by default, a quarter hour between 05:00 and 12:00, in the business's time zone.

export type DigestKind = "manager" | "personal";

export type DigestSettings = {
  enabled: boolean;
  sendAt: string;
  /** owner (377) ב: when the person stopped it from the link in an email (cleared when they switch it on again) */
  stoppedByLinkAt?: string | null;
};

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = { enabled: false, sendAt: "07:30" };

/** Every time the database accepts, "05:00" .. "12:00" by quarter hours (the constraint digest_settings_send_at). */
export const DIGEST_TIMES: readonly string[] = (() => {
  const times: string[] = [];
  for (let minutes = 5 * 60; minutes <= 12 * 60; minutes += 15) {
    times.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return times;
})();

/** app.digest_kind_for: owners, admins and managers get the business lines. */
export function digestKindFor(role: string | null | undefined): DigestKind {
  return role === "owner" || role === "admin" || role === "manager" ? "manager" : "personal";
}

/** A stored row (time as "HH:MM:SS") as the form shows it; no row = the defaults. */
export function digestSettingsFromRow(
  row: { enabled: boolean; send_at: string; stopped_by_link_at?: string | null } | null | undefined,
): DigestSettings {
  if (!row) return { ...DEFAULT_DIGEST_SETTINGS };
  const sendAt = row.send_at.slice(0, 5);
  const settings: DigestSettings = { enabled: row.enabled === true, sendAt: DIGEST_TIMES.includes(sendAt) ? sendAt : DEFAULT_DIGEST_SETTINGS.sendAt };
  if (row.stopped_by_link_at) settings.stoppedByLinkAt = row.stopped_by_link_at;
  return settings;
}

export const DIGEST_TIME_INVALID = "בחרו שעה מהרשימה, בין 05:00 ל-12:00.";

/** The form's two fields: the switch (a checkbox) and the time (one of DIGEST_TIMES). */
export function parseDigestForm(
  enabled: FormDataEntryValue | null,
  sendAt: FormDataEntryValue | null,
): { ok: true; settings: DigestSettings } | { ok: false; message: string } {
  const time = typeof sendAt === "string" ? sendAt.trim() : "";
  if (!DIGEST_TIMES.includes(time)) return { ok: false, message: DIGEST_TIME_INVALID };
  return { ok: true, settings: { enabled: enabled === "on", sendAt: time } };
}
