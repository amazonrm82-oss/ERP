import type { MetadataRoute } from "next";

import { configuredSiteUrl } from "@/lib/site-origin";

// LND-11: the landing page, help center and legal pages are for everyone; the
// app, the sign-in screens and the customers' lead forms are not for search
// engines (each of those pages also says noindex).
export default function robots(): MetadataRoute.Robots {
  const site = configuredSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: ["/$", "/help", "/legal"],
      disallow: ["/o/", "/app", "/admin", "/api/", "/f/", "/login", "/signup", "/forgot-password", "/reset-password", "/onboarding", "/invite", "/agreement", "/auth"],
    },
    sitemap: site ? new URL("/sitemap.xml", site).toString() : undefined,
  };
}
