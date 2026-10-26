import type { Metadata } from "next";
import Link from "next/link";

import { BlankText } from "@/features/legal/components/blank-text";
import { getLegalDocument, LEGAL_DOCUMENTS, type LegalSection } from "@/features/legal/documents";
import { readPublicSubprocessors } from "@/features/legal/subprocessors-public-server";
import { splitPublicList, type Subprocessor } from "@/features/platform/subprocessors";
import { formatDate, zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

const doc = getLegalDocument("subprocessors")!;

export const metadata: Metadata = {
  title: doc.title,
  description: doc.purpose,
  robots: doc.interim ? { index: false, follow: false } : { index: true, follow: true },
};

function Paragraph({ text }: { text: string }) {
  return (
    <p className={text.startsWith("• ") ? "ps-5 -indent-3" : undefined}>
      <BlankText text={text} />
    </p>
  );
}

function Entry({ entry, upcoming }: { entry: Subprocessor; upcoming: boolean }) {
  return (
    <li>
      <h3 className="text-xl font-semibold break-words">{entry.name}</h3>
      <div className="mt-2 space-y-2 leading-relaxed">
        {upcoming ? <p className="font-medium">ייכנס לרשימה ב-{formatDate(entry.effectiveFrom)}</p> : null}
        <p className="break-words">תפקיד: {entry.purpose}</p>
        <p className="break-words">מידע: {entry.dataCategories}</p>
        <p className="break-words">מיקום: {entry.location ?? "לא צוין"}</p>
        {entry.website ? (
          <p>
            אתר:{" "}
            <a href={entry.website} dir="ltr" className="text-accent-strong underline underline-offset-4 break-all">
              {entry.website}
            </a>
          </p>
        ) : null}
        {entry.endsOn ? <p>ייצא מהרשימה ב-{formatDate(entry.endsOn)}</p> : null}
      </div>
    </li>
  );
}

// ADM-01: the subprocessors page reads the platform's live list (managed in /admin/subprocessors) for every visitor,
// through the cached service read (owner, 26 October 2026). The page is not part of a signed text (AGREEMENT_SLUGS), so a
// change of the list opens no LEGAL_VERSION. Rendered per request (the day decides what is upcoming); the data is cached.
export const dynamic = "force-dynamic";
export default async function SubprocessorsPage() {
  const live = await readPublicSubprocessors();
  const today = zoneDate(new Date());
  const groups = live ? splitPublicList(live.entries, today) : null;
  const staticSections: LegalSection[] = doc.sections;

  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="text-3xl font-semibold leading-tight">{doc.title}</h1>
      <p className="mt-2 text-lg text-ink-soft">{doc.purpose}</p>

      {doc.interim ? (
        <div role="note" className="mt-6 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-md text-warning">
          <p>
            <span className="font-semibold">נוסח זמני.</span> הנוסח ייבדק על ידי עורך דין ועשוי להשתנות. על שינוי מהותי נודיע מראש. פרטים שעוד חסרים מסומנים בצהוב.
          </p>
        </div>
      ) : null}

      {groups ? (
        <>
          <section aria-labelledby="sub-current" className="mt-8">
            <h2 id="sub-current" className="text-2xl font-semibold">
              הספקים היום
            </h2>
            {groups.current.length === 0 ? (
              <p className="mt-2 text-ink-soft">אין ספקים ברשימה.</p>
            ) : (
              <ul className="mt-4 space-y-8">
                {groups.current.map((entry, index) => (
                  <Entry key={`${index}-${entry.name}-${entry.effectiveFrom}`} entry={entry} upcoming={false} />
                ))}
              </ul>
            )}
          </section>
          {groups.upcoming.length > 0 ? (
            <section aria-labelledby="sub-upcoming" className="mt-10">
              <h2 id="sub-upcoming" className="text-2xl font-semibold">
                ספקים שיתווספו
              </h2>
              <ul className="mt-4 space-y-8">
                {groups.upcoming.map((entry, index) => (
                  <Entry key={`${index}-${entry.name}-${entry.effectiveFrom}`} entry={entry} upcoming />
                ))}
              </ul>
            </section>
          ) : null}
          {live?.updatedOn ? <p className="mt-10 text-sm text-ink-soft">עדכון אחרון: {formatDate(live.updatedOn)}</p> : null}
        </>
      ) : (
        <>
          <ol className="mt-8 space-y-8">
            {staticSections.map((section, index) => (
              <li key={`${index}-${section.heading}`}>
                <h2 className="text-xl font-semibold">
                  {index + 1}. {section.heading}
                </h2>
                <div className="mt-2 space-y-2 leading-relaxed">
                  {section.paragraphs.map((text) => (
                    <Paragraph key={text} text={text} />
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-8 rounded-lg border border-line bg-surface px-4 py-3 text-md">
            זו הרשימה של גרסה {doc.version}. לא הצלחנו לטעון כרגע את הרשימה המעודכנת. נסו לרענן את הדף בעוד כמה דקות.
          </p>
        </>
      )}

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
