import type { Metadata } from "next";
import Link from "next/link";

import { HELP_ARTICLES } from "@/features/help/articles";
import { HelpSearch } from "@/features/help/components/help-search";
import { articleText, CATEGORY_LABELS, type HelpCategory } from "@/features/help/types";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מרכז עזרה", description: `מדריכים קצרים לעבודה עם ${APP_NAME}` };

export default function HelpIndexPage() {
  const entries = HELP_ARTICLES.map((a) => ({ slug: a.slug, title: a.title, summary: a.summary, text: articleText(a) }));
  const categories = Object.keys(CATEGORY_LABELS) as HelpCategory[];

  return (
    <>
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold">מרכז עזרה</h1>
        <p className="mt-2 mb-6 text-lg text-ink-soft">מדריכים קצרים, צעד אחר צעד.</p>
      </div>
      <div className="mx-auto max-w-2xl">
        <HelpSearch entries={entries} />
      </div>

      <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => {
          const articles = HELP_ARTICLES.filter((a) => a.category === category);
          if (articles.length === 0) return null;
          return (
            <section key={category} aria-labelledby={`cat-${category}`}>
              <h2 id={`cat-${category}`} className="border-b border-line pb-2 text-lg font-semibold">
                {CATEGORY_LABELS[category]}
              </h2>
              <ul className="mt-2">
                {articles.map((a) => (
                  <li key={a.slug}>
                    <Link href={paths.helpArticle(a.slug)} className="block rounded-md py-2 text-accent-strong underline-offset-4 hover:underline">
                      {a.title}
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
