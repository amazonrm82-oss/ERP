import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getCalendarSettings } from "@/features/calendar-days/queries";
import { canManageMember, isAdminRole } from "@/features/settings/permissions";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { MemberHoursSection } from "@/features/work-hours/components/member-hours-section";
import { getDeputyOptions, getFixedOwnerForms, getMemberHours, getOrgHours } from "@/features/work-hours/queries";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "שעות עבודה וחופשה" };

type Props = { params: Promise<{ orgId: string; userId: string }> };

// CAP-09: an owner or admin sets a member's working hours and leaves.
export default async function MemberHoursPage({ params }: Props) {
  const { orgId, userId } = await params;
  if (!isUuid(userId)) notFound();
  const { role, canWrite, org, user } = await getOrgContext(orgId);
  const back = { href: paths.settingsUsers(orgId), label: "משתמשים" };
  if (!isAdminRole(role)) {
    return (
      <>
        <PageHeader title="שעות עבודה וחופשה" back={back} />
        <p>את השעות והחופשות של אחרים קובעים בעלים ומנהלי מערכת. את שלכם קובעים ב&quot;החשבון שלי&quot;.</p>
      </>
    );
  }
  const members = await listMembers(orgId);
  const person = members.find((m) => m.userId === userId);
  if (!person) notFound();
  const [member, orgHours, calendar, deputyOptions, fixedOwnerForms] = await Promise.all([
    getMemberHours(orgId, userId, org.timeZone),
    getOrgHours(orgId),
    getCalendarSettings(orgId),
    getDeputyOptions(orgId, userId),
    getFixedOwnerForms(orgId, userId),
  ]);
  const isMe = userId === user.id;

  return (
    <>
      <PageHeader
        title={`שעות עבודה וחופשה: ${person.name}`}
        description="לידים בסבב מגיעים רק למי שזמין, בשעות העבודה שלו ולא בחופשה."
        back={back}
      />
      <Card className="max-w-3xl">
        <CardBody>
          <MemberHoursSection
            orgId={orgId}
            userId={userId}
            name={isMe ? null : person.name}
            member={member}
            orgHours={orgHours}
            calendar={calendar}
            orgTimeZone={org.timeZone}
            // the owner changes anyone; an admin anyone but the owner and other admins (as the database)
            canEdit={canWrite && person.status === "active" && (isMe || canManageMember(role, user.id, person))}
            outOfRotation={person.seatType !== "full" ? "seat" : person.status !== "active" || !person.isAvailable ? "unavailable" : null}
            deputyOptions={deputyOptions}
            fixedOwnerForms={fixedOwnerForms}
            personName={person.name}
          />
        </CardBody>
      </Card>
    </>
  );
}
