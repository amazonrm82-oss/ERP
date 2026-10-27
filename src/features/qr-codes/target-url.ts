// BIZ-03 (owner, 18 October 2026, answer 2 ג): a QR code may open any https link. The rule mirrors
// app.qr_target_url_ok() (migration qr_targets); both read tests/unit/fixtures/qr-target-urls.json, so keep the two in step.

export const QR_URL_MAX = 2000;

const AUTHORITY = /^https:\/\/([^/?#]+)(?:[/?#][\s\S]*)?$/;
// the port: 1..65535, written without leading zeros
const HOST_PORT = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$/i;
// printable ASCII only: no spaces, no control or non-ASCII characters
const PRINTABLE = /^[!-~]+$/;

/** Whether a stored link may be a QR code's target: https, at most 2,000 characters, no user name or password, a real host. */
export function qrTargetUrlOk(url: string): boolean {
  if (url.length === 0 || url.length > QR_URL_MAX) return false;
  if (!PRINTABLE.test(url) || url.includes("\\")) return false;
  const authority = AUTHORITY.exec(url)?.[1];
  if (!authority || authority.includes("@")) return false;
  if (!HOST_PORT.test(authority)) return false;
  return authority.replace(/:[0-9]+$/, "").length <= 253;
}

export type QrUrlProblem = "empty" | "not-https" | "credentials" | "invalid" | "too-long";

/**
 * What a person typed, as the link to store: the browser's normalized form (an Israeli domain becomes punycode, spaces are
 * encoded), then the database's rule. A link typed without a scheme gets https://.
 */
export function normalizeQrTargetUrl(input: string): { ok: true; url: string } | { ok: false; problem: QrUrlProblem } {
  const typed = input.trim();
  if (typed === "") return { ok: false, problem: "empty" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, problem: "not-https" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, problem: "credentials" };
  const url = parsed.href;
  if (url.length > QR_URL_MAX) return { ok: false, problem: "too-long" };
  return qrTargetUrlOk(url) ? { ok: true, url } : { ok: false, problem: "invalid" };
}

export const QR_URL_MESSAGES: Record<QrUrlProblem, string> = {
  empty: "יש להזין את הקישור שהקוד פותח.",
  "not-https": "הקישור צריך להתחיל ב-https://.",
  credentials: "הקישור לא יכול לכלול שם משתמש או סיסמה.",
  invalid: "הקישור אינו תקין. בדקו את הכתובת, למשל https://www.example.co.il.",
  "too-long": "הקישור ארוך מדי (עד 2,000 תווים).",
};
