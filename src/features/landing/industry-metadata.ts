import type { Metadata } from "next";

import { publicPageMetadata } from "@/features/seo/page-metadata";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

import { industryPage, type IndustryPageKey } from "./industries";

/** VRT-02: an industry page's metadata. A marketing page: indexed and in the sitemap; Open Graph holds the page's own texts only. */
export function industryMetadata(key: IndustryPageKey): Metadata {
  const { copy } = industryPage(key);
  const title = `${APP_NAME} ל${copy.label}`;
  // WEB-03: the shared shape (canonical, share image, Twitter)
  return publicPageMetadata({
    title: `${title} | ${copy.title}`,
    absoluteTitle: true,
    shareTitle: title,
    description: copy.description,
    path: paths.industry(key),
    index: true,
  });
}
