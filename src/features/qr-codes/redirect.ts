import { qrTargetUrlOk } from "./target-url";

// BIZ-03: where a scan leads. The database answers only the stored target and the code's name; nothing from the request is
// used. An internal target must be one of this app's public pages (a form, a booking page or a business card); an external
// one is the code's own stored link and must pass the same rule as the database (app.qr_target_url_ok). Anything else is
// treated as "not found".

const TARGET_PATH = /^\/f\/(?:book\/|card\/)?[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{32}$/;
// the tags a scan adds; the link's own values of these keys give way to them
const TAG_KEYS = new Set(["utm_source", "utm_campaign"]);

/** A code's token as printed in its link; anything else is not looked up. */
export function isQrToken(token: string): boolean {
  return TOKEN.test(token);
}

function qrTags(campaign: unknown): string {
  const query = new URLSearchParams({ utm_source: "qr" });
  if (typeof campaign === "string" && campaign.trim() !== "") query.set("utm_campaign", campaign.trim().slice(0, 200));
  return query.toString();
}

function queryKey(part: string): string {
  const raw = part.split("=", 1)[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A stored link with the QR tags added: its own path, query (every other parameter kept exactly as written) and fragment
 * stay; utm_source and utm_campaign are the code's.
 */
export function withQrTags(url: string, campaign: unknown): string {
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  const queryAt = base.indexOf("?");
  const path = queryAt >= 0 ? base.slice(0, queryAt) : base;
  const own = queryAt >= 0 ? base.slice(queryAt + 1).split("&").filter((part) => part !== "" && !TAG_KEYS.has(queryKey(part))) : [];
  return `${path}?${[...own, qrTags(campaign)].join("&")}${fragment}`;
}

/**
 * The URL a scan redirects to: the target's path on this site, or the code's stored https link, tagged as a QR visit with
 * the code's name as the campaign (CAP-02 keeps them on the lead). Null when the answer is not the expected shape.
 */
export function qrRedirectLocation(answer: unknown): string | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const { path, url, campaign } = answer as { path?: unknown; url?: unknown; campaign?: unknown };
  if (path !== undefined && url !== undefined) return null;
  if (typeof path === "string") return TARGET_PATH.test(path) ? `${path}?${qrTags(campaign)}` : null;
  if (typeof url === "string") return qrTargetUrlOk(url) ? withQrTags(url, campaign) : null;
  return null;
}
