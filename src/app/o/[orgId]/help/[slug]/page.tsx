import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getHelpArticle, HELP_ARTICLES } from "@/features/help/articles";
import { HelpArticleView } from "@/features/help/components/help-views";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

type Props = { params: Promise<{ orgId: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = getHelpArticle((await params).slug, { drafts: true });
  return article ? { title: `${article.title} | מרכז עזרה` } : {};
}

// UX-05 (ג): one help article inside the business (the public /help shows the same text).
export default async function OrgHelpArticlePage({ params }: Props) {
  const { orgId, slug } = await params;
  await getOrgContext(orgId);
  const article = getHelpArticle(slug, { drafts: true });
  if (!article) notFound();
  return <HelpArticleView article={article} articles={HELP_ARTICLES} base={paths.orgHelp(orgId)} />;
}
