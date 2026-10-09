import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { TrashIcon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/feedback";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { purgeRecordAction } from "@/features/trash/actions";
import { RestoreButton } from "@/features/trash/components/restore-button";
import { listTrash } from "@/features/trash/queries";
import { formatDate, formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { TrashableTable } from "@/lib/record-trash";

export const metadata: Metadata = { title: "סל מחזור" };

type Props = { params: Promise<{ orgId: string }> };

const KIND_LABEL: Record<TrashableTable, string> = { leads: "ליד", contacts: "איש קשר", companies: "חברה", deals: "עסקה" };

// the nightly job (app.purge_trash) deletes what has been in the bin for 30 days
const purgeDate = (deletedAt: string) => new Date(new Date(deletedAt).getTime() + 30 * 24 * 3600 * 1000).toISOString();

export default async function TrashPage({ params }: Props) {
  const { orgId } = await params;
  const { canDelete, canWrite, role } = await getOrgContext(orgId);
  // permanent deletion: admins only (the delete policy says the same)
  const canPurge = isAdminRole(role) && canWrite;

  if (!canDelete) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState kind="locked" title="אין גישה לסל המחזור" description="סל המחזור פתוח לבעלים, למנהלי מערכת ולמנהלי צוות." />
      </div>
    );
  }

  const records = await listTrash(orgId);

  return (
    <Card aria-labelledby="trash-title">
      <CardHeader id="trash-title" title={`סל מחזור (${records.length})`} />
      {records.length === 0 ? (
        <EmptyState icon={<TrashIcon />} title="סל המחזור ריק" description="רשומות שמעבירים לסל המחזור מופיעות כאן, ואפשר לשחזר אותן." />
      ) : (
        <>
          <p className="border-b border-line px-4 py-2.5 text-sm text-ink-soft sm:px-5">
            רשומה נמחקת לצמיתות 30 יום אחרי שהועברה לסל.
            {canPurge ? (
              <>
                {" "}
                אדם ביקש למחוק את הפרטים שלו? אחרי מחיקה לצמיתות, מוחקים אותם גם{" "}
                <Link href={`${paths.settingsAudit(orgId)}?tab=privacy`} className="text-accent-strong underline">
                  מיומן הביקורת
                </Link>
                .
              </>
            ) : null}
          </p>
          <ul className="divide-y divide-line">
            {records.map((record) => (
              <li key={`${record.table}-${record.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium">{record.name}</span>
                    <Badge>{KIND_LABEL[record.table]}</Badge>
                  </p>
                  <p className="text-sm text-ink-soft">
                    {`הועבר לסל ${formatDateTime(record.deletedAt)} · יימחק ב-${formatDate(purgeDate(record.deletedAt))}`}
                    {record.ownerName ? `, אחראי: ${record.ownerName}` : ""}
                  </p>
                </div>
                <span className="flex flex-wrap items-start gap-2">
                  {canPurge ? (
                    <ActionButton
                      action={purgeRecordAction.bind(null, orgId, record.table, record.id)}
                      pendingText="מוחקים…"
                      variant="danger-ghost"
                      srLabel={record.name}
                      confirm="למחוק לצמיתות? אי אפשר לשחזר. הערות ומשימות שקשורות רק לרשומה הזו יימחקו איתה."
                    >
                      מחיקה לצמיתות
                    </ActionButton>
                  ) : null}
                  <RestoreButton orgId={orgId} table={record.table} id={record.id} name={record.name} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
