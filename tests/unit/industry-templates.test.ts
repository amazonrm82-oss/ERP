import { describe, expect, it } from "vitest";

import { fromDbRule } from "@/features/automations/convert";
import { describeApplyResult, templateKeyArg } from "@/features/industry-templates/schema";
import {
  INDUSTRY_TEMPLATES,
  industryTemplate,
  normName,
  previewIsEmpty,
  previewTemplate,
  type ExistingLists,
} from "@/features/industry-templates/templates";
import { INDUSTRIES } from "@/features/onboarding/options";
import { TASK_TYPE_VALUES } from "@/features/tasks/schema";

// FLD-05: the templates are data; these checks keep each one inside what the
// database accepts (tests/db/65 compares the data with the database copy).

const FIELD_TYPES = ["text", "number", "currency", "percent", "select", "multi_select", "checkbox", "date", "url", "il_id"];
const len = (s: string) => s.trim().length;

describe("industry template data (FLD-05)", () => {
  it("one template per industry of the sign-up form", () => {
    const keys = INDUSTRY_TEMPLATES.map((t) => t.industry);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(INDUSTRIES.map((i) => i.value).sort());
    expect(industryTemplate("real_estate")?.title).toBe('נדל"ן ותיווך');
    expect(industryTemplate(null)).toBeNull();
    expect(industryTemplate("__proto__")).toBeNull();
    expect(templateKeyArg.safeParse("health").success).toBe(true);
    expect(templateKeyArg.safeParse("nope").success).toBe(false);
  });

  for (const t of INDUSTRY_TEMPLATES) {
    describe(t.industry, () => {
      it("pipeline: a name, unique stage names, open stages first, one won and one lost", () => {
        if (!t.pipeline) return;
        expect(len(t.pipeline.name)).toBeGreaterThan(0);
        expect(len(t.pipeline.name)).toBeLessThanOrEqual(80);
        const names = t.pipeline.stages.map((s) => s.name.trim().toLowerCase());
        expect(new Set(names).size).toBe(names.length);
        const kinds = t.pipeline.stages.map((s) => s.kind);
        expect(kinds.filter((k) => k === "won")).toHaveLength(1);
        expect(kinds.filter((k) => k === "lost")).toHaveLength(1);
        expect(kinds.slice(0, kinds.indexOf("won")).every((k) => k === "open")).toBe(true);
        expect(kinds.filter((k) => k === "open").length).toBeGreaterThanOrEqual(2);
        for (const s of t.pipeline.stages) {
          expect(len(s.name)).toBeLessThanOrEqual(80);
          expect(Number.isInteger(s.probability) && s.probability >= 0 && s.probability <= 100).toBe(true);
          expect(s.rot_days === null || (Number.isInteger(s.rot_days) && s.rot_days > 0)).toBe(true);
          if (s.kind !== "open") expect(s.rot_days).toBeNull();
        }
      });

      it("statuses and sources: short, unique names; modest lists", () => {
        for (const list of [t.statuses, t.sources]) {
          expect(list.length).toBeLessThanOrEqual(5);
          const names = list.map((n) => n.trim().toLowerCase());
          expect(new Set(names).size).toBe(names.length);
          for (const name of list) expect(len(name) > 0 && len(name) <= 60).toBe(true);
        }
      });

      it("fields: valid keys, types and options, unique per object", () => {
        expect(t.fields.length).toBeGreaterThan(0);
        expect(t.fields.length).toBeLessThanOrEqual(6);
        const seen = new Set<string>();
        for (const f of t.fields) {
          expect(f.key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
          expect(len(f.label) > 0 && len(f.label) <= 80).toBe(true);
          expect(FIELD_TYPES).toContain(f.field_type);
          if (f.field_type === "select" || f.field_type === "multi_select") {
            expect(f.options.length).toBeGreaterThanOrEqual(2);
            expect(new Set(f.options).size).toBe(f.options.length);
          } else {
            expect(f.options).toEqual([]);
          }
          for (const id of [`${f.object_type}:${f.key}`, `${f.object_type}:label:${f.label.trim().toLowerCase()}`]) {
            expect(seen.has(id), id).toBe(false);
            seen.add(id);
          }
        }
      });

      it("automations: unique keys, no ids, and the builder can open them", () => {
        const keys = t.automations.map((a) => a.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const a of t.automations) {
          expect(len(a.name) > 0 && len(a.name) <= 80).toBe(true);
          expect(a.actions.length).toBeGreaterThan(0);
          expect(JSON.stringify(a)).not.toMatch(/_id"/);
          for (const action of a.actions) {
            if (action.type === "create_task") expect(TASK_TYPE_VALUES).toContain(action.task_type);
          }
          const opened = fromDbRule({
            name: a.name,
            entity: a.entity_type,
            triggerType: a.trigger_type,
            triggerConfig: a.trigger_config,
            conditions: [],
            actions: a.actions,
          });
          expect(opened, a.key).not.toBeNull();
          expect(opened!.actions).toHaveLength(a.actions.length);
        }
      });
    });
  }
});

const EMPTY: ExistingLists = { pipelines: [], statuses: [], sources: [], fields: [], automations: [] };

describe("previewTemplate (FLD-05)", () => {
  const t = industryTemplate("real_estate")!;

  it("an empty organization gets everything", () => {
    const p = previewTemplate(t, EMPTY);
    expect(p.pipeline).toEqual({ name: t.pipeline!.name, isNew: true });
    expect(p.stages).toEqual(t.pipeline!.stages.map((s) => s.name));
    expect(p.statuses).toEqual(t.statuses);
    expect(p.sources).toEqual(t.sources);
    expect(p.fields).toEqual(t.fields);
    expect(p.automations).toEqual(t.automations.map((a) => a.name));
    expect(previewIsEmpty(p)).toBe(false);
  });

  it("skips names that exist, ignoring outer spaces only (like btrim)", () => {
    const p = previewTemplate(t, {
      pipelines: [{ name: ` ${t.pipeline!.name} `, stages: [{ name: "סיור בנכס", kind: "open" }, { name: "סגור", kind: "won" }] }],
      // a tab is not a space for btrim: that status does not count
      statuses: ["  נקבע סיור", "\tמחפש נכס"],
      sources: ["יד2", "שלט על הנכס\u00a0"],
      fields: [
        { object_type: "lead", key: "rooms", label: "חדרים" },
        { object_type: "lead", key: "x1", label: "אזור מבוקש " },
        // the same key on another object does not count
        { object_type: "deal", key: "deal_type", label: "סוג" },
      ],
      automations: [{ name: "x", template_key: "industry:real_estate:new_lead_call" }],
    });
    expect(p.pipeline).toEqual({ name: ` ${t.pipeline!.name} `, isNew: false });
    // the pipeline has a won stage already: the template's is not added
    expect(p.stages).toEqual(["פנייה ראשונה", "משא ומתן", "זיכרון דברים", "לא נסגר"]);
    expect(p.statuses).toEqual(["מחפש נכס"]);
    expect(p.sources).toEqual(["שלט על הנכס"]);
    expect(normName("  a b ")).toBe("a b");
    expect(normName("Ab")).toBe("Ab");
    expect(p.fields.map((f) => f.key)).toEqual(["deal_type", "property_type", "commission"]);
    expect(p.automations).toEqual(["עסקה תקועה 14 ימים"]);
  });

  it("nothing left to add", () => {
    const g = industryTemplate("other")!;
    const p = previewTemplate(g, {
      ...EMPTY,
      statuses: g.statuses,
      sources: g.sources,
      fields: g.fields,
      automations: g.automations.map((a) => ({ name: a.name, template_key: null })),
    });
    expect(p.pipeline).toBeNull();
    expect(previewIsEmpty(p)).toBe(true);
  });
});

describe("describeApplyResult (FLD-05)", () => {
  const zero = { pipelines: 0, stages: 0, statuses: 0, sources: 0, fields: 0, automations: 0 };

  it("says what was added, in Hebrew", () => {
    expect(describeApplyResult({ added: { pipelines: 1, stages: 6, statuses: 1, sources: 2, fields: 1, automations: 2 }, limits: [] })).toBe(
      "נוספו: תהליך מכירה, 6 שלבים, סטטוס אחד, 2 מקורות, שדה אחד, 2 אוטומציות (כבויות, מפעילים אותן בהגדרות).",
    );
  });

  it("says when nothing was added, and what a plan limit left out", () => {
    expect(describeApplyResult({ added: zero, limits: [] })).toBe("לא נוסף דבר: כל מה שבתבנית כבר קיים אצלכם.");
    const text = describeApplyResult({ added: { ...zero, statuses: 2 }, limits: ["limit:max_pipelines", "limit:other"] });
    expect(text).toBe("נוספו: 2 סטטוסים. חלק מהתבנית לא נוסף בגלל מגבלת החבילה: תהליך המכירה; פריטים נוספים.");
  });
});
