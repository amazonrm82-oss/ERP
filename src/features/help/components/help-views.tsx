import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { draftLabel } from "@/features/guide/tour";

import { articleText, CATEGORY_LABELS, type HelpArticle, type HelpCategory } from "../types";
import { HelpBody } from "./help-body";
import { HelpSearch } from "./help-search";

// The help center's two views, shared by the public center (/help, UX-06) and the one inside the app (/o/[org]/help,
// UX-05): the same articles, the same layout; only the address the articles live under differs.

/** Topics with their articles, and the search box above them. */
export function HelpIndex({ articles, base }: { articles: HelpArticle[]; base: string }) {
  const entries = articles.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, text: articleText(a) }));
  const categories = Object.keys(CATEGORY_LABELS) as HelpCategory[];

  return (
    <>
      <div className="mx-auto max-w-2xl">
        <HelpSearch entries={entries} articleBase={base} />
      </div>

      <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => {
          const inTopic = articles.filter((a) => a.category === category);
          if (inTopic.length === 0) return null;
          return (
            <section key={category} aria-labelledby={`cat-${category}`}>
              <h2 id={`cat-${category}`} className="border-b border-line pb-2 text-lg font-semibold">
                {CATEGORY_LABELS[category]}
              </h2>
              <ul className="mt-2">
                {inTopic.map((a) => (
                  <li key={a.slug}>
                    <Link href={`${base}/${a.slug}`} className="block rounded-md py-2 text-accent-strong underline-offset-4 hover:underline">
                      {a.title}
                      {/* owner (203) ב: only inside the app; the public center never lists a draft (204) */}
                      {draftLabel(a.draft) ? <Badge tone="warning" className="ms-2 align-middle">{draftLabel(a.draft)}</Badge> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

/** One article, with the other articles of its topic beside it. */
export function HelpArticleView({ article, articles, base }: { article: HelpArticle; articles: HelpArticle[]; base: string }) {
  const related = articles.filter((a) => a.category === article.category && a.slug !== article.slug);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="min-w-0 max-w-3xl">
        <nav aria-label="מיקום" className="text-sm text-ink-soft">
          <Link href={base} className="underline underline-offset-4">
            מרכז עזרה
          </Link>
          <span aria-hidden="true"> / </span>
          <span>{CATEGORY_LABELS[article.category]}</span>
        </nav>
        <h1 className="mt-3 text-3xl font-semibold leading-tight">{article.title}</h1>
        {draftLabel(article.draft) ? (
          <p className="mt-2">
            <Badge tone="warning">{draftLabel(article.draft)}</Badge>
          </p>
        ) : null}
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
                <Link href={`${base}/${a.slug}`} className="block py-1.5 text-accent-strong underline-offset-4 hover:underline">
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
