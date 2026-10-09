import type { Metadata } from "next";
import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { ForwardIcon, UsersIcon } from "@/components/ui/icons";
import { CreateTeamForm } from "@/features/settings/components/team-forms";
import { isAdminRole } from "@/features/settings/permissions";
import { listTeams } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "צוותים" };

type Props = { params: Promise<{ orgId: string }> };

export default async function TeamsSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const teams = await listTeams(orgId);
  const editable = isAdminRole(role) && canWrite;

  return (
    <div className="space-y-5">
      {editable ? (
        <Card aria-labelledby="new-team-title">
          <CardHeader id="new-team-title" title="צוות חדש" />
          <CardBody>
            <CreateTeamForm orgId={orgId} />
          </CardBody>
        </Card>
      ) : null}

      <Card aria-labelledby="teams-title">
        <CardHeader id="teams-title" title="צוותים" />
        {teams.length === 0 ? (
          <EmptyState icon={<UsersIcon />}
            title="אין עדיין צוותים"
            description="צוותים מאפשרים למנהל צוות לראות ולערוך את הרשומות של אנשי הצוות שלו."
          />
        ) : (
          <ul className="divide-y divide-line">
            {teams.map((team) => (
              <li key={team.id}>
                <Link
                  href={paths.settingsTeam(orgId, team.id)}
                  className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-canvas sm:px-5"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{team.name}</span>
                    <span className="block text-sm text-ink-soft">
                      {team.memberCount === 1 ? "משתמש אחד" : `${team.memberCount} משתמשים`}
                      {team.managerNames.length > 0 ? ` · ניהול: ${team.managerNames.join(", ")}` : ""}
                    </span>
                  </span>
                  <ForwardIcon className="size-5 shrink-0 text-ink-soft" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
