import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { UploadIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/feedback";
import { undoImportAction } from "@/features/imports/actions";
import { IMPORT_ENTITIES } from "@/features/imports/fields";
import { listImportJobs } from "@/features/imports/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "ייבוא וייצוא" };

const STATUS_LABEL: Record<string, string> = { running: "רץ", done: "הסתיים", failed: "נעצר או נקטע", undone: "בוטל" };
const UNDO_MS = 7 * 86_400_000;

/** Mirrors undoImportAction: the importer, a finished job that created records, within 7 days. */
function canUndo(job: { created_by: string | null; status: string; created_count: number; created_at: string }, userId: string): boolean {
  return job.created_by === userId && (job.status === "done" || job.status === "failed") && job.created_count > 0 && Date.now() - Date.parse(job.created_at) < UNDO_MS;
}

export default async function ImportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role, canWrite, user } = await getOrgContext(orgId);
  if (!canWrite || !(isAdminRole(role) || role === "manager")) {
    notFound();
  }
  const jobs = await listImportJobs(orgId);

  return (
    <div className="space-y-5">
      <Card aria-labelledby="import-title">
        <CardHeader id="import-title" title="ייבוא מ-Excel או CSV" action={<ButtonLink href={paths.importNew(orgId)} size="sm">ייבוא קובץ</ButtonLink>} />
        {jobs.length === 0 ? (
          <EmptyState icon={<UploadIcon />} title="עוד לא ייבאתם קבצים" description="לידים, אנשי קשר או חברות מקובץ Excel או CSV. אפשר לבטל ייבוא בשבעת הימים הראשונים." />
        ) : (
          <ul className="divide-y divide-line">
            {jobs.map((job) => {
              const undoable = canUndo(job, user.id);
              return (
                <li key={job.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
                  <div className="min-w-0">
                    <p className="font-medium break-words">
                      {job.file_name} <span className="font-normal text-ink-soft">· {IMPORT_ENTITIES.find((e) => e.value === job.entity_type)?.label}</span>
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
                    <ActionButton
                      action={undoImportAction.bind(null, orgId, job.id)}
                      pendingText="מבטלים…"
                      variant="danger-ghost"
                      confirm={`להעביר את ${formatNumber(job.created_count)} הרשומות שנוצרו לסל המחזור?`}
                      srLabel={job.file_name}
                    >
                      ביטול הייבוא
                    </ActionButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="export-title">
        <CardHeader id="export-title" title="ייצוא מלא" />
        <CardBody className="space-y-3">
          <p className="text-md">
            קובץ ZIP עם כל הנתונים של העסק: לידים, אנשי קשר, חברות, עסקאות, משימות, ציר הזמן, פייפליינים, תגיות ושדות מותאמים. כל טבלה בקובץ CSV שנפתח ב-Excel.
          </p>
          {role === "owner" ? (
            <a href={`${paths.imports(orgId)}/export`} className={buttonClasses("secondary", "md")} download>
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
