import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AnomalyAlertSettingsForm } from "@/features/anomaly-alerts/components/anomaly-alert-settings-form";
import { getAnomalyAlertSettings } from "@/features/anomaly-alerts/queries";
import { anomalyRuleText, type AnomalyKind } from "@/features/anomaly-alerts/settings";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "התראות חריגה" };

type Props = { params: Promise<{ orgId: string }> };

const KINDS: ReadonlyArray<{ kind: AnomalyKind; label: string; on: "leadDropOn" | "idleRepOn" | "quietFormOn" | "campaignJumpOn" }> = [
  { kind: "lead_drop", label: "ירידה חדה בפניות ממקור קבוע", on: "leadDropOn" },
  { kind: "idle_rep", label: "מישהו בצוות שלא עדכן רשומות", on: "idleRepOn" },
  { kind: "quiet_form", label: "טופס שהפסיק לקבל פניות", on: "quietFormOn" },
  { kind: "campaign_jump", label: "קפיצה בעלות לפנייה של קמפיין", on: "campaignJumpOn" },
];

// MNY-04, owner (285) ג: a switch and a threshold for each anomaly alert; owners and admins change them, everyone reads them.
export default async function AnomalyAlertSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const settings = await getAnomalyAlertSettings(orgId);
  const editable = isAdminRole(role) && canWrite;

  const rules = (
    <Card aria-labelledby="anomaly-rules-title">
      <CardHeader id="anomaly-rules-title" title="מה כל התראה בודקת" />
      <CardBody>
        <DetailList>
          {KINDS.map(({ kind, label, on }) => (
            <Detail key={kind} label={label} value={settings[on] ? anomalyRuleText(kind, settings) : "כבויה"} />
          ))}
        </DetailList>
        <p className="mt-4 text-sm text-ink-soft">
          ירידה בפניות וטופס שהפסיק לקבל פניות לא נבדקים בשבוע עם פחות ימי עבודה (למשל שבוע של חג). כל מקור, טופס או אדם מופיע בהתראה
          לכל היותר פעם בשבוע, וכל קמפיין פעם בחודש.
        </p>
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <AnomalyAlertSettingsForm orgId={orgId} settings={settings} />
        {rules}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {rules}
      <p className="text-sm text-ink-soft">
        {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות."}
      </p>
    </div>
  );
}
