import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/format";

import { getHoldsAccess, recordHold } from "../queries";
import { HOLD_LABEL, type HoldSubject } from "../schema";
import { LiftHoldButton, SetHoldButton } from "./hold-forms";

/**
 * COL-05: the hold on this contact or company. Shown while it is held (to everyone who reads the record), or to whoever
 * may set one. Owners, admins and managers set and lift it, and whoever holds the record_payments key (answer 1 (א)).
 */
export async function CustomerHoldCard({ orgId, subject }: { orgId: string; subject: HoldSubject }) {
  const access = await getHoldsAccess(orgId);
  if (!access.inPlan) return null;
  const hold = await recordHold(orgId, subject);
  if (!hold && !access.canManage) return null;
  const titleId = `hold-${subject.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title="גבייה" action={access.canManage && !hold ? <SetHoldButton orgId={orgId} subject={subject} /> : null} />
      <CardBody>
        {hold ? (
          <div className="space-y-2">
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm break-words text-warning">
              <span className="font-semibold">{HOLD_LABEL}</span>: <bdi>{hold.reason}</bdi>
            </p>
            <p className="text-sm text-ink-soft">
              סומן ב-{formatDate(hold.createdAt)}
              {hold.by ? ` על ידי ${hold.by}` : ""}
            </p>
            {access.canManage ? <LiftHoldButton orgId={orgId} subject={subject} holdId={hold.id} /> : null}
          </div>
        ) : (
          <p className="text-sm text-ink-soft">אין סימון. אפשר לסמן לקוח עם חוב פתוח, כדי שמי שמוכר לו יראה אזהרה.</p>
        )}
      </CardBody>
    </Card>
  );
}
