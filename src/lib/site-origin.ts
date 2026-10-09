import "server-only";

import { headers } from "next/headers";

// Public origin of the app, for links that leave the browser (confirmation
// emails, invitation links). NEXT_PUBLIC_SITE_URL wins when set; otherwise the
// origin of this request. Supabase only honours redirect URLs on the project's
// allow-list, so a forged Host header cannot send a confirmation link elsewhere.
export async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }
  const headerList = await headers();
  const origin = headerList.get("origin");
  if (origin) {
    return origin;
  }
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

/**
 * The site's public address when it is known without a request: for the
 * absolute link of the share image (DSN-15, LND-11). NEXT_PUBLIC_SITE_URL, or
 * on Vercel the production domain it provides; locally, none.
 */
export function configuredSiteUrl(): URL | undefined {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (configured) return new URL(configured);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? new URL(`https://${vercel}`) : undefined;
}
