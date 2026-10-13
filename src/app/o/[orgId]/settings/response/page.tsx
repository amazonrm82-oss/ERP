import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { calendarSettingsPath } from "@/features/calendar-days/paths";
import { ResponseSettingsForm } from "@/features/response-target/components/response-settings-form";
import { getResponseSettings } from "@/features/response-target/queries";
import { breachActionLabel, clockNote, effectiveBreachAction, TARGET_SCOPE_NOTE, targetText } from "@/features/response-target/settings";
import { orgHasFeature } from "@/features/settings/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgHours } from "@/features/work-hours/queries";

export const metadata: Metadata = { title: "יעד זמן תגובה" };

type Props = { params: Promise<{ orgId: string }> };

// CAP-10: how fast a new lead should be answered, and what happens when it is not.
export default async function ResponseSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const [settings, hours, canPassOn] = await Promise.all([getResponseSettings(orgId), getOrgHours(orgId), orgHasFeature(orgId, "auto_reassign")]);
  const action = effectiveBreachAction(settings.breachAction, canPassOn);
  const note = clockNote(hours !== null);
  const editable = isAdminRole(role) && canWrite;

  const scope = (
    <Card aria-labelledby="response-scope-title">
      <CardHeader id="response-scope-title" title="איך זה עובד" />
      <CardBody className="space-y-3 text-sm">
        <p>{TARGET_SCOPE_NOTE}</p>
        <p>
          {note} <TextLink href={calendarSettingsPath(orgId)}>שעות וימי מנוחה</TextLink>
        </p>
        <p className="text-ink-soft">
          אותו יעד מופיע בדוח זמן התגובה (&quot;נענו בתוך {targetText(settings.targetMinutes)}&quot;). בדוח הזמן עדיין נספר גם בלילה ובימי מנוחה.
        </p>
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <ResponseSettingsForm orgId={orgId} settings={settings} clockNote={note} canPassOn={canPassOn} />
        {scope}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card aria-labelledby="response-target-title">
        <CardHeader id="response-target-title" title="יעד זמן תגובה לליד חדש" />
        <CardBody>
          <DetailList>
            <Detail label="היעד" value={targetText(settings.targetMinutes)} />
            <Detail label="כשליד לא נענה בזמן" value={breachActionLabel(action)} />
            {action === "pass_on" ? <Detail label="העברות לכל ליד, לכל היותר" value={String(settings.maxPasses)} /> : null}
          </DetailList>
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את היעד."}
          </p>
        </CardBody>
      </Card>
      {scope}
    </div>
  );
}
