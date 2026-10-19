import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_BASES,
  ACTIVITY_TYPE_ICONS,
  DEFAULT_ACTIVITY_TYPES,
  entryLabel,
  logChoices,
  defaultLogChoice,
  parseChoice,
  parseTaskChoice,
  taskChoices,
  taskChoiceValue,
  taskCodeFor,
  taskKindLabel,
  taskTypeName,
  quickLogTypeId,
  type ActivityTypeOption,
} from "@/features/activity-types/types";
import { taskSchema } from "@/features/tasks/schema";

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20261006020545_activity_types.sql"), "utf8");
const quoted = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const type = (n: number, base: ActivityTypeOption["baseType"], name: string, extra: Partial<ActivityTypeOption> = {}): ActivityTypeOption => ({
  id: ID(n),
  baseType: base,
  name,
  icon: null,
  key: null,
  isActive: true,
  ...extra,
});
const DEFAULTS = DEFAULT_ACTIVITY_TYPES.map((d, i) => type(i, d.key, d.name, { key: d.key }));

// TASK-08: the app's closed lists are the migration's
describe("activity types mirror the database (TASK-08)", () => {
  it("base kinds, icons and the seeded defaults", () => {
    const base = /base_type\s+text not null check \(base_type in \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? "";
    expect(quoted(base)).toEqual([...ACTIVITY_BASES]);
    const icons = /icon\s+text check \(icon is null or icon in \(([^)]*)\)\)/.exec(MIGRATION)?.[1] ?? "";
    expect(quoted(icons)).toEqual([...ACTIVITY_TYPE_ICONS]);
    const seed = /from \(values ([\s\S]*?)\) as d\(base, name, pos\)/.exec(MIGRATION)?.[1] ?? "";
    const rows = [...seed.matchAll(/\('([a-z]+)', '([^']+)', (\d+)\)/g)].map((m) => ({ key: m[1], name: m[2] }));
    expect(rows).toEqual(DEFAULT_ACTIVITY_TYPES.map((d) => ({ key: d.key, name: d.name })));
  });

  it("the task code of a kind is the trigger's", () => {
    expect(ACTIVITY_BASES.map(taskCodeFor)).toEqual(["todo", "call", "meeting", "todo", "todo", "todo"]);
    expect(MIGRATION).toContain("case v_base when 'call' then 'call' when 'meeting' then 'meeting' else 'todo' end");
  });
});

describe("the log form (TASK-08)", () => {
  it("offers the active types, then each kind left without one, under its built-in name", () => {
    const types = [...DEFAULTS, type(7, "meeting", "ביקור"), type(8, "call", "שיחה ישנה", { isActive: false })];
    // the business hid its own "SMS" default
    types[5] = { ...types[5], isActive: false };
    const choices = logChoices(types);
    expect(choices.map((c) => c.label)).toEqual(["הערה", "שיחה", "פגישה", "WhatsApp", "אימייל", "ביקור", "SMS"]);
    expect(choices.at(-1)).toEqual({ value: "sms", label: "SMS", base: "sms", typeId: null });
    expect(defaultLogChoice(choices)).toBe(`t:${ID(0)}`);
    // an empty list is the six kinds
    expect(logChoices([]).map((c) => c.value)).toEqual([...ACTIVITY_BASES]);
    expect(defaultLogChoice(logChoices([]))).toBe("note");
  });

  it("reads a choice strictly", () => {
    expect(parseChoice("call")).toEqual({ base: "call" });
    expect(parseChoice(`t:${ID(3)}`)).toEqual({ typeId: ID(3) });
    for (const bad of ["system", "t:", "t:not-an-id", "", null, 3]) expect(parseChoice(bad)).toBeNull();
  });

  it("names an entry by its type, else its kind's default, else the built-in name", () => {
    const visit = type(7, "meeting", "ביקור", { icon: "home" });
    expect(entryLabel(visit.id, "meeting", [...DEFAULTS, visit])).toEqual({ name: "ביקור", icon: "home" });
    const renamed = DEFAULTS.map((d) => (d.key === "call" ? { ...d, name: "טלפון" } : d));
    expect(entryLabel(null, "call", renamed)).toEqual({ name: "טלפון", icon: "phone" });
    expect(entryLabel(null, "sms", [])).toEqual({ name: "SMS", icon: "chat" });
  });
});

describe("the task form (TASK-08)", () => {
  const visit = type(7, "meeting", "ביקור");
  const types = [...DEFAULTS, visit];

  it("offers משימה and מעקב first, then the active types", () => {
    expect(taskChoices(types).map((c) => c.label)).toEqual(["משימה", "מעקב", "הערה", "שיחה", "פגישה", "WhatsApp", "אימייל", "SMS", "ביקור"]);
  });

  it("keeps a task's own value selectable: a hidden type, or a bare code whose default was deleted", () => {
    const hidden = { ...visit, isActive: false };
    expect(taskChoices([...DEFAULTS, hidden], `t:${visit.id}`).at(-1)).toEqual({ value: `t:${visit.id}`, label: "ביקור" });
    const noCall = DEFAULTS.filter((d) => d.key !== "call");
    expect(taskChoiceValue({ taskType: "call", activityTypeId: null }, noCall)).toBe("call");
    expect(taskChoices(noCall, "call").at(-1)).toEqual({ value: "call", label: "שיחה" });
  });

  it("a stored task opens on its type, or on its kind's default", () => {
    expect(taskChoiceValue({ taskType: "meeting", activityTypeId: visit.id }, types)).toBe(`t:${visit.id}`);
    expect(taskChoiceValue({ taskType: "call", activityTypeId: null }, types)).toBe(`t:${ID(1)}`);
    expect(taskChoiceValue({ taskType: "follow_up", activityTypeId: null }, types)).toBe("follow_up");
  });

  it("a type is sent alone (the database sets the code); a fixed code clears the type", () => {
    expect(parseTaskChoice(`t:${visit.id}`)).toEqual({ activity_type_id: visit.id });
    expect(parseTaskChoice("follow_up")).toEqual({ task_type: "follow_up", activity_type_id: null });
    expect(parseTaskChoice("")).toEqual({ task_type: "todo", activity_type_id: null });
    expect(parseTaskChoice(null)).toEqual({ task_type: "todo", activity_type_id: null });
    for (const bad of ["boss", "toString", "t:x"]) expect(parseTaskChoice(bad)).toBeNull();
    const parsed = taskSchema.safeParse({ title: "x", due_date: null, due_time: null, owner_id: null, task_type: "visit", remind: null, priority: null });
    expect(parsed.success).toBe(false);
  });

  it("a row names the task's type; a plain task shows nothing", () => {
    expect(taskKindLabel({ taskType: "meeting", activityTypeId: visit.id }, types)).toBe("ביקור");
    expect(taskKindLabel({ taskType: "todo", activityTypeId: null }, types)).toBeNull();
    expect(taskKindLabel({ taskType: "follow_up", activityTypeId: null }, types)).toBe("מעקב");
    const renamed = types.map((t) => (t.key === "meeting" ? { ...t, name: "פגישת לקוח" } : t));
    expect(taskKindLabel({ taskType: "meeting", activityTypeId: null }, renamed)).toBe("פגישת לקוח");
    expect(taskKindLabel({ taskType: "call", activityTypeId: null }, [])).toBe("שיחה");
  });
});

describe("TASK-08 follow-ups: names in the tasks table, export and calendar; the type of a one-step log", () => {
  const call = type(1, "call", "שיחת מכירה", { key: "call" });
  const callOther = type(2, "call", "שיחת שירות");
  const hidden = type(3, "call", "שיחה ישנה", { isActive: false });
  const meeting = type(4, "meeting", "פגישה בשטח", { key: "meeting" });
  const list = [call, callOther, hidden, meeting];

  it("a task shows its own type, hidden ones too, else the built-in name of its code", () => {
    expect(taskTypeName({ taskType: "call", activityTypeId: callOther.id }, list)).toBe("שיחת שירות");
    // a hidden type keeps its own name (owner, like hidden contact types)
    expect(taskTypeName({ taskType: "call", activityTypeId: hidden.id }, list)).toBe("שיחה ישנה");
    // a deleted type, or none: today's built-in name of the stored code
    expect(taskTypeName({ taskType: "meeting", activityTypeId: ID(9) }, list)).toBe("פגישה");
    expect(taskTypeName({ taskType: "call", activityTypeId: null }, list)).toBe("שיחה");
    // the two fixed choices keep their names (owner)
    expect(taskTypeName({ taskType: "todo", activityTypeId: null }, list)).toBe("משימה");
    expect(taskTypeName({ taskType: "follow_up", activityTypeId: null }, list)).toBe("מעקב");
    // an unknown code is shown as stored
    expect(taskTypeName({ taskType: "other", activityTypeId: null }, [])).toBe("other");
  });

  it("a one-step log takes the seeded default of its kind, else the first active one, else none", () => {
    expect(quickLogTypeId("call", list)).toBe(call.id);
    // the default hidden: the next active one of the kind, in the list's order
    expect(quickLogTypeId("call", [{ ...call, isActive: false }, hidden, callOther])).toBe(callOther.id);
    // a renamed default keeps its key and is still preferred, wherever it stands in the list
    expect(quickLogTypeId("call", [callOther, { ...call, name: "טלפון" }])).toBe(call.id);
    // no active type of the kind: none (the entry is logged with its kind alone)
    expect(quickLogTypeId("call", [hidden, meeting])).toBeNull();
    expect(quickLogTypeId("whatsapp", list)).toBeNull();
    expect(quickLogTypeId("whatsapp", [type(5, "whatsapp", "וואטסאפ", { key: "whatsapp" })])).toBe(ID(5));
  });
});
