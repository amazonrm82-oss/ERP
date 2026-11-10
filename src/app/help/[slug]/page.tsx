import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getHelpArticle, PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import { HelpArticleView } from "@/features/help/components/help-views";
import { paths } from "@/lib/paths";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return PUBLIC_HELP_ARTICLES.map((a) => ({ slug: a.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = getHelpArticle((await params).slug);
  if (!article) return {};
  const url = paths.helpArticle(article.slug);
  return {
    title: `${article.title} | מרכז עזרה`,
    description: article.summary,
    alternates: { canonical: url },
    openGraph: { title: article.title, description: article.summary, url, type: "article", locale: "he_IL" },
  };
}

export default async function HelpArticlePage({ params }: Props) {
  const article = getHelpArticle((await params).slug);
  if (!article) notFound();
  return <HelpArticleView article={article} articles={PUBLIC_HELP_ARTICLES} base={paths.help} />;
}
