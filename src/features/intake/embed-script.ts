// CAP-02 (owner, 12 October 2026): the optional script line of a form's embed code.
// Served at /f/embed.js. On the business's own website it finds the embedded
// forms of this app (iframes /f/<token>?embed=1 from the script's own origin)
// and adds to their address only:
//   - the campaign parameters of the host page's address (utm_* and click ids), and
//   - the host page's address itself as `page_url`, reduced to those same parameters.
// No cookies, no storage, no tracking, no calls to anyone. The form page treats
// everything it receives as untrusted (collectAttribution -> parseAttribution,
// then the server and the database clean it again).
//
// campaignOnly() below mirrors campaignOnlyUrl() in attribution.ts; the unit test
// runs this script and checks the two agree.

import { CAMPAIGN_KEYS } from "./attribution";

/** Longest value copied from the host page per parameter (the form cuts again). */
export const EMBED_VALUE_MAX = 500;
/** Longest page address passed along (the same limit the intake keeps). */
export const EMBED_PAGE_URL_MAX = 2000;

export const EMBED_SCRIPT = `/* Lead form embed: passes only campaign parameters and the page address to the form. */
(function () {
  "use strict";
  var KEYS = ${JSON.stringify(CAMPAIGN_KEYS)};
  var me = document.currentScript;
  if (!me || !me.src || typeof URL !== "function") return;
  var origin;
  try { origin = new URL(me.src).origin; } catch (e) { return; }

  function campaignOnly(value) {
    var base = value.split("#")[0];
    var q = base.indexOf("?");
    if (q < 0) return base;
    var kept = base.slice(q + 1).split("&").filter(function (part) {
      return KEYS.indexOf(part.split("=")[0]) >= 0;
    });
    return kept.length > 0 ? base.slice(0, q) + "?" + kept.join("&") : base.slice(0, q);
  }

  function extend(frame) {
    if (frame.getAttribute("data-lead-form") === "1") return;
    var src;
    try { src = new URL(frame.getAttribute("src") || "", document.baseURI); } catch (e) { return; }
    if (src.origin !== origin || src.pathname.indexOf("/f/") !== 0 || src.searchParams.get("embed") !== "1") return;
    frame.setAttribute("data-lead-form", "1");
    var host = new URLSearchParams(window.location.search);
    KEYS.forEach(function (key) {
      var value = host.get(key);
      if (value && !src.searchParams.has(key)) src.searchParams.set(key, value.slice(0, ${EMBED_VALUE_MAX}));
    });
    var page = campaignOnly(window.location.href);
    if (/^https?:/i.test(page) && page.length <= ${EMBED_PAGE_URL_MAX} && !src.searchParams.has("page_url")) {
      src.searchParams.set("page_url", page);
    }
    if (src.href !== frame.src) frame.src = src.href;
  }

  var frames = document.getElementsByTagName("iframe");
  for (var i = 0; i < frames.length; i++) extend(frames[i]);
})();
`;
