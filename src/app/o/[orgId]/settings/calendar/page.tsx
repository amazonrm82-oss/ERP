import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Detail, DetailList } from "@/components/detail-list";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BusinessCalendarEffects } from "@/features/calendar-days/components/business-calendar-effects";
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
import { WEEKDAYS, type Weekday } from "@/features/profile/working-hours";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { clearOrgHoursAction, setDefaultOrgHoursAction } from "@/features/work-hours/actions";
import { OrgHoursForm } from "@/features/work-hours/components/org-hours-form";
import { DEFAULT_ORG_HOURS, workingDaysOnly } from "@/features/work-hours/in-hours";
import { getOrgHours } from "@/features/work-hours/queries";
import { addDays, shortDay, weekday, WEEKDAYS_LONG } from "@/lib/calendar-grid";
import { zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "שעות וימי מנוחה" };

type Props = { params: Promise<{ orgId: string }> };

const KIND_TONES: Record<HolidayKind, BadgeTone> = { rest: "accent", erev: "warning", short: "warning", observance: "neutral" };

function dayText(day: string): string {
  return `יום ${WEEKDAYS_LONG[weekday(day)]}, ${shortDay(day)}`;
}

// CAL-03: the business's weekly rest days and holidays, and the holidays of the year ahead.
// CAP-09: the business's weekly working hours. HEB-02: what the calendar affects.
export default async function CalendarSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite, org } = await getOrgContext(orgId);
  const [settings, savedHours] = await Promise.all([getCalendarSettings(orgId), getOrgHours(orgId)]);
  // no hours set: no limit (review M1); the form starts from 08:00-18:00 on the working days
  const orgHours = savedHours ?? workingDaysOnly(DEFAULT_ORG_HOURS, settings);
  const admin = isAdminRole(role) && canWrite;
  const restNotes = Object.fromEntries(
    WEEKDAYS.flatMap(({ key }, i) => ((settings.restWeekdays as number[]).includes(i) ? [[key, "יום מנוחה של העסק"]] : [])),
  ) as Partial<Record<Weekday, string>>;
  const hoursLines = WEEKDAYS.map(({ key, label }, i) => {
    const ranges = orgHours[key];
    const closed = (settings.restWeekdays as number[]).includes(i);
    return { label, text: closed ? "יום מנוחה" : ranges ? ranges.map((r) => `${r.start}–${r.end}`).join(", ") : "סגור", ltr: !closed && Boolean(ranges) };
  });
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

      <BusinessCalendarEffects />

      <Card aria-labelledby="org-hours-title">
        <CardHeader id="org-hours-title" title="שעות העבודה של העסק" />
        <CardBody>
          {!savedHours ? (
            <div className="space-y-3">
              <p className="text-md">לא הוגדרו שעות: הלידים מחולקים בכל שעה.</p>
              <p className="text-sm text-ink-soft">
                {admin
                  ? "כשמגדירים שעות, לידים בסבב מגיעים רק למי שבשעות העבודה שלו, ולא בימי המנוחה ובחגים. אפשר לשנות את השעות אחר כך."
                  : "רק בעלים ומנהלי מערכת יכולים להגדיר שעות עבודה לעסק."}
              </p>
              {admin ? (
                <ActionButton action={setDefaultOrgHoursAction.bind(null, orgId)} pendingText="שומרים…" variant="primary">
                  הגדרת שעות עבודה: מ-08:00 עד 18:00 בימי העבודה
                </ActionButton>
              ) : null}
            </div>
          ) : admin ? (
            <div className="space-y-5">
              <OrgHoursForm orgId={orgId} hours={orgHours} restNotes={restNotes} />
              <div className="space-y-2 border-t border-line pt-4">
                <p className="text-sm text-ink-soft">בלי שעות עבודה, הלידים בסבב מחולקים בכל שעה ובכל יום. שעות שהגדירו העובדים לעצמם עדיין חלות עליהם.</p>
                <ActionButton
                  action={clearOrgHoursAction.bind(null, orgId)}
                  pendingText="מבטלים…"
                  variant="ghost"
                  confirm="לבטל את שעות העבודה של העסק? הלידים בסבב יחולקו בכל שעה."
                  confirmLabel="ביטול שעות העבודה"
                >
                  ביטול שעות העבודה של העסק
                </ActionButton>
              </div>
            </div>
          ) : (
            <>
              <DetailList>
                {hoursLines.map((line) => (
                  <Detail key={line.label} label={line.label} value={line.text} ltr={line.ltr} />
                ))}
              </DetailList>
              <p className="mt-4 text-sm text-ink-soft">
                לידים בסבב מגיעים רק בשעות העבודה. את השעות שלכם אפשר לשנות ב&quot;החשבון שלי&quot;.
              </p>
            </>
          )}
        </CardBody>
      </Card>

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
