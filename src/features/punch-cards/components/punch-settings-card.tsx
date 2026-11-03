import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { listMeetingTypeChoices } from "@/features/meeting-types/queries";
import { orgHasFeature } from "@/features/settings/queries";

import { punchSettingsText } from "../balance";
import { getPunchSettings } from "../queries";
import { PunchSettingsForm } from "./punch-settings-form";

/** PKG-01: the settings card of a punch card product; catalog editors change them while the plan has the key. */
export async function PunchSettingsCard({ orgId, productId, canEdit }: { orgId: string; productId: string; canEdit: boolean }) {
  const [settings, meetingTypes, inPlan] = await Promise.all([getPunchSettings(orgId, productId), listMeetingTypeChoices(orgId), orgHasFeature(orgId, "punch_cards")]);
  if (!settings) return null;
  const names = new Map(meetingTypes.map((type) => [type.id, type.name]));
  const covered = settings.meetingTypeIds.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
  return (
    <Card aria-labelledby="punch-settings-title">
      <CardHeader id="punch-settings-title" title="הגדרות הכרטיסייה" />
      <CardBody className="space-y-3">
        <p className="text-sm">{punchSettingsText(settings.entries, settings.validityCount, settings.validityUnit)}</p>
        <p className="text-sm text-ink-soft">{covered.length > 0 ? `חלה על: ${covered.join(", ")}` : "עוד לא נבחרו סוגי פגישה, ולכן פגישות לא מורידות כניסות."}</p>
        {!inPlan ? <p className="text-sm text-ink-soft">כרטיסיות אינן כלולות בחבילה הנוכחית.</p> : null}
        {canEdit && inPlan ? (
          <PunchSettingsForm
            orgId={orgId}
            productId={productId}
            settings={settings}
            meetingTypes={meetingTypes.map((type) => ({ id: type.id, name: type.name, active: type.isActive }))}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}
