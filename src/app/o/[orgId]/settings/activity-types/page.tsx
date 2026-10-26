import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { CheckSquareIcon } from "@/components/ui/icons";
import { ActivityTypeList, AddActivityTypeForm } from "@/features/activity-types/components/types-editor";
import { listActivityTypes } from "@/features/activity-types/queries";
import { ACTIVITY_TYPES_PER_ORG } from "@/features/activity-types/types";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "סוגי פעילות ומשימה" };

type Props = { params: Promise<{ orgId: string }> };

/** TASK-08: one list of activity and task types. Owners and admins edit it; everyone picks from it. */
export default async function ActivityTypesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const types = await listActivityTypes(orgId);

  return (
    <Card aria-labelledby="activity-types-title">
      <CardHeader id="activity-types-title" title="סוגי פעילות ומשימה" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>
          מהרשימה הזו בוחרים סוג כשמתעדים פעילות ברשומה וכשמוסיפים משימה. כל סוג שייך לאחד משישה סוגים בסיסיים (הערה, שיחה,
          פגישה, WhatsApp, אימייל, SMS), והדוחות ו&quot;קשר אחרון&quot; סופרים לפי הסוג הבסיסי. אפשר לשמור עד {ACTIVITY_TYPES_PER_ORG} סוגים.
        </p>
        <p>
          &quot;משימה&quot; ו&quot;מעקב&quot; תמיד מופיעים במשימות, לצד הרשימה. שינוי שם מתעדכן בכל מקום. סוג מוסתר נשאר במה שכבר סומן בו.
          סוג בסיסי שאין לו סוג פעיל ברשימה מוצע בשמו הקבוע.
        </p>
      </CardBody>
      {types.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <ActivityTypeList orgId={orgId} types={types} editable={editable} />
        </div>
      ) : (
        <EmptyState
          compact
          icon={<CheckSquareIcon />}
          title="עוד אין סוגי פעילות"
          description={editable ? "כל עוד הרשימה ריקה, מתעדים בששת הסוגים הבסיסיים. מוסיפים סוג ראשון בטופס שלמטה." : "כל עוד הרשימה ריקה, מתעדים בששת הסוגים הבסיסיים."}
          className="mt-3 border-t border-line"
        />
      )}
      {editable && types.length < ACTIVITY_TYPES_PER_ORG ? (
        <CardBody className="border-t border-line">
          <AddActivityTypeForm orgId={orgId} />
        </CardBody>
      ) : null}
    </Card>
  );
}
