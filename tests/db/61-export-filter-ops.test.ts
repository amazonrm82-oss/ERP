import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string };

// RVW-4 follow-up (0088): a list export keeps a filter value only when it fits its operator.
describe("a list export keeps a filter value only when it fits its operator", () => {
  let owner: U;
  let org: string;
  const uuid = "8c0b6c2e-6f43-4d3e-9a41-222222222222";

  beforeAll(async () => {
    owner = await createUser("rvw4-ops-owner");
    org = await createOrg(owner.id);
  });

  type Cond = { field: string; op: string; value?: unknown };
  /** Logs an export whose filter has these conditions and returns the conditions as stored. */
  const stored = async (conditions: Cond[]): Promise<Cond[]> => {
    const f = { match: "all", groups: [{ match: "all", conditions }] };
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'deal', 'csv', 1, 'filtered', $2)", [org, JSON.stringify({ f: JSON.stringify(f) })]));
    return asAdmin(async (q) =>
      (await q<{ c: Cond[] }>("select changes #> '{filters,f,groups,0,conditions}' as c from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1", [org])).rows[0].c,
    );
  };
  // a group keeps at most 10 conditions, so longer lists go in several exports
  const values = async (op: string, inputs: unknown[], field = "x") => {
    const out: unknown[] = [];
    for (let i = 0; i < inputs.length; i += 10) {
      out.push(...(await stored(inputs.slice(i, i + 10).map((value) => ({ field, op, value })))).map((c) => c.value));
    }
    return out;
  };

  it("the three examples of the review are not kept", async () => {
    const out = await stored([
      { field: "amount", op: "gt", value: "0501234567" },
      { field: "created", op: "last_days", value: "password_123" },
      { field: "status", op: "is", value: "johnsmith" },
    ]);
    expect(out.map((c) => c.value)).toEqual([true, true, true]);
    expect(JSON.stringify(out)).not.toMatch(/0501234567|password|johnsmith/);
  });

  it("day counts: 1 to 4 digits only", async () => {
    for (const op of ["last_days", "older_than_days", "idle_days"]) {
      expect(await values(op, ["7", "3650", "0", "12345", "2026-10-01", "-1", "7 ", "abc", uuid])).toEqual(["7", "3650", "0", true, true, true, true, true, true]);
    }
  });

  it("dates: a date only", async () => {
    for (const op of ["on_or_after", "before"]) {
      expect(await values(op, ["2026-10-01", "7", "0501234567", "abc", uuid, "2026-10-01T00:00"])).toEqual(["2026-10-01", true, true, true, true, true]);
    }
  });

  it("number comparisons: an ordinary number, not a phone or an id number", async () => {
    for (const op of ["gt", "lt"]) {
      expect(await values(op, ["1500", "1500.5", "-3", "0", "0.25", "99999999", "0501234567", "123456789", "1,000", "abc", "2026-10-01"])).toEqual([
        "1500",
        "1500.5",
        "-3",
        "0",
        "0.25",
        "99999999",
        true,
        true,
        true,
        true,
        true,
      ]);
    }
  });

  it("choices: an id, 'me' or a built-in plain value; any other word becomes true", async () => {
    for (const op of ["is", "is_not", "has", "has_not"]) {
      expect(await values(op, [uuid, uuid.toUpperCase(), "me", "won", "follow_up", "real_estate", "2", "johnsmith", "0501234567", "12", "2026-10-01", "זהב"])).toEqual([
        uuid,
        uuid.toUpperCase(),
        "me",
        "won",
        "follow_up",
        "real_estate",
        "2",
        true,
        true,
        true,
        true,
        true,
      ]);
    }
    // several choices: kept only when every one fits
    expect(await values("has", [[uuid], [uuid, "johnsmith"], [uuid, 5]])).toEqual([[uuid], true, true]);
  });

  it("typed text, operators that take no value and unknown operators keep no value", async () => {
    for (const op of ["contains", "not_contains", "equals", "empty", "not_empty", "this_week", "this_month", "is_true", "is_false", "between", "matches"]) {
      expect(await values(op, ["7", uuid, "2026-10-01", "me", "won"])).toEqual([true, true, true, true, true]);
    }
    // an array under a day, date or number operator
    for (const op of ["last_days", "before", "gt"]) {
      expect(await values(op, [["7"]])).toEqual([true]);
    }
  });

  it("a condition without a value stays without one; odd values never raise", async () => {
    expect(await stored([{ field: "email", op: "not_empty" }])).toEqual([{ field: "email", op: "not_empty" }]);
    expect(await values("gt", [null, 5, true, {}, [], "", "1e5", "NaN"])).toEqual([undefined, true, true, true, true, true, true, true]);
    expect(await values("is", [[], Array(30).fill(uuid), ""])).toEqual([true, true, true]);
  });

  it("the helpers are not reachable from the API", async () => {
    for (const sql of ["select app.export_choice_values()", "select app.export_op_value_ok('1', 'gt')", "select app.export_filter_value('\"1\"', 'gt')"]) {
      await expect(asUser(owner.id, (q) => q(sql))).rejects.toMatchObject({ code: "42501" });
    }
  });
});
