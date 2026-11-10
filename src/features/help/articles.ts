// Help center articles (UX-05, UX-06). The texts are Markdown in docs/help/articles/, one file per topic, compiled into
// content.generated.ts by scripts/build-help-content.mjs; the public center (/help) and the one inside the app
// (/o/[org]/help) read the same list. Labels in **bold** must match the screens word for word: when a button or screen
// is renamed, search docs/help/ too.

import { HELP_CONTENT } from "./content.generated";
import type { HelpArticle } from "./types";

/** Every article, by topic and order: the help center inside the app. */
export const HELP_ARTICLES: HelpArticle[] = HELP_CONTENT.articles;

/** The public center (/help, sitemap): a draft placeholder is never published. */
export const PUBLIC_HELP_ARTICLES: HelpArticle[] = HELP_ARTICLES.filter((a) => !a.draft);

export function getHelpArticle(slug: string, { drafts = false }: { drafts?: boolean } = {}) {
  return (drafts ? HELP_ARTICLES : PUBLIC_HELP_ARTICLES).find((a) => a.slug === slug) ?? null;
}
