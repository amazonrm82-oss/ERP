import { beforeEach, describe, expect, it, vi } from "vitest";

// TASK-07: "team, no owner" on the new-task form, and "לקחתי". The database rules are in tests/db/191-team-tasks.

const ORG = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";

let inserted: Record<string, unknown> | null = null;
let rpcAnswer: { data: unknown; error: { code: string; message: string; hint?: string } | null } = { data: null, error: null };

const supabase = {
  from: () => ({
    insert: (row: Record<string, unknown>) => {
      inserted = row;
      return { select: () => ({ single: async () => ({ data: { id: TASK }, error: null }) }) };
    },
  }),
  rpc: async () => rpcAnswer,
};

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/action-context", () => ({ actionContext: async () => ({ ok: true, supabase, userId: "u1" }) }));
vi.mock("@/features/task-checklists/server", () => ({ stepsForNewTask: async () => ({ ok: true }) }));

const { createTaskAction, takeTaskAction } = await import("@/features/tasks/actions");

const form = (owner: string) => {
  const data = new FormData();
  data.set("title", "לחזור ללקוח");
  data.set("owner_id", owner);
  return data;
};

beforeEach(() => {
  inserted = null;
  rpcAnswer = { data: null, error: null };
});

describe("a new task for a team (TASK-07)", () => {
  it("'team:<id>' sends the team and no owner", async () => {
    expect(await createTaskAction(ORG, null, form(`team:${TEAM}`))).toEqual({ ok: true });
    expect(inserted).toMatchObject({ organization_id: ORG, team_id: TEAM });
    expect(inserted).not.toHaveProperty("owner_id");
  });

  it("a person is sent as before, with no team", async () => {
    await createTaskAction(ORG, null, form(TEAM));
    expect(inserted).toMatchObject({ owner_id: TEAM });
    expect(inserted).not.toHaveProperty("team_id");
  });

  it("a broken team choice is refused before the database", async () => {
    const result = await createTaskAction(ORG, null, form("team:not-a-uuid"));
    expect(result).toMatchObject({ ok: false, fieldErrors: { owner_id: "יש לבחור אחראי או צוות מהרשימה." } });
    expect(inserted).toBeNull();
  });
});

describe("taking a team task (TASK-07)", () => {
  it("the first one gets it", async () => {
    rpcAnswer = { data: { ok: true, owner_id: "u1" }, error: null };
    expect(await takeTaskAction(ORG, TASK)).toEqual({ ok: true, message: "המשימה עכשיו באחריותך." });
  });

  it("each refusal has its own words", async () => {
    for (const [reason, message] of [
      ["taken", "מישהו אחר מהצוות כבר לקח את המשימה."],
      ["closed", "המשימה כבר נסגרה."],
      ["lead", "זו משימת חזרה לליד: לוקחים את הליד עצמו, והמשימה עוברת איתו."],
    ]) {
      rpcAnswer = { data: { ok: false, reason }, error: null };
      expect(await takeTaskAction(ORG, TASK), reason).toEqual({ ok: false, message });
    }
  });

  it("someone outside the team gets the plain 'not found or not permitted'", async () => {
    rpcAnswer = { data: null, error: { code: "42501", message: "not permitted" } };
    const result = await takeTaskAction(ORG, TASK);
    expect(result.ok).toBe(false);
    const { NOT_FOUND_OR_FORBIDDEN } = await import("@/lib/errors");
    expect(result).toEqual({ ok: false, message: NOT_FOUND_OR_FORBIDDEN });
  });
});

describe("who may give a team a task and take it (TASK-07, = app.may_assign_team_task)", async () => {
  const { teamsForTaskRights } = await import("@/features/tasks/team-rights");
  // a chain of eleven teams, t0 at the top; and a team of its own
  const chain = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, parentId: i === 0 ? null : `t${i - 1}` }));
  const teams = [...chain, { id: "solo", parentId: null }];
  const sorted = (set: Set<string>) => [...set].sort();

  it("owners and admins: every team; viewers and strangers: none", () => {
    for (const role of ["owner", "admin"]) expect(teamsForTaskRights(role, teams, []).size).toBe(teams.length);
    for (const role of ["viewer", null]) expect(teamsForTaskRights(role, teams, [{ teamId: "solo", isManager: true }]).size).toBe(0);
  });

  it("members: only the teams they are in, never the ones below", () => {
    expect(sorted(teamsForTaskRights("member", teams, [{ teamId: "t0", isManager: true }]))).toEqual(["t0"]);
  });

  it("managers: their teams, and the teams below one they manage, ten levels as the database", () => {
    // t0 managed: t0 itself and t1..t9 (nine parents up from t9 reach t0); t10 is eleven levels down
    const rights = teamsForTaskRights("manager", teams, [{ teamId: "t0", isManager: true }, { teamId: "solo", isManager: false }]);
    expect(sorted(rights)).toEqual(["solo", "t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    // a plain member of a team does not manage the ones below it
    expect(sorted(teamsForTaskRights("manager", teams, [{ teamId: "t5", isManager: false }]))).toEqual(["t5"]);
  });
});
