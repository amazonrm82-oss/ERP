import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "@fontsource-variable/heebo";
import "./globals.css";

import { ConfigMissing } from "@/components/config-missing";
import { ServiceWorker } from "@/components/service-worker";
import { APP_DESCRIPTION, APP_NAME, THEME_COLOR } from "@/lib/app";
import { getSupabaseEnv } from "@/lib/env";

export const metadata: Metadata = {
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
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  formatDetection: { telephone: false },
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

  return (
    <html lang="he" dir="rtl">
      <body className="min-h-dvh antialiased">
        {isConfigured ? children : <ConfigMissing />}
        <ServiceWorker />
      </body>
    </html>
  );
}
