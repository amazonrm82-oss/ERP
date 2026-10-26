import { describe, expect, it } from "vitest";

import { recordLinkRemovedText } from "@/features/activities/system-entries";
import { fieldState, fileFieldRequired, missingRequiredAfter, requiredFileKeptMessage, shownMarkerName } from "@/features/custom-fields/conditions";
import { effectiveDefinitions } from "@/features/custom-fields/form-conditions";
import { missingRequiredFiles } from "@/features/custom-fields/settings";
import { inputName, type FieldDefinition, type FieldType } from "@/features/custom-fields/types";
import { formFieldOptions } from "@/features/intake/fields";
import { filterFields, filterToPostgrest } from "@/features/list-filters/server";
import { opLabel, OPS_BY_KIND, type FilterTree } from "@/features/list-filters/model";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";

// FLD-06 part B follow-ups (owner's answers, 26 October 2026).

const field = (key: string, type: FieldType, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: key,
  key,
  label: key,
  type,
  options: [],
  isRequired: false,
  isActive: true,
  helpText: null,
  ...extra,
});
const ID = "0b7c7c64-34c4-4b4e-9b62-0d9f8a3c1e11";

describe("a record link emptied by a purge, on the timeline", () => {
  it("names the target's type in the business's words, never the record", () => {
    expect(recordLinkRemovedText("lead", DEFAULT_TERMS)).toBe("הקישור ל-ליד הוסר: הרשומה נמחקה");
    expect(recordLinkRemovedText("contact", DEFAULT_TERMS)).toBe("הקישור ל-איש קשר הוסר: הרשומה נמחקה");
    expect(recordLinkRemovedText("company", DEFAULT_TERMS)).toBe("הקישור ל-חברה הוסר: הרשומה נמחקה");
    expect(recordLinkRemovedText("deal", DEFAULT_TERMS)).toBe("הקישור ל-עסקה הוסר: הרשומה נמחקה");
    const terms = resolveTerms({ contact: "customer", lead: "inquiry", deal: "case" });
    expect(recordLinkRemovedText("contact", terms)).toBe("הקישור ל-לקוח הוסר: הרשומה נמחקה");
    expect(recordLinkRemovedText("lead", terms)).toBe("הקישור ל-פנייה הוסר: הרשומה נמחקה");
    expect(recordLinkRemovedText("deal", terms)).toBe("הקישור ל-תיק הוסר: הרשומה נמחקה");
  });

  it("an unknown type keeps the stored text", () => {
    expect(recordLinkRemovedText("task", DEFAULT_TERMS)).toBeNull();
    expect(recordLinkRemovedText(null, DEFAULT_TERMS)).toBeNull();
  });
});

describe("an address on the public form", () => {
  it("the form builder offers an address field, never a record link or a file", () => {
    const keys = formFieldOptions([field("site", "address"), field("client", "record_link"), field("doc", "file")]).map((o) => o.key);
    expect(keys).toContain("cf:site");
    expect(keys).not.toContain("cf:client");
    expect(keys).not.toContain("cf:doc");
  });
});

describe("filled / empty filter for a record link or a file", () => {
  const fields = filterFields("lead", { members: [], tags: [], fields: [field("client", "record_link"), field("doc", "file"), field("site", "address")] });
  const one = (key: string, op: string, value = "") =>
    filterToPostgrest({ match: "all", groups: [{ match: "all", conditions: [{ field: key, op, value }] }] } as FilterTree, fields, {
      userId: ID,
      now: new Date("2026-10-26T08:00:00Z"),
    });

  it("is offered with only those two operators, labelled מלא / ריק", () => {
    const link = fields.find((f) => f.key === "cf:client");
    expect(link?.kind).toBe("presence");
    expect(fields.find((f) => f.key === "cf:doc")?.kind).toBe("presence");
    expect(fields.find((f) => f.key === "cf:site")?.kind).toBe("text");
    expect(OPS_BY_KIND.presence).toEqual(["not_empty", "empty"]);
    expect(opLabel("presence", "not_empty")).toBe("מלא");
    expect(opLabel("presence", "empty")).toBe("ריק");
    expect(opLabel("text", "not_empty")).toBe("לא ריק");
  });

  it("builds the text test on the stored id and refuses anything else", () => {
    expect(one("cf:client", "not_empty").logic).toBe('and(and(and(custom_fields->>client.not.is.null,custom_fields->>client.neq."")))');
    expect(one("cf:doc", "empty").logic).toBe('and(and(or(custom_fields->>doc.is.null,custom_fields->>doc.eq."")))');
    for (const op of ["equals", "contains", "is"]) {
      const out = one("cf:client", op, ID);
      expect(out.logic, op).toBeNull();
      expect(out.skipped, op).toBe(1);
    }
  });
});

describe("a required file field", () => {
  const doc = field("doc", "file", { isRequired: true });

  it("is missing only while the record holds no file", () => {
    expect(missingRequiredFiles([doc, field("other", "text", { isRequired: true })], {}).map((f) => f.key)).toEqual(["doc"]);
    expect(missingRequiredFiles([doc], { doc: ID })).toEqual([]);
    expect(missingRequiredFiles([doc], { doc: " " }).map((f) => f.key)).toEqual(["doc"]);
    expect(missingRequiredFiles([{ ...doc, isRequired: false }], {})).toEqual([]);
    expect(missingRequiredFiles([{ ...doc, isActive: false }], {})).toEqual([]);
  });

  it("a move never asks for it, whether required by its box or by a condition", () => {
    const tier = field("tier", "select", { options: ["זהב", "רגיל"] });
    const shown = { ...doc, condition: { field: "tier", op: "equals" as const, value: "זהב", effect: "show" as const } };
    const conditional = { ...field("scan", "file"), condition: { field: "tier", op: "equals" as const, value: "זהב", effect: "require" as const } };
    const text = { ...field("note", "text"), condition: { field: "tier", op: "equals" as const, value: "זהב", effect: "require" as const } };
    const missing = missingRequiredAfter([tier, shown, conditional, text], {}, "lead", { tier: "זהב" }).map((f) => f.key);
    expect(missing).toEqual(["note"]);
  });
});

// owner, 26 October 2026, answers 3 and 4 (ב)
describe("a file field required by a condition, and a required file kept", () => {
  const tier = field("tier", "select", { options: ["זהב", "רגיל"] });
  const requireOnGold = { field: "tier", op: "equals" as const, value: "זהב", effect: "require" as const };
  const scan = { ...field("scan", "file", { label: "סריקה" }), condition: requireOnGold };
  const doc = field("doc", "file", { isRequired: true, label: "חוזה" });
  const defs = [tier, scan, doc];

  it("a require condition asks for a file only on the edit card", () => {
    expect(fieldState(scan, defs, { tier: "זהב" }, "lead").required).toBe(false);
    expect(fieldState(scan, defs, { tier: "זהב" }, "lead", { files: true }).required).toBe(true);
    expect(fieldState(scan, defs, { tier: "רגיל" }, "lead", { files: true }).required).toBe(false);
  });

  it("the edit card's save checks it with the form's values; a create never does", () => {
    const form = (value: string, marker = true) => {
      const data = new FormData();
      data.set(inputName("tier"), value);
      if (marker) data.set(shownMarkerName("scan"), "1");
      return data;
    };
    const stored = { custom: {}, builtins: {} };
    const keys = (fields: FieldDefinition[]) => fields.map((f) => f.key);
    expect(keys(missingRequiredFiles(effectiveDefinitions("lead", defs, form("זהב"), stored, true), {}))).toEqual(["scan", "doc"]);
    expect(keys(missingRequiredFiles(effectiveDefinitions("lead", defs, form("זהב"), stored, true), { scan: ID, doc: ID }))).toEqual([]);
    expect(keys(missingRequiredFiles(effectiveDefinitions("lead", defs, form("רגיל"), stored, true), {}))).toEqual(["doc"]);
    // the field was not shown in the browser: not asked
    expect(keys(missingRequiredFiles(effectiveDefinitions("lead", defs, form("זהב", false), stored, true), {}))).toEqual(["doc"]);
    // a new record gets its files after it is saved
    expect(effectiveDefinitions("lead", defs, form("זהב"), null, false).find((f) => f.key === "scan")?.isRequired).toBe(false);
  });

  it("a required file field's file is replaced, never removed", () => {
    expect(fileFieldRequired(doc, defs, {}, "lead")).toBe(true);
    expect(fileFieldRequired(scan, defs, { tier: "זהב" }, "lead")).toBe(true);
    expect(fileFieldRequired(scan, defs, { tier: "רגיל" }, "lead")).toBe(false);
    expect(fileFieldRequired(field("free", "file"), defs, {}, "lead")).toBe(false);
    expect(fileFieldRequired({ ...doc, isActive: false }, defs, {}, "lead")).toBe(false);
    expect(fileFieldRequired(field("text", "text", { isRequired: true }), defs, {}, "lead")).toBe(false);
    // hidden by a "show" condition: not on the card, not required
    const shown = { ...doc, condition: { ...requireOnGold, effect: "show" as const } };
    expect(fileFieldRequired(shown, [tier, shown], { tier: "רגיל" }, "lead")).toBe(false);
    expect(fileFieldRequired(shown, [tier, shown], { tier: "זהב" }, "lead")).toBe(true);
    expect(requiredFileKeptMessage("חוזה")).toBe('"חוזה" הוא שדה חובה: אפשר להחליף את הקובץ, אבל לא להסיר אותו.');
  });
});
