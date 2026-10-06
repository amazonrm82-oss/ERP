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
