import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "@fontsource-variable/heebo";
import "./globals.css";

import { ConfigMissing } from "@/components/config-missing";
import { FocusRescue } from "@/components/focus-rescue";
import { ServiceWorker } from "@/components/service-worker";
import { cspNonce, pageThemeChoice, PATH_HEADER, serverThemeAttribute, THEME_COOKIE, THEME_SCRIPT } from "@/features/theme/theme";
import { APP_DESCRIPTION, APP_NAME, THEME_COLOR } from "@/lib/app";
import { getSupabaseEnv } from "@/lib/env";
import { configuredSiteUrl } from "@/lib/site-origin";
import { startupImages } from "@/lib/startup-images";

export const metadata: Metadata = {
  // absolute links for the share image (src/app/opengraph-image.png)
  metadataBase: configuredSiteUrl(),
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
  applicationName: APP_NAME,
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
  },
  // iPhone: opens full screen from the home screen
  // USR-08: the launch screen while the installed app opens, one image per iPhone screen size
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default", startupImage: startupImages() },
  formatDetection: { telephone: false },
  // LND-11: not for search engines unless a page says otherwise; the app, the
  // sign-in screens and the customers' forms stay out. Public pages opt in:
  // the landing page, the help center and the final legal documents.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: THEME_COLOR,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request, so each one carries the nonce of its
  // Content-Security-Policy (FXS-05); a prerendered page would have scripts without it.
  await connection();
  // Without the Supabase settings nothing below can work, so the whole app is
  // replaced by one screen that says what is missing.
  const isConfigured = getSupabaseEnv() !== null;
  // USR-07: the person's own pick (a cookie per device) is on <html> from the first byte; "by the device" is settled by
  // the script in <head> before the page paints, so neither shows the wrong theme for a moment
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  // customer-facing pages (the landing page and /f/*) always render light: the choice is about the person's own app
  const themeChoice = pageThemeChoice(headerStore.get(PATH_HEADER), cookieStore.get(THEME_COOKIE)?.value);
  const nonce = cspNonce(headerStore.get("content-security-policy"));

  return (
    // the script may set data-theme before React hydrates
    <html lang="he" dir="rtl" data-theme={serverThemeAttribute(themeChoice)} data-theme-choice={themeChoice} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        {isConfigured ? children : <ConfigMissing />}
        <ServiceWorker />
        {/* FXA-08: focus never falls back to the top of the page when the focused control disappears */}
        <FocusRescue />
      </body>
    </html>
  );
}
