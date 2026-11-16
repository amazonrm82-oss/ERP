import type { Metadata } from "next";

import { APP_NAME } from "@/lib/app";

// WEB-03: one shape for the metadata of a public marketing page. The address is relative: the root layout's
// metadataBase (NEXT_PUBLIC_SITE_URL, the only base address) makes the canonical and the Open Graph link absolute.
// The share image is the file src/app/opengraph-image.png. A file-based image reaches only pages that set no openGraph
// of their own (a page's openGraph replaces its parents' whole), so it is named here for every page; Twitter takes it
// from Open Graph. Texts are DRAFT wording: short, no prices.

/** the site's share image (src/app/opengraph-image.png and its .alt.txt) */
export const SITE_SHARE_IMAGE = {
  url: "/opengraph-image.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: `${APP_NAME}: ניהול לידים, לקוחות ועסקאות לעסקים בישראל`,
} as const;

export type PublicPageMeta = {
  /** the page's own name; the root template adds " | Mexuz" unless `absoluteTitle` */
  title: string;
  description: string;
  /** a same-site path starting with "/" */
  path: string;
  /** the whole title as written, without the template */
  absoluteTitle?: boolean;
  /** the title on a shared link, when it differs from the page title */
  shareTitle?: string;
  /** false: the page stays out of search engines (sign-in screens, interim legal texts) */
  index: boolean;
  type?: "website" | "article";
};

export function publicPageMetadata(page: PublicPageMeta): Metadata {
  const shareTitle = page.shareTitle ?? (page.absoluteTitle ? page.title : `${page.title} | ${APP_NAME}`);
  return {
    title: page.absoluteTitle ? { absolute: page.title } : page.title,
    description: page.description,
    alternates: { canonical: page.path },
    robots: page.index ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      type: page.type ?? "website",
      title: shareTitle,
      description: page.description,
      url: page.path,
      siteName: APP_NAME,
      locale: "he_IL",
      images: [SITE_SHARE_IMAGE],
    },
    twitter: { card: "summary_large_image", title: shareTitle, description: page.description },
  };
}
