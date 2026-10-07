import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BlankText } from "@/features/legal/components/blank-text";
import { getLegalDocument, LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { paths } from "@/lib/paths";

type Props = { params: Promise<{ doc: string }> };

export function generateStaticParams() {
  return LEGAL_DOCUMENTS.map((doc) => ({ doc: doc.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = getLegalDocument((await params).doc);
  if (!doc) return {};
  // a draft is not the binding text, so search engines do not index it
  return { title: doc.title, description: doc.purpose, robots: doc.draft ? { index: false, follow: false } : undefined };
}

export default async function LegalDocumentPage({ params }: Props) {
  const doc = getLegalDocument((await params).doc);
  if (!doc) notFound();

  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-semibold leading-tight">{doc.title}</h1>
      <p className="mt-2 text-lg text-ink-soft">{doc.purpose}</p>

      {doc.draft ? (
        <div role="note" className="mt-6 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-warning">
          <p className="font-semibold">טיוטה. המסמך עוד לא בתוקף.</p>
          <p className="mt-1 text-[0.9375rem]">
            הנוסח המשפטי ייכתב עם עורך דין. בינתיים מופיעים כאן הפרקים שהמסמך יכלול והעובדות על המערכת, כדי שיהיה ממה לכתוב. פרטים שחסרים מסומנים בצהוב.
          </p>
        </div>
      ) : null}

      <ol className="mt-8 space-y-8">
        {doc.sections.map((section, index) => (
          <li key={section.heading}>
            <h2 className="text-xl font-semibold">
              {index + 1}. {section.heading}
            </h2>
            {doc.draft ? (
              <>
                <h3 className="mt-3 text-sm font-semibold text-ink-soft">מה הפרק יכלול</h3>
                <ul className="mt-1 list-disc space-y-1 ps-5">
                  {section.covers.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                {section.facts?.length ? (
                  <>
                    <h3 className="mt-3 text-sm font-semibold text-ink-soft">מה נכון היום במערכת</h3>
                    <ul className="mt-1 list-disc space-y-1 ps-5">
                      {section.facts.map((fact) => (
                        <li key={fact}>
                          <BlankText text={fact} />
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ol>

      <nav aria-label="מסמכים נוספים" className="mt-12 border-t border-line pt-6">
        <h2 className="text-sm font-semibold text-ink-soft">מסמכים נוספים</h2>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {LEGAL_DOCUMENTS.filter((d) => d.slug !== doc.slug).map((d) => (
            <li key={d.slug}>
              <Link href={paths.legal(d.slug)} className="text-accent-strong underline underline-offset-4">
                {d.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </article>
  );
}
