import { Card } from "@/components/ui/card";

import { nameIds } from "../names";
import { listRecordHistory } from "../queries";
import { AuditEntries, idsInChanges } from "./audit-entries";

type Props = { orgId: string; entityType: "leads" | "contacts" | "companies" | "deals"; entityId: string };

/** Field-by-field change history of one record. Admins only: for others the database returns nothing. */
export async function RecordHistory({ orgId, entityType, entityId }: Props) {
  const items = await listRecordHistory(orgId, entityType, entityId);
  if (items.length === 0) return null;
  const names = await nameIds(orgId, idsInChanges(items));
  return (
    <Card className="mt-5">
      <details>
        <summary className="flex min-h-14 cursor-pointer items-center px-4 font-semibold sm:px-5">היסטוריית שינויים ({items.length})</summary>
        <div className="border-t border-line">
          <AuditEntries items={items} names={names} showEntity={false} />
        </div>
      </details>
    </Card>
  );
}
