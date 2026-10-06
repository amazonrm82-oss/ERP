import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { getOrgContext } from "@/features/shell/queries";
import { RestoreButton } from "@/features/trash/components/restore-button";
import { listTrash } from "@/features/trash/queries";
import { formatDateTime } from "@/lib/format";
import type { TrashableTable } from "@/lib/record-trash";

export const metadata: Metadata = { title: "סל מחזור" };

type Props = { params: Promise<{ orgId: string }> };

const KIND_LABEL: Record<TrashableTable, string> = { leads: "ליד", contacts: "איש קשר", companies: "חברה", deals: "עסקה" };

export default async function TrashPage({ params }: Props) {
  const { orgId } = await params;
  const { canDelete } = await getOrgContext(orgId);

  if (!canDelete) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState title="אין גישה לסל המחזור" description="סל המחזור פתוח לבעלים, למנהלי מערכת ולמנהלי צוות." />
      </div>
    );
  }

  const records = await listTrash(orgId);

  return (
    <Card aria-labelledby="trash-title">
      <CardHeader id="trash-title" title={`סל מחזור (${records.length})`} />
      {records.length === 0 ? (
        <EmptyState title="סל המחזור ריק" description="רשומות שמעבירים לסל המחזור מופיעות כאן, ואפשר לשחזר אותן." />
      ) : (
        <ul className="divide-y divide-line">
          {records.map((record) => (
            <li key={`${record.table}-${record.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="break-words font-medium">{record.name}</span>
                  <Badge>{KIND_LABEL[record.table]}</Badge>
                </p>
                <p className="text-sm text-ink-soft">
                  הועבר לסל {formatDateTime(record.deletedAt)}
                  {record.ownerName ? `, בעלים: ${record.ownerName}` : ""}
                </p>
              </div>
              <RestoreButton orgId={orgId} table={record.table} id={record.id} name={record.name} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
