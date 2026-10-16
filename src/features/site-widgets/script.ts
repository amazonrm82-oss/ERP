// SPD-07: the script a business puts on its own website (one line: <script src=".../f/w/<token>.js" async></script>).
// It draws a floating button with up to three choices: WhatsApp (wa.me link), a call (tel: link) and a short form, opened
// in a frame of this app (/f/widget/<token>). Owner, 13 October 2026: public display settings only; no cookies, no
// storage, no visitor id, no calls to anyone; the form gets only the host page's campaign parameters and its address
// reduced to them (the same rule as the form embed, CAP-02), and goes through intake_submit.
// Built by the server from public.site_widget_public(); every value goes in through JSON, never as markup. The DOM is
// made with createElement and textContent only, and styled through element.style (allowed by a strict style-src too).

import { CAMPAIGN_KEYS } from "@/features/intake/attribution";
import { EMBED_PAGE_URL_MAX, EMBED_VALUE_MAX } from "@/features/intake/embed-script";

import type { WidgetPosition } from "./public";

export type WidgetScriptSettings = {
  label: string;
  position: WidgetPosition;
  // wa.me digits, or null
  whatsapp: string | null;
  // "+<digits>", or null
  call: string | null;
  // the form's path on this app (/f/widget/<token>), or null when the widget shows no form
  formPath: string | null;
  // the business's colour, corrected for contrast (brandPalette), and the text on it
  accent: string;
  onAccent: string;
};

/** JSON that is safe anywhere in a script: no "<", no line separators. */
function scriptJson(value: unknown): string {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(lineSeparator)
    .join("\\u2028")
    .split(paragraphSeparator)
    .join("\\u2029");
}

export function widgetScript(settings: WidgetScriptSettings): string {
  return `/* Site widget: a floating contact button. No cookies, no storage, no visitor id. */
(function () {
  "use strict";
  var S = ${scriptJson(settings)};
  var KEYS = ${scriptJson(CAMPAIGN_KEYS)};
  var me = document.currentScript;
  if (!me || !me.src || typeof URL !== "function" || !document.body) return;
  var origin;
  try { origin = new URL(me.src).origin; } catch (e) { return; }
  if (document.getElementById("mx-site-widget")) return;

  function campaignOnly(value) {
    var base = value.split("#")[0].replace(/^([A-Za-z][A-Za-z0-9+.-]*:\\/\\/)[^/?#]*@/, "$1");
    var q = base.indexOf("?");
    if (q < 0) return base;
    var kept = base.slice(q + 1).split("&").filter(function (part) {
      return KEYS.indexOf(part.split("=")[0]) >= 0;
    });
    return kept.length > 0 ? base.slice(0, q) + "?" + kept.join("&") : base.slice(0, q);
  }

  function formUrl() {
    var src = new URL(S.formPath, origin);
    src.searchParams.set("embed", "1");
    var host = new URLSearchParams(window.location.search);
    KEYS.forEach(function (key) {
      var value = host.get(key);
      if (value) src.searchParams.set(key, value.slice(0, ${EMBED_VALUE_MAX}));
    });
    var loc = window.location;
    var page = campaignOnly(loc.origin + loc.pathname + loc.search);
    if (/^https?:/i.test(page) && page.length <= ${EMBED_PAGE_URL_MAX}) src.searchParams.set("page_url", page);
    return src.href;
  }

  function el(tag, style, text) {
    var node = document.createElement(tag);
    for (var key in style) node.style[key] = style[key];
    if (text) node.textContent = text;
    return node;
  }

  var side = S.position === "right" ? "right" : "left";
  var font = "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
  var root = el("div", { position: "fixed", bottom: "16px", zIndex: "2147483000", fontFamily: font, direction: "rtl" });
  root.id = "mx-site-widget";
  root.setAttribute("lang", "he");
  root.style[side] = "16px";

  var menu = el("div", { display: "none", flexDirection: "column", gap: "8px", marginBottom: "8px", alignItems: side === "left" ? "flex-start" : "flex-end" });
  menu.id = "mx-site-widget-menu";
  var choiceStyle = {
    display: "inline-flex", alignItems: "center", minHeight: "44px", padding: "0 16px", borderRadius: "22px",
    background: "#ffffff", color: "#1f2933", border: "1px solid #c5ccd3", fontSize: "16px", fontFamily: font,
    textDecoration: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.15)"
  };
  if (S.whatsapp) {
    var wa = el("a", choiceStyle, "WhatsApp");
    wa.href = "https://wa.me/" + S.whatsapp;
    wa.target = "_blank";
    wa.rel = "noopener noreferrer";
    menu.appendChild(wa);
  }
  if (S.call) {
    var call = el("a", choiceStyle, "חיוג");
    call.href = "tel:" + S.call;
    menu.appendChild(call);
  }

  var launcher = el("button", {
    minHeight: "48px", padding: "0 20px", borderRadius: "24px", border: "none", background: S.accent,
    color: S.onAccent, fontSize: "16px", fontWeight: "600", fontFamily: font, cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)"
  }, S.label);
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", menu.id);

  var panel = null;
  function closePanel() {
    if (!panel) return;
    panel.parentNode.removeChild(panel);
    panel = null;
    launcher.focus();
  }
  function openPanel() {
    if (panel) return;
    panel = el("div", {
      position: "fixed", bottom: "80px", width: "min(360px, calc(100vw - 32px))", height: "min(560px, calc(100vh - 112px))",
      background: "#ffffff", borderRadius: "12px", boxShadow: "0 8px 24px rgba(0,0,0,0.3)", overflow: "hidden",
      zIndex: "2147483001", display: "flex", flexDirection: "column"
    });
    panel.style[side] = "16px";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "השאירו פרטים");
    var close = el("button", {
      alignSelf: "flex-start", margin: "4px", minHeight: "44px", minWidth: "44px", border: "none", background: "transparent",
      color: "#1f2933", fontSize: "16px", fontFamily: font, cursor: "pointer"
    }, "סגירה");
    close.type = "button";
    close.addEventListener("click", closePanel);
    var frame = el("iframe", { flex: "1", width: "100%", border: "0" });
    frame.title = "השאירו פרטים";
    frame.src = formUrl();
    panel.appendChild(close);
    panel.appendChild(frame);
    document.body.appendChild(panel);
    close.focus();
  }
  if (S.formPath) {
    var form = el("button", choiceStyle, "השאירו פרטים");
    form.type = "button";
    form.addEventListener("click", function () { setOpen(false); openPanel(); });
    menu.appendChild(form);
  }
  if (!menu.firstChild) return;

  function setOpen(open) {
    menu.style.display = open ? "flex" : "none";
    launcher.setAttribute("aria-expanded", open ? "true" : "false");
  }
  launcher.addEventListener("click", function () { setOpen(menu.style.display === "none"); });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (panel) closePanel();
    else if (menu.style.display !== "none") { setOpen(false); launcher.focus(); }
  });

  root.appendChild(menu);
  root.appendChild(launcher);
  document.body.appendChild(root);
})();
`;
}
