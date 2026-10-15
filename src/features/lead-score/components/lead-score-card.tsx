import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";

import { leadScoreSettingsPath } from "../paths";
import { getScoreBreakdown, getScoreLookups, listScoreRules } from "../queries";
import { describeRule, pointsText } from "../rules";

/** LEAD-05: the lead's score and the rules that make it up. Hidden while the business has no active rule. */
export async function LeadScoreCard({ orgId, leadId }: { orgId: string; leadId: string }) {
  const rules = (await listScoreRules(orgId)).filter((rule) => rule.isActive);
  if (rules.length === 0) {
    return null;
  }
  const [breakdown, lookups] = await Promise.all([getScoreBreakdown(orgId, leadId), getScoreLookups(orgId)]);
  if (!breakdown) {
    return null;
  }
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const matched = breakdown.matched.flatMap((m) => {
    const rule = byId.get(m.id);
    return rule ? [{ id: m.id, points: m.points, text: describeRule(rule, lookups).text }] : [];
  });
  const live = matched.reduce((sum, m) => sum + m.points, 0);

  return (
    <Card aria-labelledby="lead-score-card-title">
      <CardHeader
        id="lead-score-card-title"
        title="ציון ליד"
        action={
          <span className="text-lg font-semibold tabular-nums" dir="ltr">
            {breakdown.score}
          </span>
        }
      />
      <CardBody className="space-y-3">
        {matched.length > 0 ? (
          <ul className="space-y-1 text-md">
            {matched.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2">
                <span className="w-10 shrink-0 font-medium tabular-nums text-ink" dir="ltr">
                  {pointsText(m.points)}
                </span>
                <span className="min-w-0 break-words">{m.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-md text-ink-soft">הליד לא עומד באף כלל כרגע.</p>
        )}
        {live !== breakdown.score ? <p className="text-sm text-ink-soft">הציון מתעדכן בדקות הקרובות.</p> : null}
        <p className="text-sm">
          <TextLink href={leadScoreSettingsPath(orgId)}>כללי הניקוד</TextLink>
        </p>
      </CardBody>
    </Card>
  );
}
