import type { QrExternal } from "./redirect";

// BIZ-03 (owner, 27 October 2026, answer (ד)): the page a scan of an external link shows before the visitor goes on:
// "אתם עוברים לאתר [דומיין]. [שם העסק] אחראי לתוכן שלו". It is served by the scan route itself (one request, one counted
// scan), so it is a whole document of its own and does not pass through the app's layout: it is always light
// (color-scheme), takes its colours from the browser's own system colours (no palette value of its own), is not indexed,
// sends no referrer, and its continue link is the only way to the stored link.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text or an attribute value made safe for HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const INTERSTITIAL_TEXTS = {
  title: "מעבר לאתר אחר",
  continue: "המשך לאתר",
  back: "חזרה",
  close: "לא רוצים להמשיך? אפשר פשוט לסגור את הדף.",
} as const;

const NONCE = /^[A-Za-z0-9+/=_-]{1,200}$/;

/**
 * The whole page, in Hebrew, right to left; the host and the link read left to right. `nonce` is the request's CSP nonce
 * (the proxy's script-src allows only scripts that carry it); without one the back button simply stays hidden.
 */
export function qrInterstitialHtml(view: QrExternal, nonce?: string): string {
  const t = INTERSTITIAL_TEXTS;
  const host = escapeHtml(view.host);
  const unicode = view.hostUnicode ? ` (<bdi dir="auto">${escapeHtml(view.hostUnicode)}</bdi>)` : "";
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<title>${t.title}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; background: Canvas; color: CanvasText; font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; line-height: 1.6; }
main { box-sizing: border-box; max-width: 28rem; margin: 0 auto; padding: 2.5rem 1rem; }
h1 { font-size: 1.375rem; margin: 0 0 1rem; }
p { margin: 0 0 1rem; font-size: 1.0625rem; overflow-wrap: anywhere; }
.host { font-weight: 700; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.5rem 0 1rem; }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: 0 1.25rem; border-radius: 0.5rem; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; border: 2px solid LinkText; }
.continue { background: LinkText; color: Canvas; }
.back { background: Canvas; color: LinkText; }
.button:focus-visible { outline: 3px solid CanvasText; outline-offset: 2px; }
.note { font-size: 0.9375rem; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
<h1>${t.title}</h1>
<p>אתם עוברים לאתר <bdi dir="ltr" class="host">${host}</bdi>${unicode}. <bdi>${escapeHtml(view.business)}</bdi> אחראי לתוכן שלו.</p>
<div class="actions">
<a class="button continue" href="${escapeHtml(view.href)}" rel="noopener noreferrer" referrerpolicy="no-referrer">${t.continue}</a>
<button type="button" class="button back" id="qr-back" hidden>${t.back}</button>
</div>
<p class="note">${t.close}</p>
</main>
<script${nonce && NONCE.test(nonce) ? ` nonce="${nonce}"` : ""}>
(function () {
  var back = document.getElementById("qr-back");
  if (back && window.history.length > 1) {
    back.hidden = false;
    back.addEventListener("click", function () { window.history.back(); });
  }
})();
</script>
</body>
</html>`;
}
