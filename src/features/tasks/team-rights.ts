/**
 * TASK-07: the teams a person may give a task to with no owner, and take such a task from. The rule of
 * app.may_assign_team_task in the database (migration team_tasks), which public.take_task and the insert trigger use;
 * keep the two in step: an owner or admin, every team; a manager, a team they manage directly or through a parent team
 * (app.manages_team, ten levels up); a manager or member, a team they are in; a viewer, none.
 */
export type TeamRow = { id: string; parentId: string | null };
export type TeamMembership = { teamId: string; isManager: boolean };

const MAX_LEVELS = 10;

export function teamsForTaskRights(role: string | null, teams: TeamRow[], memberships: TeamMembership[]): Set<string> {
  if (role === "owner" || role === "admin") return new Set(teams.map((team) => team.id));
  if (role !== "manager" && role !== "member") return new Set();
  const result = new Set(memberships.map((m) => m.teamId));
  if (role === "manager") {
    const managed = new Set(memberships.filter((m) => m.isManager).map((m) => m.teamId));
    const parentOf = new Map(teams.map((team) => [team.id, team.parentId]));
    for (const team of teams) {
      // the team itself and up to nine parents above it, as the database's chain
      let current: string | null = team.id;
      for (let level = 1; current !== null && level <= MAX_LEVELS; level += 1) {
        if (managed.has(current)) {
          result.add(team.id);
          break;
        }
        current = parentOf.get(current) ?? null;
      }
    }
  }
  return result;
}
