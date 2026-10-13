import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

import { getRecordSummary } from "../queries";
import { buildSummaryView, moreTasksText, nextActionHref, type DealLine } from "../summary";

type Props = {
  orgId: string;
  type: "contact" | "company";
  id: string;
  // the organization's own settings (OrgContext.org)
  currency: string;
  timeZone: string;
};

function Deals({ line, empty }: { line: DealLine; empty: string }) {
  if (!line) {
    return <span className="text-ink-soft">{empty}</span>;
  }
  return (
    <>
      <span className="block font-medium">{line.countText}</span>
      {line.amounts.map((amount) => (
        <span key={amount} className="block text-sm text-ink-soft">
          {amount}
        </span>
      ))}
    </>
  );
}

/**
 * REC-10: the automatic summary of a contact or a company: won and open deals
 * (count and sum), the last logged touch, and the next action: the open task or
 * the planned meeting that comes first, with its kind, linking to its day in the calendar.
 */
export async function RecordSummaryCard({ orgId, type, id, currency, timeZone }: Props) {
  const data = await getRecordSummary(orgId, type, id);
  const view = buildSummaryView(data, { currency, timeZone, now: new Date() });

  return (
    <Card aria-labelledby="record-summary-title">
      <CardHeader id="record-summary-title" title="סיכום" />
      <CardBody>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
          <div className="min-w-0">
            <dt className="text-sm text-ink-soft">עסקאות שנסגרו בהצלחה</dt>
            <dd className="mt-0.5 break-words">
              <Deals line={view.won} empty="אין" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-sm text-ink-soft">עסקאות פתוחות</dt>
            <dd className="mt-0.5 break-words">
              <Deals line={view.open} empty="אין" />
            </dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-sm text-ink-soft">מגע אחרון</dt>
            <dd className="mt-0.5 break-words">
              {view.lastTouch ? (
                <>
                  <span className="font-medium">{view.lastTouch.label}</span>
                  <span>, {view.lastTouch.ago} </span>
                  <time dateTime={view.lastTouch.iso} className="text-sm text-ink-soft">
                    ({view.lastTouch.dateText})
                  </time>
                </>
              ) : (
                <span className="text-ink-soft">עוד לא נרשם מגע</span>
              )}
            </dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt className="text-sm text-ink-soft">הפעולה הבאה</dt>
            <dd className="mt-0.5 break-words">
              {view.nextAction ? (
                <>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={view.nextAction.kind === "meeting" ? "accent" : "neutral"}>{view.nextAction.kindLabel}</Badge>
                    <Link
                      href={nextActionHref(orgId, view.nextAction, timeZone)}
                      className="min-w-0 break-words font-medium text-accent underline underline-offset-4 hover:text-accent-strong"
                    >
                      {view.nextAction.title || (view.nextAction.kind === "meeting" ? "פגישה בלי כותרת" : "משימה בלי כותרת")}
                    </Link>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                    {view.nextAction.overdue ? <Badge tone="danger">באיחור</Badge> : null}
                    {view.nextAction.iso && view.nextAction.dateText ? (
                      <time dateTime={view.nextAction.iso}>{view.nextAction.dateText}</time>
                    ) : (
                      <span>בלי תאריך</span>
                    )}
                    {view.otherOpenTasks > 0 ? <span>· {moreTasksText(view.nextAction.kind, view.otherOpenTasks)}</span> : null}
                  </span>
                </>
              ) : (
                <span className="text-ink-soft">אין משימה פתוחה או פגישה מתוכננת</span>
              )}
            </dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}
