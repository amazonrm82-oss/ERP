import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";

import { addSuggestedScoreRulesAction } from "../actions";
import { SUGGESTED_RULES, describeRule, pointsText, type ScoreLookups } from "../rules";

/**
 * LEAD-05 (owner, 14 October 2026): a business with no rules sees the suggested ones and, for
 * owners and admins of a writable business, one button that adds them. The one documented
 * exception to "no add-suggested button": new businesses get these rules when they are created.
 */
export function SuggestedRules({ orgId, lookups, editable }: { orgId: string; lookups: ScoreLookups; editable: boolean }) {
  return (
    <div className="space-y-3 text-md">
      <div>
        <p className="mb-2 text-ink">הכללים שאנחנו מציעים להתחיל איתם:</p>
        <ul className="space-y-2">
          {SUGGESTED_RULES.map((rule) => (
            <li key={rule.field} className="flex items-center gap-3">
              <Badge tone="success" className="tabular-nums">
                <span dir="ltr">{pointsText(rule.points)}</span>
                <span className="sr-only"> נקודות</span>
              </Badge>
              <span className="min-w-0 flex-1 break-words">{describeRule(rule, lookups).text}</span>
            </li>
          ))}
        </ul>
      </div>
      {editable ? (
        <>
          <p className="text-sm text-ink-soft">אחרי ההוספה אפשר להסתיר כל כלל או למחוק אותו, ולהוסיף כללים משלכם. הציונים של כל הלידים הקיימים יעודכנו לפי הכללים.</p>
          <ActionButton
            action={addSuggestedScoreRulesAction.bind(null, orgId)}
            pendingText="מוסיפים…"
            variant="primary"
            confirm="להוסיף את הכללים המוצעים? הציונים של כל הלידים הקיימים יעודכנו."
          >
            הוסף את הכללים המוצעים
          </ActionButton>
        </>
      ) : null}
    </div>
  );
}
