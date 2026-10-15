import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { getMemberPermissions } from "@/features/permissions/queries";
import { InviteForm } from "@/features/settings/components/invite-form";
import { MembersList } from "@/features/settings/components/members-list";
import { PendingInvitations } from "@/features/settings/components/pending-invitations";
import { TransferOwnershipForm } from "@/features/settings/components/transfer-ownership-form";
import { assignableRoles, isAdminRole } from "@/features/settings/permissions";
import { listMembers, listMembersWithMfa, listPendingInvitations, orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { absenceLabel } from "@/features/work-hours/leave";
import { getCurrentAbsences } from "@/features/work-hours/queries";
import { shortDay } from "@/lib/calendar-grid";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "משתמשים" };

type Props = { params: Promise<{ orgId: string }> };

export default async function UsersSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { org, user, role, canWrite } = await getOrgContext(orgId);
  const isAdmin = isAdminRole(role);

  const [members, invitations, hasViewSeats, mfaUserIds, away, permissions] = await Promise.all([
    listMembers(orgId),
    isAdmin ? listPendingInvitations(orgId) : Promise.resolve([]),
    isAdmin ? orgHasFeature(orgId, "view_seats") : Promise.resolve(false),
    isAdmin ? listMembersWithMfa(orgId) : Promise.resolve([]),
    // HEB-08: who is away today, with the deputy
    getCurrentAbsences(orgId, org.timeZone),
    // PRM-01: extra permissions, for owners and admins
    isAdmin ? getMemberPermissions(orgId) : Promise.resolve(new Map<string, string[]>()),
  ]);
  const permissionCounts = Object.fromEntries([...permissions].map(([userId, keys]) => [userId, keys.length]));
  const absences = Object.fromEntries(
    [...away.values()].map((a) => [a.userId, { label: `${absenceLabel(a.kind)} עד ${shortDay(a.endsOn)}`, deputyName: a.deputyId ? (a.deputyName ?? "משתמש") : null }]),
  );
  const roles = assignableRoles(role, hasViewSeats);
  const transferCandidates = members
    .filter((member) => member.userId !== user.id && member.status === "active" && member.seatType === "full")
    .map((member) => ({ userId: member.userId, name: member.name }));

  return (
    <div className="space-y-5">
      {isAdmin && canWrite ? (
        <Card aria-labelledby="invite-title">
          <CardHeader id="invite-title" title="הזמנת משתמש" />
          <CardBody>
            <InviteForm orgId={orgId} orgName={org.name} roles={roles} />
          </CardBody>
        </Card>
      ) : null}

      {invitations.length > 0 ? (
        <Card aria-labelledby="pending-title">
          <CardHeader id="pending-title" title={`הזמנות ממתינות (${invitations.length})`} />
          <PendingInvitations
            orgId={orgId}
            canWrite={canWrite}
            invitations={invitations.map((invitation) => ({
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              expiresText: formatDate(invitation.expiresAt),
            }))}
          />
        </Card>
      ) : null}

      <Card aria-labelledby="members-title">
        <CardHeader id="members-title" title={`משתמשים (${members.length})`} />
        <MembersList orgId={orgId} myUserId={user.id} myRole={role} roles={roles} canWrite={canWrite} members={members} mfaUserIds={mfaUserIds} absences={absences} permissionCounts={permissionCounts} />
      </Card>

      {role === "owner" && canWrite ? (
        <Card aria-labelledby="transfer-title">
          <CardHeader id="transfer-title" title="העברת בעלות" />
          <CardBody>
            <TransferOwnershipForm orgId={orgId} candidates={transferCandidates} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
