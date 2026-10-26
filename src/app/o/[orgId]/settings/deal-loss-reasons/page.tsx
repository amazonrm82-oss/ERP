import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { BoardIcon } from "@/components/ui/icons";
import { AddLossReasonForm, LossReasonList } from "@/features/deal-loss-reasons/components/reasons-editor";
import { listLossReasons } from "@/features/deal-loss-reasons/queries";
import { LOSS_REASONS_PER_ORG } from "@/features/deal-loss-reasons/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סיבות הפסד" };

type Props = { params: Promise<{ orgId: string }> };

/** DEAL-03: the list a person picks from when a deal is lost. Owners and admins edit it. */
export default async function DealLossReasonsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const reasons = await listLossReasons(orgId);

  return (
    <Card aria-labelledby="loss-reasons-title">
      <CardHeader id="loss-reasons-title" title="סיבות הפסד" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>כשעסקה עוברת לשלב אבוד, בוחרים סיבה מהרשימה הזו, ואפשר לרשום גם מתחרה. כך הדוח &quot;סיבות הפסד&quot; מראה למה עסקאות לא נסגרו.</p>
        <p>שינוי שם של סיבה מתעדכן גם בדוח. הסתרה או מחיקה לא משנות עסקאות שכבר סומנו בה.</p>
      </CardBody>
      {reasons.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <LossReasonList orgId={orgId} reasons={reasons} editable={editable} />
        </div>
      ) : (
        <EmptyState
          compact
          icon={<BoardIcon />}
          title="עוד אין סיבות הפסד"
          description={editable ? "כל עוד הרשימה ריקה, אפשר לסמן עסקה כאבודה בלי סיבה. מוסיפים סיבה ראשונה בטופס שלמטה." : "כל עוד הרשימה ריקה, אפשר לסמן עסקה כאבודה בלי סיבה."}
          className="mt-3 border-t border-line"
        />
      )}
      {editable && reasons.length < LOSS_REASONS_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddLossReasonForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
