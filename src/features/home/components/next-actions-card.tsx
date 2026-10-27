import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { formatNumber } from "@/lib/format";

import type { NextActions } from "../next-actions";

/**
 * AIX-03 "מה הלאה": the few things to do first, in a fixed order, each with its reason and a link to its record.
 * The cards below it keep the full lists; this one only orders and explains.
 */
export function NextActionsCard({ next }: { next: NextActions }) {
  const more = next.total - next.actions.length;
  return (
    <Card aria-labelledby="next-actions-title" className="mb-5">
      <CardHeader id="next-actions-title" title="מה הלאה" />
      <CardBody>
        {next.actions.length === 0 ? (
          <EmptyState compact kind="done" title="אין כרגע משהו דחוף" description="משימות, פגישות ולידים חדשים יופיעו כאן לפי הסדר שבו כדאי לטפל בהם." />
        ) : (
          <>
            <ol className="divide-y divide-line">
              {next.actions.map((action, index) => (
                <li key={action.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold tabular-nums text-accent-strong"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <Link href={action.href} className="block break-words font-medium underline-offset-4 hover:underline">
                      <bdi>{action.title}</bdi>
                    </Link>
                    <span className="block text-sm text-ink-soft">
                      <span className={action.urgent ? "font-medium text-danger" : undefined}>{action.reason}</span>
                      {action.context ? (
                        <>
                          {" · "}
                          <bdi className="break-words">{action.context}</bdi>
                        </>
                      ) : null}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            {more > 0 ? (
              <p className="mt-3 text-sm text-ink-soft">
                {more === 1 ? "ועוד פעולה אחת" : `ועוד ${formatNumber(more)} פעולות`} ברשימות שבהמשך הדף.
              </p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
