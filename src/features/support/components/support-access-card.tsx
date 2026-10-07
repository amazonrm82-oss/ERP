import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";

import { grantSupportAccessAction, revokeSupportAccessAction } from "../actions";

type Props = { orgId: string; grant: { expiresAt: string } | null };

/** Business details: let platform support look at the account, read-only, for a limited time. */
export function SupportAccessCard({ orgId, grant }: Props) {
  return (
    <Card aria-labelledby="support-access-title" className="mt-5">
      <CardHeader id="support-access-title" title="גישת תמיכה" />
      <CardBody className="space-y-3">
        <p className="text-[0.9375rem]">
          כשפונים לתמיכה, אפשר לאפשר לצוות התמיכה לראות את הנתונים שלכם כדי לעזור. הגישה היא לצפייה בלבד, מוגבלת בזמן, וכל כניסה נרשמת ביומן הביקורת.
          בלי אישור כאן, צוות התמיכה לא רואה את הנתונים של העסק.
        </p>
        {grant ? (
          <>
            <p role="status" className="font-medium">
              גישת תמיכה פתוחה עד {formatDateTime(grant.expiresAt)}.
            </p>
            <ActionButton action={revokeSupportAccessAction.bind(null, orgId)} pendingText="סוגר…" variant="danger-ghost">
              סגירת הגישה עכשיו
            </ActionButton>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <ActionButton action={grantSupportAccessAction.bind(null, orgId, 1)} pendingText="פותח…">
              לשעה
            </ActionButton>
            <ActionButton action={grantSupportAccessAction.bind(null, orgId, 24)} pendingText="פותח…">
              ליום
            </ActionButton>
            <ActionButton action={grantSupportAccessAction.bind(null, orgId, 72)} pendingText="פותח…">
              לשלושה ימים
            </ActionButton>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
