import type { CalendarSettings } from "@/features/calendar-days/holidays";
import type { WorkingHours } from "@/features/profile/working-hours";

import { DEFAULT_ORG_HOURS, OUT_OF_HOURS_LABELS, outOfHoursReason, wallClock, workingDaysOnly } from "../in-hours";
import type { MemberHours } from "../queries";
import { LeaveManager } from "./leave-manager";
import { MemberHoursForm } from "./member-hours-form";

type Props = {
  orgId: string;
  userId: string;
  // null on the user's own page
  name: string | null;
  member: MemberHours;
  orgHours: WorkingHours | null;
  calendar: CalendarSettings;
  orgTimeZone: string;
  canEdit: boolean;
  // why the person is not in lead distribution now, or null when they are
  outOfRotation: "unavailable" | "seat" | null;
};

/** "שעות עבודה וחופשה" of one member (CAP-09): the status now, the hours, the leaves. */
export function MemberHoursSection({ orgId, userId, name, member, orgHours, calendar, orgTimeZone, canEdit, outOfRotation }: Props) {
  const zone = member.timeZone ?? orgTimeZone;
  const now = new Date();
  const reason = outOfHoursReason({
    at: now,
    orgTimeZone,
    calendar,
    orgHours,
    userTimeZone: member.timeZone,
    userHours: member.hours,
    leaves: member.leaves,
  });
  const today = wallClock(now, zone).date;
  const status = outOfRotation === "seat"
    ? "מושב צפייה לא מקבל לידים בסבב."
    : outOfRotation === "unavailable"
    ? "לא בסבב הלידים כרגע (מסומן כלא זמין)."
    : reason
      ? `עכשיו: ${OUT_OF_HOURS_LABELS[reason]}. לידים חדשים בסבב לא יגיעו ${name ? `ל${name}` : "אליכם"} עד שיחזרו השעות.`
      : `עכשיו: ${member.hours || orgHours ? "בשעות העבודה" : "אין הגבלת שעות"}. לידים חדשים בסבב יכולים להגיע ${name ? `ל${name}` : "אליכם"}.`;

  return (
    <div className="space-y-6">
      <p role="status" className="rounded-md bg-canvas px-3 py-2 text-sm text-ink">
        {status}
      </p>
      {canEdit ? (
        <MemberHoursForm
          orgId={orgId}
          userId={userId}
          whose={name}
          hours={member.hours}
          orgHours={workingDaysOnly(orgHours ?? DEFAULT_ORG_HOURS, calendar)}
          orgHasHours={orgHours !== null}
          zoneText={zone}
        />
      ) : (
        <p className="text-md">{member.hours ? "שעות עבודה משלו." : "לפי שעות העסק."}</p>
      )}
      <section aria-labelledby={`leaves-${userId}`} className="space-y-3 border-t border-line pt-4">
        <h3 id={`leaves-${userId}`} className="text-md font-medium text-ink">
          חופשות והיעדרויות
        </h3>
        <p className="text-sm text-ink-soft">בימי החופשה לא מגיעים לידים בסבב. ממלא מקום יתווסף בהמשך.</p>
        <LeaveManager orgId={orgId} userId={userId} leaves={member.leaves.filter((leave) => leave.endsOn >= today)} canEdit={canEdit} today={today} timeZone={zone} />
      </section>
    </div>
  );
}
