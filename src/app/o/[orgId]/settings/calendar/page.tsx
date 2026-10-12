import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CalendarSettingsForm } from "@/features/calendar-days/components/calendar-settings-form";
import {
  HOLIDAY_KIND_LABELS,
  hebrewDayLabel,
  holidaySpans,
  holidaysInRange,
  OCCASIONS,
  occasionClosed,
  type HolidayKind,
} from "@/features/calendar-days/holidays";
import { getCalendarSettings } from "@/features/calendar-days/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { addDays, shortDay, weekday, WEEKDAYS_LONG } from "@/lib/calendar-grid";
import { zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "ימי מנוחה וחגים" };

type Props = { params: Promise<{ orgId: string }> };

const KIND_TONES: Record<HolidayKind, BadgeTone> = { rest: "accent", erev: "warning", short: "warning", observance: "neutral" };

function dayText(day: string): string {
  return `יום ${WEEKDAYS_LONG[weekday(day)]}, ${shortDay(day)}`;
}

// CAL-03: the business's weekly rest days and holidays, and the holidays of the year ahead.
export default async function CalendarSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite, org } = await getOrgContext(orgId);
  const settings = await getCalendarSettings(orgId);
  const today = zoneDate(new Date(), org.timeZone);
  const spans = holidaySpans(holidaysInRange(today, addDays(today, 364)));
  const restNames = settings.restWeekdays.map((day) => WEEKDAYS_LONG[day]);
  const occasionNames = OCCASIONS.filter((occasion) => settings.restOccasions.includes(occasion.key)).map((occasion) => occasion.name);

  return (
    <div className="space-y-5">
      {isAdminRole(role) && canWrite ? (
        <CalendarSettingsForm orgId={orgId} settings={settings} />
      ) : (
        <Card aria-labelledby="rest-days-title">
          <CardHeader id="rest-days-title" title="ימי המנוחה של העסק" />
          <CardBody>
            <DetailList>
              <Detail label="בשבוע" value={restNames.length > 0 ? restNames.join(", ") : "העסק עובד כל השבוע"} />
              <Detail label="חגים" value={settings.holidaysRest ? "ימי מנוחה" : "ימי עבודה"} />
              <Detail label="ערבי חג" value={settings.holidayEvesRest ? "ימי מנוחה" : "ימי עבודה"} />
              <Detail label="מועדים נוספים" value={occasionNames.length > 0 ? occasionNames.join(", ") : "אין"} />
            </DetailList>
            <p className="mt-4 text-sm text-ink-soft">
              {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את ימי המנוחה."}
            </p>
          </CardBody>
        </Card>
      )}

      <Card aria-labelledby="holidays-title">
        <CardHeader id="holidays-title" title="החגים בשנה הקרובה" />
        <ul className="divide-y divide-line">
          {spans.map((span) => (
            <li key={`${span.from}-${span.name}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="font-medium">{span.name}</p>
                <p className="text-sm text-ink-soft">
                  {span.from === span.to ? dayText(span.from) : `${dayText(span.from)} עד ${dayText(span.to)}`}
                  <span aria-hidden="true"> · </span>
                  <span className="whitespace-nowrap">{hebrewDayLabel(span.from)}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={KIND_TONES[span.kind]}>{HOLIDAY_KIND_LABELS[span.kind]}</Badge>
                {span.memorial ? <Badge tone="neutral">יום זיכרון</Badge> : null}
                {occasionClosed(span, settings) ? <Badge tone="neutral">העסק סגור</Badge> : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
