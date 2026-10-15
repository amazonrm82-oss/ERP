import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { DistributionForm } from "@/features/lead-distribution/components/distribution-form";
import { AddRoutingRuleForm, RoutingRuleList } from "@/features/lead-distribution/components/routing-rules";
import { getDistributionSettings, getRuleChoices, listRoutingRules } from "@/features/lead-distribution/queries";
import { DISTRIBUTION_FEATURE, effectiveMethod, methodLabel, RULES_MAX, RULES_PRODUCT_NOTE, RULES_SCOPE_NOTE, takesLeads, weightOf } from "@/features/lead-distribution/settings";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "חלוקת לידים" };

type Props = { params: Promise<{ orgId: string }> };

// CAP-08: how leads that are distributed automatically pick their owner, and which team they go to.
export default async function DistributionSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const [settings, rules, members, canChoose] = await Promise.all([
    getDistributionSettings(orgId),
    listRoutingRules(orgId),
    listMembers(orgId),
    orgHasFeature(orgId, DISTRIBUTION_FEATURE),
  ]);
  const choices = await getRuleChoices(orgId, rules);
  const editable = isAdminRole(role) && canWrite;
  const takers = members.filter(takesLeads).map((member) => ({ userId: member.userId, name: member.name, available: member.isAvailable }));
  // a rule may name any active member who is not a viewer (the database checks it again)
  const ruleChoices = {
    ...choices,
    people: members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name })),
  };
  const method = effectiveMethod(settings.method, canChoose);

  const how = (
    <Card aria-labelledby="distribution-how-title">
      <CardHeader id="distribution-how-title" title="מי מקבל לידים" />
      <CardBody className="space-y-3 text-sm">
        <p>
          לידים מחולקים בין העובדים הפעילים במושב מלא שמסומנים כזמינים, בשעות העבודה שלהם ולא בחופשה. מי שנעדר ויש לו ממלא מקום, ממלא המקום מקבל את הליד במקומו.
        </p>
        <p className="text-ink-soft">
          השיטה חלה על טופס או חיבור שמחלק בסבב, על אוטומציה שמשייכת בסבב, ועל העברה לנציג הבא כשליד לא נענה בזמן. בוחרים אילו טפסים מחלקים בסבב
          ב<TextLink href={paths.settingsIntake(orgId)}>טפסים וחיבורים</TextLink>.
        </p>
      </CardBody>
    </Card>
  );

  const rulesCard = (
    <Card aria-labelledby="distribution-rules-title">
      <CardHeader id="distribution-rules-title" title="כללי חלוקה" />
      <CardBody className="space-y-3 text-sm">
        <p>{RULES_SCOPE_NOTE}</p>
        <p className="text-ink-soft">{RULES_PRODUCT_NOTE}</p>
        {!canChoose ? <p className="text-ink-soft">כללי חלוקה לא כלולים בחבילה הנוכחית. כללים שנשמרו לא פועלים עד שיתווספו.</p> : null}
      </CardBody>
      <RoutingRuleList orgId={orgId} rules={rules} choices={ruleChoices} editable={editable} />
      {editable && canChoose && rules.length < RULES_MAX ? (
        <CardBody className="border-t border-line">
          <AddRoutingRuleForm orgId={orgId} choices={ruleChoices} />
        </CardBody>
      ) : null}
      {editable && rules.length >= RULES_MAX ? (
        <CardBody className="border-t border-line text-sm text-ink-soft">{`אפשר לשמור עד ${RULES_MAX} כללים. מחקו כלל כדי להוסיף חדש.`}</CardBody>
      ) : null}
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <DistributionForm orgId={orgId} settings={settings} members={takers} canChoose={canChoose} />
        {rulesCard}
        {how}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card aria-labelledby="distribution-method-title">
        <CardHeader id="distribution-method-title" title="איך מחלקים לידים" />
        <CardBody>
          <DetailList>
            <Detail label="שיטת החלוקה" value={methodLabel(method)} />
            {method !== "round_robin"
              ? takers.map((member) => <Detail key={member.userId} label={member.name} value={`משקל ${weightOf(settings.weights, member.userId)}`} />)
              : null}
          </DetailList>
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את חלוקת הלידים."}
          </p>
        </CardBody>
      </Card>
      {rulesCard}
      {how}
    </div>
  );
}
