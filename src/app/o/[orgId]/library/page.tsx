import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { formatBytes, opensInBrowser } from "@/features/files/types";
import { CopyLinkButton, LibraryCategories, LibraryItemActions, NewLibraryItem } from "@/features/library/components/library-forms";
import { getLibrary, type LibraryItem } from "@/features/library/queries";
import { libraryValidity, VALIDITY_LABELS } from "@/features/library/validity";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "ספריית תוכן" };

type Props = { params: Promise<{ orgId: string }> };

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";
const day = (value: string) => formatDate(`${value}T12:00:00Z`);

function windowText(item: LibraryItem): string | null {
  if (item.validFrom && item.validUntil) return `בתוקף ${day(item.validFrom)} עד ${day(item.validUntil)}`;
  if (item.validFrom) return `בתוקף מ-${day(item.validFrom)}`;
  if (item.validUntil) return `בתוקף עד ${day(item.validUntil)}`;
  return null;
}

// LIB-01 (owner, 3 November 2026, answer (69) א: every plan): the files and links the team sends to customers, by category,
// with a validity window. Every member reads and opens them; owners, admins and managers add and change them; owners and
// admins manage the categories. Files count in the plan's storage.
export default async function LibraryPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const { categories, items } = await getLibrary(orgId);
  const today = zoneDate(new Date(), context.org.timeZone);
  const writer = context.canWrite && (context.role === "owner" || context.role === "admin" || context.role === "manager");
  const categoryAdmin = context.canWrite && (context.role === "owner" || context.role === "admin");
  // switched-off items are shown to the people who can switch them back on
  const shown = writer ? items : items.filter((item) => item.isActive);
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const known = new Set(categories.map((c) => c.id));
  const groups = [
    ...categories.map((c) => ({ key: c.id, title: c.name, rows: shown.filter((item) => item.categoryId === c.id) })),
    { key: "none", title: "בלי קטגוריה", rows: shown.filter((item) => item.categoryId === null || !known.has(item.categoryId)) },
  ].filter((group) => group.rows.length > 0);
  const counts: Record<string, number> = {};
  for (const item of items) if (item.categoryId) counts[item.categoryId] = (counts[item.categoryId] ?? 0) + 1;

  return (
    <>
      <PageHeader
        title="ספריית תוכן"
        description="קטלוגים, מחירונים, מצגות וסרטונים שהצוות שולח ללקוחות, במקום אחד."
        actions={writer ? <NewLibraryItem orgId={orgId} categories={categoryOptions} /> : undefined}
      />
      <div className="space-y-5">
        {!context.canWrite ? <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לשנות את הספרייה.</p> : null}
        {groups.length === 0 ? (
          <EmptyState
            title="הספרייה ריקה"
            description={writer ? "הוסיפו קישור או קובץ שהצוות שולח ללקוחות, למשל קטלוג או מצגת." : "בעלים, מנהלי מערכת ומנהלים מוסיפים לכאן קבצים וקישורים."}
          />
        ) : (
          groups.map((group) => {
            const titleId = `library-${group.key}`;
            return (
              <Card key={group.key} aria-labelledby={titleId}>
                <CardHeader id={titleId} title={group.title} />
                <ul className="divide-y divide-line">
                  {group.rows.map((item) => {
                    const validity = libraryValidity(item, today);
                    const windowLine = windowText(item);
                    return (
                      <li key={item.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                        <div className="min-w-0 space-y-1">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink break-words">{item.title}</span>
                            <Badge tone="neutral">{item.kind === "link" ? "קישור" : "קובץ"}</Badge>
                            {validity !== "valid" ? <Badge tone={validity === "expired" ? "danger" : "warning"}>{VALIDITY_LABELS[validity]}</Badge> : null}
                            {!item.isActive ? <Badge tone="warning">כבוי</Badge> : null}
                          </p>
                          {item.description ? <p className="text-sm text-ink-soft break-words">{item.description}</p> : null}
                          {windowLine ? <p className="text-sm text-ink-soft">{windowLine}</p> : null}
                          {item.kind === "link" && item.url ? (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <a href={item.url} target="_blank" rel="noopener noreferrer" dir="ltr" className={`${linkClass} break-all text-sm`}>
                                {item.url}
                                <span className="sr-only"> (נפתח בחלון חדש)</span>
                              </a>
                              <CopyLinkButton url={item.url} title={item.title} />
                            </div>
                          ) : null}
                          {item.kind === "file" ? (
                            item.file ? (
                              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                <span className="text-ink-soft break-all">
                                  {item.file.name} · <span dir="ltr">{formatBytes(item.file.sizeBytes)}</span>
                                </span>
                                {opensInBrowser(item.file.mimeType) ? (
                                  <a href={`/o/${orgId}/files/${item.file.id}?view=1`} target="_blank" rel="noopener" className={linkClass}>
                                    פתיחה
                                    <span className="sr-only"> (נפתח בחלון חדש)</span>
                                  </a>
                                ) : null}
                                <a href={`/o/${orgId}/files/${item.file.id}`} className={linkClass}>
                                  הורדה
                                </a>
                              </p>
                            ) : (
                              <p className="text-sm text-ink-soft">אין עדיין קובץ.</p>
                            )
                          ) : null}
                          {item.kind === "file" && item.uploadWaiting ? <p className="text-sm text-ink-soft">העלאה של קובץ חדש לא הושלמה.</p> : null}
                        </div>
                        {writer ? (
                          <LibraryItemActions
                            orgId={orgId}
                            categories={categoryOptions}
                            item={{
                              id: item.id,
                              kind: item.kind,
                              title: item.title,
                              description: item.description,
                              categoryId: item.categoryId,
                              url: item.url,
                              validFrom: item.validFrom,
                              validUntil: item.validUntil,
                              isActive: item.isActive,
                              hasFile: item.file !== null,
                            }}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })
        )}
        {categoryAdmin ? (
          <Card aria-labelledby="library-categories">
            <CardHeader id="library-categories" title="קטגוריות" />
            <CardBody>
              <LibraryCategories orgId={orgId} categories={categoryOptions} counts={counts} />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
