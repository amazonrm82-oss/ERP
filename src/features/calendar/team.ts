// CAL-04: the team calendar. Which teams the filter offers, who belongs to a
// team (with its sub-teams), whose columns the side-by-side view shows, and the
// items of each person. Pure, so it is unit-tested. None of this widens access:
// the items themselves are read with the user's session and RLS decides.

import type { RecordVisibility } from "@/lib/database.types";

export type CalendarTeam = { id: string; name: string; parentId: string | null };
export type TeamMembership = { teamId: string; userId: string; isManager: boolean };
export type CalendarPerson = { id: string; name: string };

// the side-by-side view shows at most this many people at once
export const PEOPLE_MAX = 8;
// a team chain deeper than this is not followed (matches app.manages_team)
const MAX_DEPTH = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The team and every team under it, at any depth. */
export function teamWithDescendants(teamId: string, teams: CalendarTeam[]): Set<string> {
  const found = new Set([teamId]);
  let frontier = [teamId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next = teams.filter((team) => team.parentId !== null && frontier.includes(team.parentId) && !found.has(team.id)).map((team) => team.id);
    for (const id of next) found.add(id);
    frontier = next;
  }
  return found;
}

/**
 * The teams the team filter offers (owner, 12 October 2026: by the
 * organization's record visibility). Owners and admins get every team; so does
 * everyone in an organization whose records are visible to all ("org"). With
 * visibility "team" or "own", each user gets only the teams they sit in (as a
 * member or as its manager), without the teams under them. Sorted by name.
 * This only narrows whose items are read; RLS still decides what is shown.
 */
export function visibleTeams(
  teams: CalendarTeam[],
  memberships: TeamMembership[],
  userId: string,
  viewer: { isAdmin: boolean; visibility: RecordVisibility },
): CalendarTeam[] {
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name, "he"));
  if (viewer.isAdmin || viewer.visibility === "org") return sorted;
  const ids = new Set(memberships.filter((row) => row.userId === userId).map((row) => row.teamId));
  return sorted.filter((team) => ids.has(team.id));
}

/** The people of a team and its sub-teams, in the order of `people` (only people listed there). */
export function teamPeople<P extends { id: string }>(teamId: string, teams: CalendarTeam[], memberships: TeamMembership[], people: P[]): P[] {
  const inTeams = teamWithDescendants(teamId, teams);
  const ids = new Set(memberships.filter((row) => inTeams.has(row.teamId)).map((row) => row.userId));
  return people.filter((person) => ids.has(person.id));
}

/** The `p` values of the URL: ids only, each once, in the order given. */
export function parsePeople(value: string | string[] | undefined): string[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return [...new Set(list.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()).filter((v) => UUID.test(v)))];
}

/**
 * Whose columns the side-by-side view shows, from the people the user may
 * pick (`pool`, in display order). The ones asked for in the URL when any of
 * them is in the pool; otherwise the default: the user first, then the people
 * of the user's own teams, and when that is the user alone, the whole pool.
 * At most PEOPLE_MAX; `more` says the list was cut.
 */
export function pickPeople<P extends { id: string }>(input: {
  requested: string[];
  pool: P[];
  me: string;
  // people who share a team with the user (any order)
  teammates: string[];
  // a team is chosen: the default is the whole pool, without putting the user first
  teamChosen: boolean;
}): { people: P[]; more: boolean } {
  const { requested, pool, me, teammates, teamChosen } = input;
  const asked = new Set(requested);
  let chosen = pool.filter((person) => asked.has(person.id));
  if (chosen.length === 0) {
    if (teamChosen) {
      chosen = pool;
    } else {
      const mates = new Set(teammates);
      const mine = pool.filter((person) => person.id === me);
      const others = pool.filter((person) => person.id !== me && mates.has(person.id));
      chosen = others.length > 0 ? [...mine, ...others] : [...mine, ...pool.filter((person) => person.id !== me)];
    }
  }
  return { people: chosen.slice(0, PEOPLE_MAX), more: chosen.length > PEOPLE_MAX };
}

/** The people who share at least one team with the user (not the user). */
export function teammatesOf(userId: string, memberships: TeamMembership[]): string[] {
  const mine = new Set(memberships.filter((row) => row.userId === userId).map((row) => row.teamId));
  return [...new Set(memberships.filter((row) => mine.has(row.teamId) && row.userId !== userId).map((row) => row.userId))];
}

/** Each person's items, in the order of `people`. An item that belongs to two people is in both lists. */
export function itemsByPerson<T extends { people: string[] }>(items: T[], people: { id: string }[]): Map<string, T[]> {
  const byPerson = new Map(people.map((person) => [person.id, [] as T[]]));
  for (const item of items) {
    for (const id of item.people) byPerson.get(id)?.push(item);
  }
  return byPerson;
}
