// CAP-06: which team a user's new records join. Mirrors app.default_team()
// (migration "primary_team"): the only team when the user is in exactly one,
// else the team marked primary, else none. Keep the two in step.

export type TeamMembershipRow = { team_id: string; user_id: string; is_primary: boolean };

/** The team new records of this user join, or null when none is picked. */
export function recordTeamOf(rows: readonly TeamMembershipRow[], userId: string): string | null {
  const own = rows.filter((row) => row.user_id === userId);
  if (own.length === 1) {
    return own[0].team_id;
  }
  return own.find((row) => row.is_primary)?.team_id ?? null;
}

export type PrimaryTeamState = {
  /** Teams the user belongs to in this organization. */
  teamCount: number;
  /** This team is the one their new records join (explicitly or as their only team). */
  joinsThisTeam: boolean;
  /** This team is marked primary. */
  isPrimary: boolean;
  /** In several teams and none is primary: new records get no team. */
  noRecordTeam: boolean;
};

export function primaryTeamState(rows: readonly TeamMembershipRow[], userId: string, teamId: string): PrimaryTeamState {
  const own = rows.filter((row) => row.user_id === userId);
  const recordTeam = recordTeamOf(rows, userId);
  return {
    teamCount: own.length,
    joinsThisTeam: recordTeam === teamId,
    isPrimary: own.some((row) => row.team_id === teamId && row.is_primary),
    noRecordTeam: own.length > 1 && recordTeam === null,
  };
}
