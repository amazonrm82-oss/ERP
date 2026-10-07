import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getHelpArticle, HELP_ARTICLES } from "@/features/help/articles";
import { HelpBody } from "@/features/help/components/help-body";
import { CATEGORY_LABELS } from "@/features/help/types";
import { paths } from "@/lib/paths";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return HELP_ARTICLES.map((a) => ({ slug: a.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = getHelpArticle((await params).slug);
  return article ? { title: `${article.title} | מרכז עזרה`, description: article.summary } : {};
}

export default async function HelpArticlePage({ params }: Props) {
  const article = getHelpArticle((await params).slug);
  if (!article) notFound();
  const related = HELP_ARTICLES.filter((a) => a.category === article.category && a.slug !== article.slug);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="min-w-0 max-w-3xl">
        <nav aria-label="מיקום" className="text-sm text-ink-soft">
          <Link href={paths.help} className="underline underline-offset-4">
            מרכז עזרה
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{CATEGORY_LABELS[article.category]}</span>
        </nav>
        <h1 className="mt-3 text-3xl font-semibold leading-tight">{article.title}</h1>
        <p className="mt-2 text-lg text-ink-soft">{article.summary}</p>
        <HelpBody blocks={article.body} />
      </article>

      {related.length ? (
        <aside aria-labelledby="related" className="lg:pt-10">
          <h2 id="related" className="text-sm font-semibold text-ink-soft">
            עוד ב{CATEGORY_LABELS[article.category]}
          </h2>
          <ul className="mt-2">
            {related.map((a) => (
              <li key={a.slug}>
                <Link href={paths.helpArticle(a.slug)} className="block py-1.5 text-accent-strong underline-offset-4 hover:underline">
                  {a.title}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </div>
  );
}
