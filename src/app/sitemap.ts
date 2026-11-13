import type { MetadataRoute } from "next";

import { PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import { INDUSTRY_PAGE_KEYS } from "@/features/landing/industries";
import { LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { paths } from "@/lib/paths";
import { configuredSiteUrl } from "@/lib/site-origin";

// The public pages search engines may list (LND-11). Without a known address there is nothing to list.
export default function sitemap(): MetadataRoute.Sitemap {
  const site = configuredSiteUrl();
  if (!site) return [];
  const url = (path: string) => new URL(path, site).toString();
  return [
    { url: url(paths.landing), changeFrequency: "weekly", priority: 1 },
    { url: url(paths.features), changeFrequency: "monthly" },
    // VRT-02: the industry pages
    ...INDUSTRY_PAGE_KEYS.map((key) => ({ url: url(paths.industry(key)), changeFrequency: "monthly" as const })),
    { url: url(paths.help), changeFrequency: "monthly" },
    { url: url(paths.roadmap), changeFrequency: "monthly" },
    ...PUBLIC_HELP_ARTICLES.map((article) => ({ url: url(paths.helpArticle(article.slug)), changeFrequency: "monthly" as const })),
    ...LEGAL_DOCUMENTS.filter((doc) => !doc.interim).map((doc) => ({ url: url(paths.legal(doc.slug)), changeFrequency: "yearly" as const })),
  ];
}
