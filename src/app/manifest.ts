import type { MetadataRoute } from "next";

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
    background_color: "#f5f6f7",
    theme_color: THEME_COLOR,
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
