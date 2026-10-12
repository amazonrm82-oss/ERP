// CAP-02 / ADS-01: where a lead came from. Used on the server (parsing a form
// post or a webhook body), in the browser (collecting it on the hosted form)
// and on the lead card (showing it). No server-only imports here.
//
// The database cleans the same object again (app.intake_attribution(),
// migration 0051); keep the rules of parseAttribution() in step with it.

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export const CLICK_ID_KEYS = ["gclid", "fbclid", "ctwa_clid"] as const;
export const URL_KEYS = ["referrer_url", "landing_url"] as const;
export const ATTRIBUTION_KEYS = [...UTM_KEYS, ...CLICK_ID_KEYS, ...URL_KEYS] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];
export type Attribution = Partial<Record<AttributionKey, string>>;

const UTM_MAX = 200;
const CLICK_ID_MAX = 500;
const URL_MAX = 2000;
const CLICK_ID = /^[A-Za-z0-9._~-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
// half of an emoji (a lone UTF-16 surrogate): Postgres refuses the whole JSON payload, and the lead would be lost
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text that is always safe to send to the database: no control characters, no half
 * emoji, at most `max` characters, cut between characters (code points), never inside one.
 * A bad value must never cost a lead.
 */
export function safeText(value: string, max: number): string {
  // line breaks and tabs stay (a message has paragraphs); every other control character goes
  return Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(LONE_SURROGATE, ""))
    .slice(0, max)
    .join("")
    .trim();
}

// "scheme://user:pass@" -> "scheme://" (greedy: up to the last @ before the path, query or fragment)
const USER_INFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

/** The query parameters a stored landing page address may keep (CAP-02, owner 12 October 2026). */
export const CAMPAIGN_KEYS: readonly string[] = [...UTM_KEYS, ...CLICK_ID_KEYS];

/**
 * A page address with only its campaign parameters: the fragment, any user info
 * (user:pass@ in the authority) and every other query parameter are removed; the
 * kept ones stay exactly as written and in order.
 * Plain text work, no URL parsing, so the embed script (embed-script.ts) and the
 * database (app.campaign_only_url(), migration landing_url_campaign_only) do exactly
 * the same; keep the three in step.
 */
export function campaignOnlyUrl(value: string): string {
  const base = value.split("#")[0].replace(USER_INFO, "$1");
  const q = base.indexOf("?");
  if (q < 0) return base;
  const kept = base
    .slice(q + 1)
    .split("&")
    .filter((part) => CAMPAIGN_KEYS.includes(part.split("=")[0]));
  return kept.length > 0 ? `${base.slice(0, q)}?${kept.join("&")}` : base.slice(0, q);
}

// Other names webhook senders use for the same thing (the canonical key wins).
const ALIASES: Partial<Record<AttributionKey, string[]>> = {
  utm_campaign: ["campaign"],
  referrer_url: ["referrer", "referer"],
  landing_url: ["page_url"],
};

function cleanUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > URL_MAX || /\s/.test(trimmed) || HAS_CONTROL.test(trimmed) || /[\ud800-\udfff]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function cleanValue(key: AttributionKey, value: unknown): string | null {
  if (typeof value !== "string") return null;
  // the landing page keeps only its campaign parameters (CAP-02, owner 12 October 2026)
  if (key === "landing_url") return cleanUrl(campaignOnlyUrl(value.trim()));
  if ((URL_KEYS as readonly string[]).includes(key)) return cleanUrl(value);
  if ((CLICK_ID_KEYS as readonly string[]).includes(key)) {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= CLICK_ID_MAX && CLICK_ID.test(trimmed) ? trimmed : null;
  }
  const text = safeText(value.replace(CONTROL, "").trim(), UTM_MAX);
  return text === "" ? null : text;
}

/** The attribution keys of a form post or webhook body: known keys only, checked and cut; the rest is ignored. */
export function parseAttribution(body: Record<string, unknown>): Attribution {
  const out: Attribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    for (const name of [key, ...(ALIASES[key] ?? [])]) {
      const value = cleanValue(key, body[name]);
      if (value !== null) {
        out[key] = value;
        break;
      }
    }
  }
  return out;
}

const PASS_THROUGH: readonly AttributionKey[] = [...UTM_KEYS, ...CLICK_ID_KEYS];

function paramsOf(href: string | null | undefined): URLSearchParams | null {
  if (!href) return null;
  try {
    return new URL(href).searchParams;
  } catch {
    return null;
  }
}

/**
 * What the hosted form sends along (browser side), from its own address and
 * document.referrer.
 * - Opened directly (/f/<token>?utm_source=...): the landing page is the form's
 *   own address and the referrer is the page the visitor came from.
 * - Embedded (?embed=1): the iframe cannot see the host page's address, so the
 *   embed script (/f/embed.js, embed-script.ts) passes it as `page_url`, campaign
 *   parameters only (a hand-written embed may also pass the host referrer as `ref`).
 *   UTMs and click ids are read from the iframe's own address first, then from
 *   page_url. Without page_url the landing page is document.referrer, which
 *   inside an iframe is the host page (often its origin only), and the
 *   referrer stays empty.
 */
export function collectAttribution(href: string, referrer: string): Attribution {
  const own = paramsOf(href) ?? new URLSearchParams();
  const embedded = own.get("embed") === "1";
  const pageUrl = embedded ? own.get("page_url") : null;
  const host = paramsOf(pageUrl);
  const raw: Record<string, unknown> = {};
  for (const key of PASS_THROUGH) {
    raw[key] = own.get(key) ?? host?.get(key) ?? undefined;
  }
  if (embedded) {
    raw.landing_url = pageUrl || referrer || undefined;
    raw.referrer_url = own.get("ref") || undefined;
  } else {
    raw.landing_url = href;
    raw.referrer_url = referrer || undefined;
  }
  return parseAttribution(raw);
}

// ---------------------------------------------------------------------------
// Showing it on the lead card
// ---------------------------------------------------------------------------

export type LeadAttributionColumns = {
  campaign: string | null;
  utm: unknown;
  referrer_url: string | null;
  landing_url: string | null;
  gclid: string | null;
  fbclid: string | null;
  ctwa_clid: string | null;
  meta_lead_id: string | null;
};

export type AttributionRow = { label: string; value: string; ltr?: boolean };

const CLICK_PLATFORMS: Array<[keyof LeadAttributionColumns, string]> = [
  ["gclid", "Google Ads"],
  ["fbclid", "Facebook"],
  ["ctwa_clid", "WhatsApp"],
  ["meta_lead_id", "Meta Lead Ads"],
];

function utmValue(utm: unknown, key: string): string | null {
  if (!utm || typeof utm !== "object" || Array.isArray(utm)) return null;
  const value = (utm as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Page address without the protocol, cut for a narrow card (the full address stays in the database). */
function shortUrl(value: string): string {
  const bare = value.replace(/^https?:\/\//i, "");
  return bare.length > 80 ? `${bare.slice(0, 79)}…` : bare;
}

/** The lead card's "where it came from" lines, only the ones that have a value. */
export function attributionRows(lead: LeadAttributionColumns): AttributionRow[] {
  const rows: AttributionRow[] = [];
  const campaign = lead.campaign ?? utmValue(lead.utm, "utm_campaign");
  if (campaign) rows.push({ label: "קמפיין", value: campaign });
  const source = utmValue(lead.utm, "utm_source");
  const medium = utmValue(lead.utm, "utm_medium");
  if (source || medium) rows.push({ label: "מקור הפנייה", value: [source, medium].filter(Boolean).join(" / ") });
  const content = utmValue(lead.utm, "utm_content");
  if (content) rows.push({ label: "מודעה", value: content });
  const term = utmValue(lead.utm, "utm_term");
  if (term) rows.push({ label: "מילת חיפוש", value: term });
  if (lead.referrer_url) rows.push({ label: "הגיע מהדף", value: shortUrl(lead.referrer_url), ltr: true });
  if (lead.landing_url) rows.push({ label: "דף הנחיתה", value: shortUrl(lead.landing_url), ltr: true });
  const clicks = CLICK_PLATFORMS.filter(([key]) => lead[key]).map(([, name]) => name);
  if (clicks.length > 0) rows.push({ label: "מזהה פרסום", value: clicks.join(", ") });
  return rows;
}
