// TRU-04: the guide search of the help center inside the business. Builds the searchable list on the server, from the
// articles (docs/help/articles/) and the "?" texts of the main screens in the business's own words (FLD-10), and runs the
// pure search over it (src/features/help/guide-search.ts). Only the results go to the page; the corpus stays here.

import "server-only";

import { HELP_ARTICLES } from "@/features/help/articles";
import { HELP_SCREENS } from "@/features/help/content";
import { searchGuides, type GuideDoc, type GuideResult } from "@/features/help/guide-search";
import { articleText, type HelpArticle } from "@/features/help/types";
import type { OrgModules } from "@/features/modules/modules";
import type { OrgTerms } from "@/features/terminology/terms";

import { screenHelp } from "./guide";

/** Every guide a person inside the business may search: all articles (drafts too, marked), then the screen texts. */
export function guideDocs(terms: OrgTerms, modules: Pick<OrgModules, "leads">, articles: HelpArticle[] = HELP_ARTICLES): GuideDoc[] {
  const docs: GuideDoc[] = articles.map((a) => ({
    key: `article:${a.slug}`,
    kind: "article",
    slug: a.slug,
    title: a.title,
    // articleText starts with the title; the title is matched on its own, so the text holds the rest
    text: articleText({ ...a, title: "" }).trim(),
    draft: a.draft === true,
  }));
  const slugs = new Set(articles.map((a) => a.slug));
  for (const screen of HELP_SCREENS) {
    // a screen the business switched off (LEAD-08) is not offered, as in the tour
    if (screen === "leads" && !modules.leads) continue;
    const help = screenHelp(screen, terms);
    if (!slugs.has(help.article)) continue;
    docs.push({ key: `screen:${screen}`, kind: "screen", slug: help.article, title: help.title, text: help.lines.join(" "), draft: help.draft });
  }
  return docs;
}

/** The results for `query` in this business's words. */
export function searchOrgGuides(query: string, terms: OrgTerms, modules: Pick<OrgModules, "leads">): GuideResult[] {
  return searchGuides(guideDocs(terms, modules), query);
}
