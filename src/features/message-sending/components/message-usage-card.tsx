import { Card, CardHeader } from "@/components/ui/card";
import { Meter } from "@/components/ui/chart";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";

import { CHANNEL_LABELS, marketingLine, nearCap, type ChannelUsage } from "../usage";
import { WaitingActions } from "./waiting-actions";

type Props = { orgId: string; month: string; channels: ChannelUsage[] };

/** "2026-11" -> "11/2026" */
function monthText(month: string): string {
  const [year, m] = month.split("-");
  return `${m}/${year}`;
}

/** MSG-05: this month's messages per channel, against the month's cap of marketing. Owners and admins. */
export function MessageUsageCard({ orgId, month, channels }: Props) {
  return (
    <Card aria-labelledby="message-usage-title">
      <CardHeader id="message-usage-title" title={`שימוש החודש (${monthText(month)})`} />
      <ul className="divide-y divide-line">
        {channels.map((usage) => {
          const near = nearCap(usage);
          const label = CHANNEL_LABELS[usage.channel];
          return (
            <li key={usage.channel} className="space-y-1 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{label}</span>
                <span className={cn("text-md tabular-nums", near ? "font-semibold text-danger" : "text-ink-soft")}>{marketingLine(usage, formatNumber)}</span>
              </div>
              {usage.cap !== null ? (
                <Meter
                  label={`הודעות שיווק, ${label}`}
                  value={usage.marketing}
                  max={Math.max(usage.cap, 1)}
                  valueText={marketingLine(usage, formatNumber)}
                  tone={near ? "alert" : "bar"}
                />
              ) : null}
              <p className="text-sm text-ink-soft">
                {formatNumber(usage.service)} הודעות שירות (לא נספרות בתקרה)
                {usage.planMonthCap !== null ? ` · מכסת החבילה: ${formatNumber(usage.planMonthCap)} בחודש` : ""}
                {usage.planDayCap !== null ? `, ${formatNumber(usage.planDayCap)} ביום (היום: ${formatNumber(usage.marketingToday)})` : ""}
              </p>
              {usage.held ? <p className="text-sm text-ink-soft">התקרה התמלאה: הודעות שיווק מחכות עד שהתקרה תוגדל, גם בחודש חדש.</p> : null}
              {usage.waitingCap > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-danger">{formatNumber(usage.waitingCap)} הודעות שיווק מחכות לתקרה</p>
                  <WaitingActions orgId={orgId} channel={usage.channel} count={usage.waitingCap} />
                </div>
              ) : null}
              {usage.waitingHours > 0 ? <p className="text-sm text-ink-soft">{formatNumber(usage.waitingHours)} הודעות מחכות לשעות השליחה</p> : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
