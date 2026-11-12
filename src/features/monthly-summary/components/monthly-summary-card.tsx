import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { byGender, type OrgTerms } from "@/features/terminology/terms";
import { formatNumber } from "@/lib/format";

import { monthLabel, nextMonth, previousMonth, summaryLines, type MonthlySummary } from "../summary";

type Props = {
  data: MonthlySummary;
  terms: OrgTerms;
  /** the business's today, YYYY-MM-DD */
  today: string;
  /** the page the month links go to (the month goes in `?month=`) */
  basePath: string;
};

/** MNY-06: what the system did for the business in a month, counts only (owners and admins). */
export function MonthlySummaryCard({ data, terms, today, basePath }: Props) {
  const lines = summaryLines(data, terms, formatNumber);
  const earlier = previousMonth(data.month);
  const later = nextMonth(data.month, today);
  const isCurrent = later === null;
  const title = isCurrent ? "מה המערכת עשתה בשבילכם החודש" : `מה המערכת עשתה בשבילכם ב${monthLabel(data.month)}`;
  return (
    <Card aria-labelledby="monthly-summary-title" className="mb-6">
      <CardHeader
        id="monthly-summary-title"
        title={title}
        action={
          <nav aria-label="בחירת חודש" className="flex shrink-0 gap-3 text-md">
            <Link href={`${basePath}?month=${earlier}`} className="text-accent underline-offset-2 hover:underline">
              החודש הקודם
            </Link>
            {later ? (
              <Link href={`${basePath}?month=${later}`} className="text-accent underline-offset-2 hover:underline">
                החודש הבא
              </Link>
            ) : null}
          </nav>
        }
      />
      <CardBody>
        <p className="mb-3 text-md text-ink-soft">{monthLabel(data.month)}</p>
        {lines.length === 0 ? (
          <p>עוד אין מה להראות לחודש הזה.</p>
        ) : (
          <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {lines.map((line) => (
              <div key={line.key} className="rounded-lg border border-line p-3">
                <dt className="text-md text-ink-soft">{line.label}</dt>
                <dd className="mt-1 text-xl font-semibold">{formatNumber(line.value)}</dd>
                {line.note ? <dd className="text-md text-ink-soft">{line.note}</dd> : null}
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-md text-ink-soft">
          מספרים בלבד. הודעות ללקוחות נספרות כשהן נכנסות לתור השליחה, עוד לפני שנשלחו, ורק הודעות שהמערכת הכינה מעצמה, בלי הודעות שאנשי הצוות שלחו.{" "}
          {terms.lead.plural} שהועברו לסל המחזור {byGender(terms.lead, "נשארים", "נשארות")} בספירה.
        </p>
      </CardBody>
    </Card>
  );
}
