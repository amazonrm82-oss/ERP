import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AddRuleForm } from "@/features/lead-score/components/add-rule-form";
import { SuggestedRules } from "@/features/lead-score/components/suggested-rules";
import { ScoreRuleList } from "@/features/lead-score/components/rule-list";
import { getScoreLookups, listScoreRules, scoresPending } from "@/features/lead-score/queries";
import { SCORE_RULES_MAX, scoreFieldChoices, valueKindOf } from "@/features/lead-score/rules";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "ציון ליד" };

type Props = { params: Promise<{ orgId: string }> };

/** LEAD-05: the rules that add or take off points from a lead. Everyone reads them; owners and admins edit. */
export default async function LeadScoreSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const [rules, lookups, pending] = await Promise.all([listScoreRules(orgId), getScoreLookups(orgId), scoresPending(orgId)]);
  // a field whose every condition needs a choice from an empty list (no tags yet) is not offered
  const choices = scoreFieldChoices(lookups).filter((choice) => choice.ops.some((op) => valueKindOf(choice, op) !== "option" || (choice.options ?? []).length > 0));

  return (
    <Card aria-labelledby="lead-score-title">
      <CardHeader id="lead-score-title" title="ציון ליד" />
      <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
        <p>כל ליד מקבל ציון: סכום הנקודות של הכללים שהוא עומד בהם. הציון מופיע ברשימת הלידים ובכרטיס הליד, ואפשר למיין ולסנן לפיו.</p>
        <p>הציון מתעדכן לבד כשהליד משתנה וכשנרשמת פעילות בציר הזמן שלו. אחרי שינוי בכללים, כל הלידים מחושבים מחדש תוך כמה דקות.</p>
        {pending ? (
          <p role="status" className="text-ink">
            הציונים מחושבים מחדש עכשיו.
          </p>
        ) : null}
      </CardBody>
      {rules.length > 0 ? (
        <div className="mt-3 border-t border-line">
          <ScoreRuleList orgId={orgId} rules={rules} lookups={lookups} editable={editable} />
        </div>
      ) : (
        <CardBody className="mt-3 border-t border-line">
          <SuggestedRules orgId={orgId} lookups={lookups} editable={editable} />
        </CardBody>
      )}
      {editable && rules.length < SCORE_RULES_MAX ? (
        <CardBody className="border-t border-line">
          <h3 className="mb-3 text-md font-semibold text-ink">כלל חדש</h3>
          <AddRuleForm orgId={orgId} choices={choices} />
        </CardBody>
      ) : null}
      {!editable ? (
        <CardBody className="border-t border-line">
          <p className="text-sm text-ink-soft">{isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את הכללים."}</p>
        </CardBody>
      ) : null}
    </Card>
  );
}
