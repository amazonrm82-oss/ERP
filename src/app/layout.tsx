import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@fontsource-variable/heebo";
import "./globals.css";

import { ConfigMissing } from "@/components/config-missing";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app";
import { getSupabaseEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description: APP_DESCRIPTION,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Without the Supabase settings nothing below can work, so the whole app is
  // replaced by one screen that says what is missing.
  const isConfigured = getSupabaseEnv() !== null;

  return (
    <html lang="he" dir="rtl">
      <body className="min-h-dvh antialiased">{isConfigured ? children : <ConfigMissing />}</body>
    </html>
  );
}
