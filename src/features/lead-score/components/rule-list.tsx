import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";

import { deleteScoreRuleAction, setScoreRuleActiveAction } from "../actions";
import { describeRule, pointsText, type ScoreLookups, type ScoreRule } from "../rules";

/** LEAD-05: the business's score rules; owners and admins hide, show and delete them. */
export function ScoreRuleList({ orgId, rules, lookups, editable }: { orgId: string; rules: ScoreRule[]; lookups: ScoreLookups; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {rules.map((rule) => {
        const { text, known } = describeRule(rule, lookups);
        return (
          <li key={`${rule.id}-${rule.isActive}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
            <Badge tone={rule.points > 0 ? "success" : "danger"} className="tabular-nums">
              <span dir="ltr">{pointsText(rule.points)}</span>
              <span className="sr-only"> נקודות</span>
            </Badge>
            <span className="min-w-0 flex-1 break-words">{text}</span>
            {known ? null : <Badge tone="warning">לא נספר</Badge>}
            {rule.isActive ? null : <Badge>מוסתר</Badge>}
            {editable ? (
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <ActionButton action={setScoreRuleActiveAction.bind(null, orgId, rule.id, !rule.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={text}>
                  {rule.isActive ? "הסתרה" : "הצגה"}
                </ActionButton>
                <ActionButton
                  action={deleteScoreRuleAction.bind(null, orgId, rule.id)}
                  pendingText="מוחקים…"
                  variant="danger-ghost"
                  srLabel={text}
                  confirm="למחוק את הכלל? הציונים של כל הלידים יחושבו מחדש."
                >
                  מחיקה
                </ActionButton>
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
