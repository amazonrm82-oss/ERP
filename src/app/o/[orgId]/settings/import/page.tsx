import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { UploadIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/feedback";
import { importEntityLabel } from "@/features/imports/fields";
import { getOrgTerms } from "@/features/terminology/queries";
import { UndoImportButton } from "@/features/imports/components/undo-import-button";
import { listImportJobs } from "@/features/imports/queries";
import { canEditCatalog, canImportWith } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { getOrgContextForOwner } from "@/features/shell/queries";
import { formatDateTime, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "ייבוא וייצוא" };

const STATUS_LABEL: Record<string, string> = { running: "רץ", done: "הסתיים", failed: "נעצר או נקטע", undone: "בוטל" };
const UNDO_MS = 7 * 86_400_000;

/** Mirrors undoImportAction: the importer, a finished job that created records, within 7 days. */
function canUndo(job: { created_by: string | null; status: string; created_count: number; created_at: string }, userId: string): boolean {
  return job.created_by === userId && (job.status === "done" || job.status === "failed") && job.created_count > 0 && Date.now() - Date.parse(job.created_at) < UNDO_MS;
}

/**
 * PRM-01: undoing a products import removes products, which needs the catalog rules. A member
 * undoes a records import through undo_own_import() (owner, 15 October 2026): only unchanged records.
 */
function mayRemove(entity: string, catalog: boolean): boolean {
  return entity !== "product" || catalog;
}

export default async function ImportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  // the owner opens the full export in every state: read-only, and closed until payment (BIL-09)
  const { role, canWrite, user } = await getOrgContextForOwner(orgId);
  const granted = await getMyPermissions(orgId);
  const canImport = canWrite && canImportWith(role, granted);
  const catalog = canEditCatalog(role, granted);
  if (!canImport && role !== "owner") {
    notFound();
  }
  const [jobs, terms] = await Promise.all([
    canImport ? listImportJobs(orgId) : Promise.resolve([]),
    // FLD-10: the business's words for leads, contacts and deals
    getOrgTerms(orgId),
  ]);
  const objects = `${terms.lead.plural}, ${terms.contact.plural}, חברות, ${terms.deal.plural}`;

  return (
    <div className="space-y-5">
      {canImport ? (
        <Card aria-labelledby="import-title">
          <CardHeader id="import-title" title="ייבוא מ-Excel או CSV" action={<ButtonLink href={paths.importNew(orgId)} size="sm">ייבוא קובץ</ButtonLink>} />
          {jobs.length === 0 ? (
            <EmptyState icon={<UploadIcon />} title="עוד לא ייבאתם קבצים" description={`${objects}, משימות או מוצרים מקובץ Excel או CSV. אפשר לבטל ייבוא בשבעת הימים הראשונים.`} />
          ) : (
            <ul className="divide-y divide-line">
              {jobs.map((job) => {
                const undoable = canUndo(job, user.id) && mayRemove(job.entity_type, catalog);
                return (
                  <li key={job.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
                    <div className="min-w-0">
                      <p className="font-medium break-words">
                        {job.file_name} <span className="font-normal text-ink-soft">· {importEntityLabel(job.entity_type, terms)}</span>
                      </p>
                      <p className="mt-0.5 text-sm text-ink-soft">
                        {formatDateTime(job.created_at)}
                        {job.createdByName ? `, ${job.createdByName}` : ""} · {STATUS_LABEL[job.status] ?? job.status}
                      </p>
                      <p className="mt-0.5 text-sm">
                        נוצרו {formatNumber(job.created_count)}, עודכנו {formatNumber(job.updated_count)}, דולגו {formatNumber(job.skipped_count)}, נכשלו {formatNumber(job.failed_count)} מתוך {formatNumber(job.total_rows)}
                      </p>
                    </div>
                    {undoable ? (
                      <UndoImportButton
                        orgId={orgId}
                        jobId={job.id}
                        fileName={job.file_name}
                        question={
                          job.entity_type === "product"
                            ? `למחוק את ${formatNumber(job.created_count)} המוצרים שנוצרו? מוצר שכבר מופיע במסמך יעבור לארכיון במקום להימחק.`
                            : job.entity_type === "task"
                              ? `להסיר את ${formatNumber(job.created_count)} המשימות שנוצרו?`
                              : role === "member"
                                ? `להעביר לסל המחזור את הרשומות שנוצרו בייבוא? רשומות ששונו מאז יישארו.`
                                : `להעביר את ${formatNumber(job.created_count)} הרשומות שנוצרו לסל המחזור?`
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : null}

      <Card aria-labelledby="export-title">
        <CardHeader id="export-title" title="ייצוא מלא" />
        <CardBody className="space-y-3">
          <p className="text-md">
            קובץ ZIP עם כל הנתונים של העסק: {objects}, משימות, ציר הזמן, תהליכי מכירה, תגיות ושדות מותאמים. כל טבלה בקובץ CSV שנפתח ב-Excel.
          </p>
          {role === "owner" ? (
            <a href={paths.fullExport(orgId)} className={buttonClasses("secondary", "md")} download>
              הורדת ייצוא מלא
            </a>
          ) : (
            <p className="text-sm text-ink-soft">ייצוא מלא זמין לבעלים של העסק בלבד. ייצוא של דוח בודד נמצא במסך הדוחות.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
