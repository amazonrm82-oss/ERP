import "server-only";

import type { OrgContext } from "@/features/shell/queries";

import type { ViewChip } from "./components/saved-views-bar";
import { listSavedViews, listShareTeams, type ShareTeam } from "./queries";
import type { ViewObject } from "./types";

/** Saved views of a list as chips, with who may delete which, and the teams a new view can be shared with. */
export async function viewChips(orgId: string, objectType: ViewObject, context: OrgContext): Promise<{ chips: ViewChip[]; teams: ShareTeam[] }> {
  const isAdmin = context.role === "owner" || context.role === "admin";
  const [views, teams] = await Promise.all([listSavedViews(orgId, objectType), listShareTeams(orgId, context.user.id, isAdmin)]);
  const teamName = new Map(teams.map((team) => [team.id, team.name]));
  return {
    teams,
    chips: views.map((view) => ({
      id: view.id,
      name: view.name,
      shared: view.scope === "org" ? "לכולם" : view.scope === "team" ? (teamName.get(view.teamId ?? "") ?? "לצוות") : null,
      deletable: view.ownerId === context.user.id || isAdmin,
      config: view.config,
    })),
  };
}
