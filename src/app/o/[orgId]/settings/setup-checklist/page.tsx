import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { isAdminRole } from "@/features/settings/permissions";
import { ChecklistVisibilityButton } from "@/features/setup/components/checklist-visibility-button";
import { sampleCounts } from "@/features/setup/checklist";
import { SampleDataControls } from "@/features/setup/components/sample-data-controls";
import { SetupChecklist } from "@/features/setup/components/setup-checklist";
import { getSetupChecklist } from "@/features/setup/queries";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "רשימת הקמה" };

type Props = { params: Promise<{ orgId: string }> };

// USR-04: the setup checklist, always here even after it was closed on the home page, and the sample data.
export default async function SetupChecklistPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite, user } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card>
        <EmptyState kind="locked" title="פנו לבעלים של העסק" description="את רשימת ההקמה ואת נתוני הדוגמה מנהלים הבעלים ומנהלי המערכת של העסק." />
      </Card>
    );
  }
  const checklist = await getSetupChecklist(orgId, user.id);
  if (!checklist) {
    return null;
  }

  return (
    <div className="space-y-5">
      <Card aria-labelledby="checklist-title">
        <CardHeader
          id="checklist-title"
          title="רשימת הקמה"
          action={
            canWrite ? (
              <ChecklistVisibilityButton orgId={orgId} hidden={!checklist.hidden}>
                {checklist.hidden ? "להציג בדף הבית" : "להסתיר מדף הבית"}
              </ChecklistVisibilityButton>
            ) : null
          }
        />
        <CardBody>
          <p className="mb-4 text-md text-ink-soft">כל שלב מסומן לבד כשהוא נעשה. נתוני דוגמה לא נחשבים.</p>
          <SetupChecklist items={checklist.items} labelledBy="checklist-title" />
        </CardBody>
      </Card>

      <Card aria-labelledby="sample-title">
        <CardHeader id="sample-title" title="נתוני דוגמה" />
        <CardBody>
          {canWrite ? (
            <SampleDataControls orgId={orgId} {...sampleCounts(checklist.sample)} />
          ) : (
            <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ואי אפשר להוסיף או למחוק נתוני דוגמה.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
