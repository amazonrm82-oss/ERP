import { describe, expect, it } from "vitest";

import { filterFields, filterToPostgrest } from "@/features/list-filters/server";
import type { FilterTree } from "@/features/list-filters/model";
import type { FieldDefinition } from "@/features/custom-fields/types";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STATUS = "33333333-3333-4333-8333-333333333333";
const TAG = "44444444-4444-4444-8444-444444444444";
// Wednesday 15 July 2026, 10:00 in Jerusalem
const ctx = { userId: USER, now: new Date("2026-07-15T07:00:00Z") };

const customField = (key: string, type: FieldDefinition["type"], options: string[] = []): FieldDefinition => ({
  id: key,
  key,
  label: key,
  type,
  options,
  isRequired: false,
  isActive: true,
  helpText: null,
});

const leadFields = filterFields("lead", {
  statuses: [{ value: STATUS, label: "חדש" }],
  sources: [],
  members: [{ value: OTHER, label: "דנה" }],
  tags: [{ value: TAG, label: "VIP" }],
  fields: [customField("budget", "number"), customField("size", "select", ["קטן", "גדול"]), customField("vip", "checkbox"), customField("renewal", "date")],
});

const one = (field: string, op: string, value = "") => filterToPostgrest({ match: "all", groups: [{ match: "all", conditions: [{ field, op, value }] }] } as FilterTree, leadFields, ctx);

describe("filterToPostgrest", () => {
  it("text conditions are quoted, so commas and parentheses stay inside the value", () => {
    expect(one("name", "contains", "כהן, (בע\"מ)").logic).toBe('and(and(full_name.ilike."*כהן, (בעמ)*"))');
    expect(one("name", "equals", "a*b%c_d").logic).toBe('and(and(full_name.ilike."abcd"))');
    expect(one("email", "empty").logic).toBe('and(and(or(email.is.null,email.eq."")))');
  });

  it("list fields accept only their own choices", () => {
    expect(one("status", "is", STATUS).logic).toBe(`and(and(status_id.eq.${STATUS}))`);
    expect(one("status", "is", OTHER)).toEqual({ logic: null, skipped: 1 });
    expect(one("status", "is", "x),id.neq.(0")).toEqual({ logic: null, skipped: 1 });
    expect(one("owner", "is", "me").logic).toBe(`and(and(owner_id.eq.${USER}))`);
    expect(one("owner", "is_not", OTHER).logic).toBe(`and(and(or(owner_id.is.null,owner_id.neq.${OTHER})))`);
    expect(one("tag", "has", TAG).logic).toBe(`and(and(tag_ids.cs.{${TAG}}))`);
    expect(one("tag", "has", OTHER).skipped).toBe(1);
  });

  it("an unknown field, an operator of another kind or a missing value is skipped", () => {
    expect(one("nope", "contains", "x").skipped).toBe(1);
    expect(one("name", "gt", "5").skipped).toBe(1);
    expect(one("name", "contains", "  ").skipped).toBe(1);
  });

  it("custom fields read the JSON column", () => {
    expect(one("cf:budget", "gt", "1,000").logic).toBe("and(and(custom_fields->budget.gt.1000))");
    expect(one("cf:budget", "gt", "abc").skipped).toBe(1);
    expect(one("cf:size", "is", "גדול").logic).toBe('and(and(custom_fields->>size.eq."גדול"))');
    expect(one("cf:size", "is", "בינוני").skipped).toBe(1);
    expect(one("cf:vip", "is_false").logic).toBe("and(and(or(custom_fields->vip.is.null,custom_fields->vip.eq.false)))");
    expect(one("cf:renewal", "before", "2026-08-01").logic).toBe('and(and(custom_fields->>renewal.lt."2026-08-01"))');
  });

  it("dates are whole days in Jerusalem", () => {
    expect(one("created", "on_or_after", "2026-07-01").logic).toBe('and(and(created_at.gte."2026-06-30T21:00:00.000Z"))');
    expect(one("created", "last_days", "7").logic).toBe('and(and(and(created_at.gte."2026-07-07T21:00:00.000Z",created_at.lt."2026-07-15T21:00:00.000Z")))');
    // the week starts on Sunday 12 July
    expect(one("created", "this_week").logic).toBe('and(and(and(created_at.gte."2026-07-11T21:00:00.000Z",created_at.lt."2026-07-18T21:00:00.000Z")))');
    expect(one("created", "this_month").logic).toBe('and(and(and(created_at.gte."2026-06-30T21:00:00.000Z",created_at.lt."2026-07-31T21:00:00.000Z")))');
    expect(one("created", "last_days", "99999").skipped).toBe(1);
    expect(one("created", "on_or_after", "1/7/2026").skipped).toBe(1);
  });

  it("this month in October starts in summer time and ends in winter time", () => {
    const october = filterToPostgrest(
      { match: "all", groups: [{ match: "all", conditions: [{ field: "created", op: "this_month", value: "" }] }] } as FilterTree,
      leadFields,
      { ...ctx, now: new Date("2026-10-20T09:00:00Z") },
    );
    expect(october.logic).toBe('and(and(and(created_at.gte."2026-09-30T21:00:00.000Z",created_at.lt."2026-10-31T22:00:00.000Z")))');
  });

  it("groups join with all / any, and skipped conditions are counted", () => {
    const tree = {
      match: "any",
      groups: [
        { match: "all", conditions: [{ field: "name", op: "contains", value: "א" }, { field: "nope", op: "is", value: "x" }] },
        { match: "any", conditions: [{ field: "owner", op: "empty", value: "" }] },
      ],
    } as FilterTree;
    expect(filterToPostgrest(tree, leadFields, ctx)).toEqual({ logic: 'or(and(full_name.ilike."*א*"),or(owner_id.is.null))', skipped: 1 });
  });

  it("deal amounts are typed in shekels and compared in agorot", () => {
    const dealFields = filterFields("deal", { stages: [], members: [], tags: [], fields: [] });
    const tree = { match: "all", groups: [{ match: "all", conditions: [{ field: "amount", op: "gt", value: "1,500.5" }, { field: "status", op: "is", value: "won" }] }] } as FilterTree;
    expect(filterToPostgrest(tree, dealFields, ctx).logic).toBe('and(and(amount_agorot.gt.150050,status.eq."won"))');
  });
});
