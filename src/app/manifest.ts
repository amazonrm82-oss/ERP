import type { MetadataRoute } from "next";

import { shareTarget } from "@/features/share/share";
import { SHORTCUTS, shortcutUrl } from "@/features/shortcuts/shortcuts";
import { APP_DESCRIPTION, APP_NAME, THEME_COLOR } from "@/lib/app";

/** Web app manifest: lets the app be installed to the home screen and open in its own window. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // the id stays "/" so an app installed before LND-07 is not installed twice
    id: "/",
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    lang: "he",
    dir: "rtl",
    // the installed app opens the app, not the landing page (LND-07)
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    // the light canvas of the design system: the splash screen an installed app opens on
    background_color: "#f4f6f8",
    theme_color: THEME_COLOR,
    categories: ["business", "productivity"],
    // USR-08 (owner, 18 October 2026): a long press on the app icon; each opens in the last business worked in
    shortcuts: SHORTCUTS.map((shortcut) => ({
      name: shortcut.name,
      short_name: shortcut.name,
      url: shortcutUrl(shortcut.target),
      icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    })),
    // WAB-06: "שתף ל-Mexuz" from any app (Chrome on Android): text, a link or one image. One POST, answered by the
    // service worker, which keeps the share on the device until the person picks what to do with it
    share_target: shareTarget(),
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
