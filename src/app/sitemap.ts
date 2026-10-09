import type { MetadataRoute } from "next";

import { HELP_ARTICLES } from "@/features/help/articles";
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
    { url: url(paths.help), changeFrequency: "monthly" },
    ...HELP_ARTICLES.map((article) => ({ url: url(paths.helpArticle(article.slug)), changeFrequency: "monthly" as const })),
    ...LEGAL_DOCUMENTS.filter((doc) => !doc.interim).map((doc) => ({ url: url(paths.legal(doc.slug)), changeFrequency: "yearly" as const })),
  ];
}
