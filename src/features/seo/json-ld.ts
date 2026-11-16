import { APP_DESCRIPTION, APP_NAME } from "@/lib/app";

// WEB-03: structured data for the landing page. Only facts the site already states: the name, the address, the logo,
// the language, what the product is. No price, offer, rating or review: nothing here may be invented (Google's rules and
// the owner's: no number on the page is made up).

const LOGO_PATH = "/icons/apple-touch-icon.png";

export function landingJsonLd(site: URL | undefined): Record<string, unknown> {
  const url = site ? new URL("/", site).toString() : undefined;
  const organizationId = url ? `${url}#organization` : undefined;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        ...(organizationId ? { "@id": organizationId } : {}),
        name: APP_NAME,
        ...(url ? { url } : {}),
        ...(site ? { logo: new URL(LOGO_PATH, site).toString() } : {}),
      },
      {
        "@type": "SoftwareApplication",
        name: APP_NAME,
        description: APP_DESCRIPTION,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "CRM",
        operatingSystem: "Web, Android, iOS",
        inLanguage: "he",
        ...(url ? { url } : {}),
        ...(organizationId ? { publisher: { "@id": organizationId } } : {}),
      },
    ],
  };
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so no text can close the tag. */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
