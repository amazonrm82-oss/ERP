import { ActionButton } from "@/components/action-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

import { setRequireMfaAction } from "../actions";

/** Business details, for admins: require two-step verification from everyone. */
export function OrgSecurityCard({ orgId, requireMfa }: { orgId: string; requireMfa: boolean }) {
  return (
    <Card aria-labelledby="org-security-title" className="mt-5">
      <CardHeader id="org-security-title" title="אבטחה" />
      <CardBody className="space-y-3">
        <p className="text-md">
          {requireMfa
            ? "כל המשתמשים בעסק חייבים אימות דו-שלבי. מי שלא הפעיל אותו יתבקש להפעיל לפני שייכנס."
            : "אפשר לחייב את כל המשתמשים בעסק להיכנס עם אימות דו-שלבי (קוד מאפליקציה בטלפון, בנוסף לסיסמה)."}
        </p>
        {requireMfa ? (
          <ActionButton action={setRequireMfaAction.bind(null, orgId, false)} pendingText="שומר…" variant="secondary" confirm="לבטל את החובה?">
            ביטול החובה
          </ActionButton>
        ) : (
          <ActionButton action={setRequireMfaAction.bind(null, orgId, true)} pendingText="שומר…" confirm="לחייב את כל המשתמשים באימות דו-שלבי?">
            חיוב אימות דו-שלבי לכולם
          </ActionButton>
        )}
      </CardBody>
    </Card>
  );
}
