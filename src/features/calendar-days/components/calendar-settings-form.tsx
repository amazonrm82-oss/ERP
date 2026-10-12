"use client";

import { startTransition, useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { WEEKDAYS_LONG } from "@/lib/calendar-grid";

import { saveCalendarSettingsAction } from "../actions";
import type { CalendarSettings } from "../holidays";
import { OccasionChecklist } from "./occasion-checklist";

type Props = { orgId: string; settings: CalendarSettings };

/** The organization's weekly rest days, whether holidays and their eves are days off, and more occasions one by one (owners and admins). */
export function CalendarSettingsForm({ orgId, settings }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveCalendarSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  // the occasion list locks the boxes these two switches already close
  const [holidaysRest, setHolidaysRest] = useState(settings.holidaysRest);
  const [holidayEvesRest, setHolidayEvesRest] = useState(settings.holidayEvesRest);

  // submitted by hand rather than through `action`, so the boxes keep what the
  // user ticked (a form action resets an uncontrolled form, even after a failure)
  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      <Card aria-labelledby="rest-week-title">
        <CardHeader id="rest-week-title" title="ימי המנוחה בשבוע" />
        <CardBody>
          <fieldset aria-describedby="rest-week-note">
            <legend className="sr-only">ימי המנוחה בשבוע</legend>
            <p id="rest-week-note" className="mb-3 text-sm text-ink-soft">
              הימים שהעסק לא עובד בהם. היומן מסמן אותם.
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              {WEEKDAYS_LONG.map((name, day) => (
                <Checkbox key={day} name="rest_weekdays" value={String(day)} label={`יום ${name}`} defaultChecked={settings.restWeekdays.includes(day as never)} />
              ))}
            </div>
          </fieldset>
        </CardBody>
      </Card>

      <Card aria-labelledby="rest-holidays-title">
        <CardHeader id="rest-holidays-title" title="חגים" />
        <CardBody className="space-y-4">
          <Checkbox
            name="holidays_rest"
            label="החגים הם ימי מנוחה"
            hint="ראש השנה, יום כיפור, סוכות, שמחת תורה, פסח (היום הראשון והשביעי), יום העצמאות ושבועות."
            checked={holidaysRest}
            onChange={(event) => setHolidaysRest(event.currentTarget.checked)}
          />
          <Checkbox
            name="holiday_eves_rest"
            label="גם ערבי החגים הם ימי מנוחה"
            hint="ערב ראש השנה, ערב יום כיפור, ערב סוכות, הושענא רבה, ערב פסח, ערב שביעי של פסח וערב שבועות. יום הזיכרון הוא יום עבודה מקוצר, ואפשר לבחור אותו ברשימה שלמטה."
            checked={holidayEvesRest}
            onChange={(event) => setHolidayEvesRest(event.currentTarget.checked)}
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="rest-occasions-title">
        <CardHeader id="rest-occasions-title" title="מועדים נוספים" />
        <CardBody>
          <fieldset aria-describedby="rest-occasions-note">
            <legend className="sr-only">מועדים נוספים שהעסק לא עובד בהם</legend>
            <p id="rest-occasions-note" className="mb-3 text-sm text-ink-soft">
              סמנו כל מועד שהעסק לא עובד בו, גם חג או ערב חג אחד בלבד. כשהבחירה למעלה סוגרת את כל החגים או את כל ערבי החג, הם מסומנים כאן ונעולים.
            </p>
            <OccasionChecklist holidaysRest={holidaysRest} holidayEvesRest={holidayEvesRest} initial={settings.restOccasions} />
          </fieldset>
        </CardBody>
      </Card>

      <FormError message={failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton pending={pending}>שמירה</SubmitButton>
    </form>
  );
}
