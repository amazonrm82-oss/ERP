import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { addSuggestedReasonsAction } from "@/features/disqualify-reasons/actions";
import { AddReasonForm, ReasonList } from "@/features/disqualify-reasons/components/reasons-editor";
import { listDisqualifyReasons } from "@/features/disqualify-reasons/queries";
import { REASONS_PER_ORG, SUGGESTED_REASONS } from "@/features/disqualify-reasons/schema";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סיבות לליד לא רלוונטי" };

type Props = { params: Promise<{ orgId: string }> };

/** LEAD-03: the list a person picks from when a lead is not relevant. Owners and admins edit it. */
export default async function DisqualifyReasonsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const reasons = await listDisqualifyReasons(orgId);

  return (
    <Card aria-labelledby="reasons-title">
      <CardHeader id="reasons-title" title="סיבות לליד לא רלוונטי" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>כשמעבירים ליד לסטטוס &quot;לא רלוונטי&quot;, בוחרים סיבה מהרשימה הזו. כך אפשר לראות אחר כך למה לידים לא נסגרו.</p>
        <p>שינוי שם, הסתרה או מחיקה של סיבה לא משנים לידים שכבר סומנו בה.</p>
      </CardBody>
      {reasons.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <ReasonList orgId={orgId} reasons={reasons} editable={editable} />
        </div>
      ) : (
        <CardBody className="mt-3 space-y-3 border-t border-line">
          <p className="text-md text-ink-soft">
            עוד אין סיבות ברשימה. עד שתוסיפו, כותבים את הסיבה בחופשיות.
          </p>
          {editable ? (
            <div className="space-y-2">
              <p className="text-sm text-ink-soft">אפשר להתחיל מהסיבות המוצעות: {SUGGESTED_REASONS.join(", ")}.</p>
              <ActionButton action={addSuggestedReasonsAction.bind(null, orgId)} pendingText="מוסיפים…">
                הוספת הסיבות המוצעות
              </ActionButton>
            </div>
          ) : null}
        </CardBody>
      )}
      {editable && reasons.length < REASONS_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddReasonForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
