import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { MemberPermissionsForm } from "@/features/permissions/components/member-permissions-form";
import { canReceivePermissions } from "@/features/permissions/keys";
import { getMemberPermissions } from "@/features/permissions/queries";
import { canManageMember, isAdminRole } from "@/features/settings/permissions";
import { listMembers, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הרשאות נוספות" };

type Props = { params: Promise<{ orgId: string; userId: string }> };

// PRM-01: an owner or admin gives a manager or member extra permissions on top of the role.
export default async function MemberPermissionsPage({ params }: Props) {
  const { orgId, userId } = await params;
  if (!isUuid(userId)) notFound();
  const { role, canWrite, user } = await getOrgContext(orgId);
  const back = { href: paths.settingsUsers(orgId), label: "משתמשים" };
  if (!isAdminRole(role)) {
    return (
      <>
        <PageHeader title="הרשאות נוספות" back={back} />
        <p>הרשאות נוספות נותנים בעלים ומנהלי מערכת.</p>
      </>
    );
  }
  const members = await listMembers(orgId);
  const person = members.find((m) => m.userId === userId);
  if (!person) notFound();
  const [all, inPlan] = await Promise.all([getMemberPermissions(orgId), orgHasFeature(orgId, "granular_permissions")]);
  const granted = all.get(userId) ?? [];
  const title = `הרשאות נוספות: ${person.name}`;

  if (!canReceivePermissions(person.role) || person.status !== "active" || !canManageMember(role, user.id, person)) {
    return (
      <>
        <PageHeader title={title} back={back} />
        <p className="max-w-2xl">
          {person.status !== "active"
            ? "למשתמש מושבת אין הרשאות. כשמחזירים אותו לפעילות, נותנים לו אותן מחדש."
            : person.role === "viewer"
              ? "למושב צפייה אין הרשאות נוספות."
              : "בעלים ומנהלי מערכת מחזיקים בכל ההרשאות ממילא."}
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={title}
        description="מה המשתמש יכול לעשות נוסף על התפקיד שלו. בעלים ומנהלי מערכת מחזיקים בכל ההרשאות ממילא. כל שינוי נרשם ביומן הביקורת."
        back={back}
      />
      {!inPlan ? (
        <p role="note" className="mb-4 max-w-3xl rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          הרשאות נקודתיות כלולות מחבילת &quot;מקצועי&quot;. בחבילה הנוכחית ההרשאות לא פועלות, ואפשר רק להסיר אותן. פרטים ב&quot;הגדרות &gt; חבילה ושימוש&quot;.
        </p>
      ) : null}
      {!canWrite ? <p className="mb-4 text-sm text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר לשנות הרשאות.</p> : null}
      <Card className="max-w-3xl">
        <CardBody>
          <MemberPermissionsForm orgId={orgId} userId={userId} name={person.name} granted={granted} canEdit={canWrite} />
        </CardBody>
      </Card>
    </>
  );
}
