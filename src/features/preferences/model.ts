// CNS-09 / CNS-10 (owner's answer (225) א): the customer's unsubscribe link and public preferences page. The database side is
// migration _consent_preference_links.sql (public.consent_preferences_public / _submit, service_role only). The wording a
// "turn on" records is a DRAFT until the lawyer edits it; it mirrors app.preference_consent_wording() and
// app.preference_consent_version() word for word (unit test preferences reads the migration). A new text is a new version
// in a new migration.

/** The link's token: 64 base64url characters (only its SHA-256 is kept). */
export const PREFERENCES_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const preferencesPagePath = (token: string) => `/f/prefs/${token}`;
export const unsubscribePagePath = (token: string) => `/f/unsub/${token}`;
export const preferencesSubmitPath = (token: string) => `/api/forms/prefs/${token}`;
export const unsubscribeSubmitPath = (token: string) => `/api/forms/unsub/${token}`;

export const PREFERENCES_CONSENT_WORDING =
  "בחרתי בדף ההעדפות לקבל מהעסק הודעות שיווקיות בערוץ הזה. אפשר להפסיק בכל עת באותו דף או בקישור ההסרה שבכל הודעה.";
export const PREFERENCES_CONSENT_VERSION = "prefs-draft-1";

export const PREFERENCE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];
export type PreferenceState = "in" | "out" | "unknown";

export const PREFERENCE_CHANNEL_LABELS: Record<PreferenceChannel, string> = {
  email: "אימייל",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export type PreferenceChannelRow = { channel: PreferenceChannel; state: PreferenceState; canTurnOn: boolean };

export type PreferencesPage = {
  business: string;
  logoPath: string | null;
  color: string | null;
  builtWith: boolean;
  channel: PreferenceChannel;
  full: boolean;
  /** Owner (250) ב: a link a person on the staff copied, more than 7 days ago: it only removes (nothing is turned on from it). */
  unsubscribeOnly: boolean;
  channels: PreferenceChannelRow[];
};

const isChannel = (value: unknown): value is PreferenceChannel => typeof value === "string" && (PREFERENCE_CHANNELS as readonly string[]).includes(value);
const isState = (value: unknown): value is PreferenceState => value === "in" || value === "out" || value === "unknown";
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);

/** The database's answer as the page reads it, or null when it is not of the expected shape. */
export function preferencesPageFrom(data: unknown): PreferencesPage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.business !== "string" || !isChannel(d.channel) || typeof d.full !== "boolean" || !Array.isArray(d.channels)) return null;
  const brand = d.brand && typeof d.brand === "object" && !Array.isArray(d.brand) ? (d.brand as Record<string, unknown>) : {};
  const channels: PreferenceChannelRow[] = [];
  for (const row of d.channels) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (!isChannel(r.channel) || !isState(r.state) || typeof r.can_turn_on !== "boolean") return null;
    channels.push({ channel: r.channel, state: r.state, canTurnOn: r.can_turn_on });
  }
  return {
    business: d.business,
    logoPath: textOrNull(brand.logo),
    color: textOrNull(brand.color),
    builtWith: d.built_with === true,
    channel: d.channel,
    full: d.full,
    unsubscribeOnly: d.unsubscribe_only === true,
    channels,
  };
}

export type PreferenceChoice = { channel: PreferenceChannel; on: boolean };
export type PreferenceResult = "saved" | "unchanged" | "refused";

/** The choices a form sent: one per channel, at most three, nothing else; null when malformed. */
export function preferenceChoicesFrom(value: unknown): PreferenceChoice[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > PREFERENCE_CHANNELS.length) return null;
  const seen = new Set<string>();
  const out: PreferenceChoice[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { channel, on } = item as Record<string, unknown>;
    if (!isChannel(channel) || typeof on !== "boolean" || seen.has(channel)) return null;
    seen.add(channel);
    out.push({ channel, on });
  }
  return out;
}

/** The submit's answer: each channel's result, or null when malformed. */
export function preferenceResultsFrom(data: unknown): { channel: PreferenceChannel; result: PreferenceResult }[] | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const results = (data as Record<string, unknown>).results;
  if ((data as Record<string, unknown>).status !== "saved" || !Array.isArray(results)) return null;
  const out: { channel: PreferenceChannel; result: PreferenceResult }[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object") return null;
    const { channel, result } = row as Record<string, unknown>;
    if (!isChannel(channel) || (result !== "saved" && result !== "unchanged" && result !== "refused")) return null;
    out.push({ channel, result });
  }
  return out;
}

// The page's texts (Hebrew, short; DRAFT until the lawyer edits them)
export const PREFERENCES_TEXTS = {
  title: "העדפות דיוור",
  unsubscribeTitle: "הסרה מרשימת התפוצה",
  intro: "כאן בוחרים אם לקבל מאיתנו הודעות שיווקיות בערוץ הזה. הודעות שירות, כמו תזכורת לפגישה, ממשיכות להגיע.",
  removeAll: "הסרה מכל הערוצים",
  removeAllLine: "מפסיקים את ההודעות השיווקיות מאיתנו בכל הערוצים.",
  removedAll: "הוסרתם מכל הערוצים.",
  saved: "השינויים נשמרו.",
  refused: "לא ניתן לחדש כאן את ההרשמה לערוץ הזה. אפשר לפנות לעסק.",
  // owner (232) א: an older link, and a staff link past its 7 days (250) ב
  unsubscribeOnly: "בקישור הזה אפשר רק להפסיק את קבלת ההודעות. כדי להירשם מחדש, השתמשו בקישור שבהודעה האחרונה שקיבלתם מאיתנו, או פנו לעסק.",
  unsubscribeIntro: (channel: PreferenceChannel) => `להפסיק לקבל מאיתנו הודעות שיווקיות ב${channelPhrase(channel)}?`,
  unsubscribeNote: "הודעות שירות, כמו תזכורת לפגישה, ממשיכות להגיע.",
  unsubscribeButton: "כן, להסיר אותי",
  unsubscribed: "הוסרתם מרשימת התפוצה.",
  unsubscribedLine: "לא נשלח לכם עוד הודעות שיווקיות בערוץ הזה. הודעות שירות, כמו תזכורת לפגישה, ממשיכות להגיע.",
  morePreferences: "לשאר ההעדפות",
  draft: "הנוסח בדף הזה הוא טיוטה.",
} as const;

/** "באימייל" / "ב-SMS" / "ב-WhatsApp" without the leading ב (the caller adds it). */
export function channelPhrase(channel: PreferenceChannel): string {
  return channel === "email" ? "אימייל" : `-${PREFERENCE_CHANNEL_LABELS[channel]}`;
}

export const STATE_TEXTS: Record<PreferenceState, string> = {
  in: "מקבלים הודעות",
  out: "לא מקבלים הודעות",
  unknown: "לא נבחר",
};

export const PREFERENCES_MESSAGES = {
  "not-found": "הקישור אינו זמין. לקבלת קישור חדש פנו לעסק ששלח אותו.",
  "not-configured": "הדף אינו זמין כרגע.",
} as const;
