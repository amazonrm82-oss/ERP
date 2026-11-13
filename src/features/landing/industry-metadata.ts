import type { Metadata } from "next";

import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

import { industryPage, type IndustryPageKey } from "./industries";

/** VRT-02: an industry page's metadata. A marketing page: indexed and in the sitemap; Open Graph holds the page's own texts only. */
export function industryMetadata(key: IndustryPageKey): Metadata {
  const { copy } = industryPage(key);
  const title = `${APP_NAME} ל${copy.label}`;
  return {
    title: { absolute: `${title} | ${copy.title}` },
    description: copy.description,
    alternates: { canonical: paths.industry(key) },
    robots: { index: true, follow: true },
    openGraph: { type: "website", title, description: copy.description, url: paths.industry(key), locale: "he_IL" },
    twitter: { card: "summary_large_image", title, description: copy.description },
  };
}
