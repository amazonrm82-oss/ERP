// BIZ-03: where a scan leads. The database answers only the stored target's own path and the code's name; nothing from
// the request is used. The path must be one of this app's public pages (a form or a booking page); anything else is
// treated as "not found", so a bad row can never send a visitor to another site.

const TARGET_PATH = /^\/f\/(?:book\/)?[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{32}$/;

/** A code's token as printed in its link; anything else is not looked up. */
export function isQrToken(token: string): boolean {
  return TOKEN.test(token);
}

/**
 * The relative URL a scan redirects to: the target's path, tagged as a QR visit with the code's name as the campaign
 * (CAP-02 keeps them on the lead). Null when the answer is not the expected shape.
 */
export function qrRedirectPath(answer: unknown): string | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const { path, campaign } = answer as { path?: unknown; campaign?: unknown };
  if (typeof path !== "string" || !TARGET_PATH.test(path)) return null;
  const query = new URLSearchParams({ utm_source: "qr" });
  if (typeof campaign === "string" && campaign.trim() !== "") query.set("utm_campaign", campaign.trim().slice(0, 200));
  return `${path}?${query.toString()}`;
}
