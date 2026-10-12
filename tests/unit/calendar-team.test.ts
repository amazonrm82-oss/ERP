import { describe, expect, it } from "vitest";

import { calendarPath, stepDay, viewDays, viewTitle } from "@/features/calendar/range";
import {
  itemsByPerson,
  parsePeople,
  PEOPLE_MAX,
  pickPeople,
  teammatesOf,
  teamPeople,
  teamWithDescendants,
  visibleTeams,
  type CalendarTeam,
  type TeamMembership,
} from "@/features/calendar/team";
import { longDay } from "@/lib/calendar-grid";

// CAL-04: the team calendar's pure logic

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ME, ANA, BEN, DAN, ERAN] = [1, 2, 3, 4, 5].map(id);

// sales (north under it, and north-east under that) and service
const teams: CalendarTeam[] = [
  { id: "sales", name: "מכירות", parentId: null },
  { id: "north", name: "צפון", parentId: "sales" },
  { id: "ne", name: "צפון מזרח", parentId: "north" },
  { id: "service", name: "שירות", parentId: null },
];
const people = [ME, ANA, BEN, DAN, ERAN].map((p, i) => ({ id: p, name: `אדם ${i}` }));

describe("teams of the filter", () => {
  it("a team includes its sub-teams at any depth", () => {
    expect([...teamWithDescendants("sales", teams)].sort()).toEqual(["ne", "north", "sales"]);
    expect([...teamWithDescendants("north", teams)].sort()).toEqual(["ne", "north"]);
    expect([...teamWithDescendants("service", teams)]).toEqual(["service"]);
  });

  it("stops on a loop instead of running forever", () => {
    const loop: CalendarTeam[] = [
      { id: "a", name: "a", parentId: "b" },
      { id: "b", name: "b", parentId: "a" },
    ];
    expect([...teamWithDescendants("a", loop)].sort()).toEqual(["a", "b"]);
  });

  // owner, 12 October 2026: the teams offered follow the organization's record visibility
  const rows: TeamMembership[] = [
    { teamId: "sales", userId: ME, isManager: true },
    { teamId: "service", userId: ANA, isManager: false },
    { teamId: "north", userId: BEN, isManager: false },
  ];
  const ALL = ["sales", "north", "ne", "service"];
  const VISIBILITIES = ["org", "team", "own"] as const;

  it("owners and admins get every team, by name, whatever the visibility", () => {
    for (const visibility of VISIBILITIES) {
      expect(visibleTeams(teams, rows, ME, { isAdmin: true, visibility }).map((t) => t.id)).toEqual(ALL);
      // an admin who sits in no team
      expect(visibleTeams(teams, rows, DAN, { isAdmin: true, visibility }).map((t) => t.id)).toEqual(ALL);
    }
  });

  it('with visibility "org" everyone gets every team: a manager, a member, someone in no team', () => {
    for (const user of [ME, ANA, BEN, DAN]) {
      expect(visibleTeams(teams, rows, user, { isAdmin: false, visibility: "org" }).map((t) => t.id)).toEqual(ALL);
    }
  });

  it('with visibility "team" or "own" each user gets only the teams they sit in', () => {
    for (const visibility of ["team", "own"] as const) {
      const viewer = { isAdmin: false, visibility };
      // a manager of a parent team gets that team only, not the teams under it
      expect(visibleTeams(teams, rows, ME, viewer).map((t) => t.id)).toEqual(["sales"]);
      expect(visibleTeams(teams, rows, ANA, viewer).map((t) => t.id)).toEqual(["service"]);
      // a member of a parent team does not get its sub-teams either
      expect(visibleTeams(teams, rows, BEN, viewer).map((t) => t.id)).toEqual(["north"]);
      expect(visibleTeams(teams, rows, DAN, viewer)).toEqual([]);
    }
  });

  it("someone in two teams gets both, by name", () => {
    const two: TeamMembership[] = [
      { teamId: "service", userId: ANA, isManager: false },
      { teamId: "ne", userId: ANA, isManager: true },
    ];
    expect(visibleTeams(teams, two, ANA, { isAdmin: false, visibility: "team" }).map((t) => t.id)).toEqual(["ne", "service"]);
  });

  it("a team's people include the sub-teams' people, in the given order, once each", () => {
    const rows: TeamMembership[] = [
      { teamId: "ne", userId: DAN, isManager: false },
      { teamId: "sales", userId: ANA, isManager: true },
      { teamId: "north", userId: ANA, isManager: false },
      { teamId: "service", userId: BEN, isManager: false },
    ];
    expect(teamPeople("sales", teams, rows, people).map((p) => p.id)).toEqual([ANA, DAN]);
    expect(teamPeople("service", teams, rows, people).map((p) => p.id)).toEqual([BEN]);
    // someone who is not an active member (not in the list) is left out
    expect(teamPeople("ne", teams, rows, people.filter((p) => p.id !== DAN))).toEqual([]);
  });

  it("teammates are the people who share a team with the user", () => {
    const rows: TeamMembership[] = [
      { teamId: "sales", userId: ME, isManager: false },
      { teamId: "sales", userId: ANA, isManager: false },
      { teamId: "service", userId: ME, isManager: false },
      { teamId: "service", userId: ANA, isManager: false },
      { teamId: "north", userId: BEN, isManager: false },
    ];
    expect(teammatesOf(ME, rows)).toEqual([ANA]);
    expect(teammatesOf(DAN, rows)).toEqual([]);
  });
});

describe("people of the side-by-side view", () => {
  it("reads ids from the URL, once each, ignoring anything else", () => {
    expect(parsePeople([ANA, "x", ANA.toUpperCase(), BEN])).toEqual([ANA, BEN]);
    expect(parsePeople(`${ANA},${BEN}`)).toEqual([ANA, BEN]);
    expect(parsePeople(undefined)).toEqual([]);
    expect(parsePeople("all")).toEqual([]);
  });

  it("shows the people asked for, but only from the pool", () => {
    const pool = people.filter((p) => p.id !== ERAN);
    const picked = pickPeople({ requested: [BEN, ERAN], pool, me: ME, teammates: [], teamChosen: false });
    expect(picked.people.map((p) => p.id)).toEqual([BEN]);
    expect(picked.more).toBe(false);
  });

  it("by default: me first, then my teammates; when I have none, everyone", () => {
    expect(pickPeople({ requested: [], pool: people, me: ME, teammates: [DAN, ANA], teamChosen: false }).people.map((p) => p.id)).toEqual([ME, ANA, DAN]);
    expect(pickPeople({ requested: [], pool: people, me: ME, teammates: [], teamChosen: false }).people.map((p) => p.id)).toEqual([ME, ANA, BEN, DAN, ERAN]);
  });

  it("with a team chosen, the default is the whole team", () => {
    const pool = [people[2], people[3]];
    expect(pickPeople({ requested: [], pool, me: ME, teammates: [ANA], teamChosen: true }).people.map((p) => p.id)).toEqual([BEN, DAN]);
    expect(pickPeople({ requested: [ANA], pool, me: ME, teammates: [], teamChosen: true }).people.map((p) => p.id)).toEqual([BEN, DAN]);
  });

  it("cuts at the maximum and says so", () => {
    const many = Array.from({ length: PEOPLE_MAX + 3 }, (_, i) => ({ id: id(100 + i), name: String(i) }));
    const picked = pickPeople({ requested: [], pool: many, me: ME, teammates: [], teamChosen: false });
    expect(picked.people).toHaveLength(PEOPLE_MAX);
    expect(picked.more).toBe(true);
  });

  it("puts an item in the column of each person it belongs to", () => {
    const items = [
      { id: "m1", people: [ANA, BEN] },
      { id: "t1", people: [BEN] },
      { id: "x", people: [ERAN] },
    ];
    const byPerson = itemsByPerson(items, [{ id: ANA }, { id: BEN }, { id: DAN }]);
    expect(byPerson.get(ANA)?.map((i) => i.id)).toEqual(["m1"]);
    expect(byPerson.get(BEN)?.map((i) => i.id)).toEqual(["m1", "t1"]);
    expect(byPerson.get(DAN)).toEqual([]);
    expect(byPerson.has(ERAN)).toBe(false);
  });
});

describe("the side-by-side view's days and address", () => {
  it("is one day, steps a day at a time, and is titled like a day", () => {
    expect(viewDays("people", "2026-10-12")).toEqual(["2026-10-12"]);
    expect(stepDay("people", "2026-10-31", 1)).toBe("2026-11-01");
    expect(stepDay("people", "2026-10-01", -1)).toBe("2026-09-30");
    expect(viewTitle("people", "2026-10-12")).toBe(longDay("2026-10-12"));
  });

  it("keeps the team and each picked person in the address", () => {
    expect(calendarPath("o1", { view: "people", team: "t1", people: [ANA, BEN] })).toBe(`/o/o1/calendar?view=people&team=t1&p=${ANA}&p=${BEN}`);
    expect(calendarPath("o1", { view: "people", people: [] })).toBe("/o/o1/calendar?view=people");
  });
});
