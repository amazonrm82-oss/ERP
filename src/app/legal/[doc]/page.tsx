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
  // an interim text is not reviewed yet, so search engines do not index it
  return { title: doc.title, description: doc.purpose, robots: doc.interim ? { index: false, follow: false } : undefined };
}

export default async function LegalDocumentPage({ params }: Props) {
  const doc = getLegalDocument((await params).doc);
  if (!doc) notFound();

  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-semibold leading-tight">{doc.title}</h1>
      <p className="mt-2 text-lg text-ink-soft">{doc.purpose}</p>

      {doc.interim ? (
        <div role="note" className="mt-6 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-[0.9375rem] text-warning">
          <p>
            <span className="font-semibold">נוסח זמני.</span> הנוסח ייבדק על ידי עורך דין ועשוי להשתנות. על שינוי מהותי נודיע מראש. פרטים שעוד חסרים מסומנים בצהוב.
          </p>
        </div>
      ) : null}

      <ol className="mt-8 space-y-8">
        {doc.sections.map((section, index) => (
          <li key={section.heading}>
            <h2 className="text-xl font-semibold">
              {index + 1}. {section.heading}
            </h2>
            <div className="mt-2 space-y-2 leading-relaxed">
              {section.paragraphs.map((text) =>
                text.startsWith("• ") ? (
                  <p key={text} className="ps-5 -indent-3">
                    <BlankText text={text} />
                  </p>
                ) : (
                  <p key={text}>
                    <BlankText text={text} />
                  </p>
                ),
              )}
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-10 text-sm text-ink-soft">גרסה {doc.version}</p>

      <nav aria-label="מסמכים נוספים" className="mt-6 border-t border-line pt-6">
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
