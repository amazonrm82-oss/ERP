import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ChevronIcon } from "@/components/ui/icons";
import {
  AddTeamMemberForm,
  DeleteTeamButton,
  RenameTeamForm,
  TeamMembersList,
} from "@/features/settings/components/team-forms";
import { isAdminRole } from "@/features/settings/permissions";
import { getTeam, listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "צוות" };

type Props = { params: Promise<{ orgId: string; teamId: string }> };

export default async function TeamSettingsPage({ params }: Props) {
  const { orgId, teamId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isUuid(teamId)) {
    notFound();
  }
  const [team, members] = await Promise.all([getTeam(orgId, teamId), listMembers(orgId)]);
  if (!team) {
    notFound();
  }
  const editable = isAdminRole(role) && canWrite;
  const inTeam = new Set(team.members.map((member) => member.userId));
  const candidates = members
    .filter((member) => member.status === "active" && !inTeam.has(member.userId))
    .map((member) => ({ userId: member.userId, name: member.name }));

  return (
    <div className="space-y-5">
      <div>
        <Link href={paths.settingsTeams(orgId)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <ChevronIcon className="size-4 rtl:rotate-180" />
          כל הצוותים
        </Link>
        <h2 className="text-xl font-semibold break-words">{team.name}</h2>
      </div>

      {editable ? (
        <Card aria-labelledby="team-name-title">
          <CardHeader id="team-name-title" title="שם הצוות" />
          <CardBody>
            <RenameTeamForm orgId={orgId} team={team} />
          </CardBody>
        </Card>
      ) : null}

      <Card aria-labelledby="team-members-title">
        <CardHeader id="team-members-title" title={`חברי הצוות (${team.members.length})`} />
        <TeamMembersList orgId={orgId} teamId={team.id} members={team.members} editable={editable} />
      </Card>

      {editable ? (
        <Card aria-labelledby="add-member-title">
          <CardHeader id="add-member-title" title="הוספת משתמש לצוות" />
          <CardBody>
            <AddTeamMemberForm key={team.members.length} orgId={orgId} teamId={team.id} candidates={candidates} />
          </CardBody>
        </Card>
      ) : null}

      {editable ? <DeleteTeamButton orgId={orgId} teamId={team.id} teamName={team.name} /> : null}
    </div>
  );
}
