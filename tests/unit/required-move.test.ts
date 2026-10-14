import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingRequiredAfter } from "@/features/custom-fields/conditions";
import {
  askedField,
  askedFieldsFor,
  isMoveRefusal,
  REQUIRED_ASKED_FIELD,
  requiredAnswer,
  type MoveRefusal,
} from "@/features/custom-fields/required-move";
import { inputName, type FieldDefinition } from "@/features/custom-fields/types";

// FLD-09 (owner, 14 October 2026): one mechanism for every move by hand (board, table cell, the lead's
// status form, the deal's stage menu, the won window): refuse with the missing fields, ask for them,
// save them with the move.

function def(key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return { id: `id-${key}`, key, label: key, type, options: [], isRequired: false, isActive: true, helpText: null, ...extra };
}

const STAGE_A = "33333333-3333-4333-8333-333333333333";
const STAGE_WON = "44444444-4444-4444-8444-444444444444";
const signed = def("signed", "date", { label: "תאריך חתימה", isReadOnly: true, condition: { field: "builtin:stage", op: "equals", value: STAGE_WON, effect: "require" } });
const contract = def("contract", "checkbox", { label: "חוזה נחתם", condition: { field: "builtin:stage", op: "equals", value: STAGE_WON, effect: "require" } });
const missing = missingRequiredAfter([signed, contract], { "builtin:stage": STAGE_A }, "deal", { "builtin:stage": STAGE_WON });

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

describe("askedField", () => {
  it("is required, writable and without its condition", () => {
    expect(askedField(signed)).toMatchObject({ key: "signed", isRequired: true, isReadOnly: false, condition: null });
  });
});

describe("requiredAnswer", () => {
  it("nothing missing: no patch, the move goes through", () => {
    expect(requiredAnswer([], null)).toEqual({ ok: true, patch: undefined });
    expect(requiredAnswer([], form({ stage_id: STAGE_WON }))).toEqual({ ok: true, patch: undefined });
  });

  it("not asked yet (a drag, a cell, a form's first try): a refusal that names the fields, no field errors", () => {
    for (const formData of [null, form({ stage_id: STAGE_WON, [inputName("signed")]: "2026-10-14" })]) {
      const answer = requiredAnswer(missing, formData, { stage_id: STAGE_WON });
      expect(answer.ok).toBe(false);
      expect(isMoveRefusal(answer)).toBe(true);
      const refusal = answer as MoveRefusal;
      expect(refusal.message).toBe("חסר שדה חובה: תאריך חתימה, חוזה נחתם");
      expect(refusal.missing.map((field) => field.key)).toEqual(["signed", "contract"]);
      expect(refusal.missing.every((field) => field.isRequired && field.condition === null)).toBe(true);
      expect(refusal.fieldErrors).toBeUndefined();
      expect(refusal.values).toEqual({ stage_id: STAGE_WON });
    }
  });

  it("asked and still empty: field errors for each, and the fields again", () => {
    const answer = requiredAnswer(missing, form({ [REQUIRED_ASKED_FIELD]: "1" }));
    expect(isMoveRefusal(answer)).toBe(true);
    const refusal = answer as MoveRefusal;
    expect(Object.keys(refusal.fieldErrors ?? {}).sort()).toEqual([inputName("contract"), inputName("signed")].sort());
    expect(refusal.missing).toHaveLength(2);
  });

  it("asked and filled: the patch for {\"$merge\": …}, only the asked keys", () => {
    const answer = requiredAnswer(
      missing,
      form({ [REQUIRED_ASKED_FIELD]: "1", [inputName("signed")]: "2026-10-14", [inputName("contract")]: "on", [inputName("other")]: "x" }),
    );
    expect(answer).toEqual({ ok: true, patch: { signed: "2026-10-14", contract: true } });
  });

  it("asked and invalid: a field error, nothing saved", () => {
    const answer = requiredAnswer(missing, form({ [REQUIRED_ASKED_FIELD]: "1", [inputName("signed")]: "not a date", [inputName("contract")]: "on" }));
    expect(isMoveRefusal(answer)).toBe(true);
    expect(Object.keys((answer as MoveRefusal).fieldErrors ?? {})).toEqual([inputName("signed")]);
  });
});

describe("isMoveRefusal", () => {
  it("only a failure that names fields", () => {
    expect(isMoveRefusal({ ok: false, message: "x", missing: [askedField(contract)] })).toBe(true);
    expect(isMoveRefusal({ ok: false, message: "x", missing: [] })).toBe(false);
    expect(isMoveRefusal({ ok: false, message: "x" })).toBe(false);
    expect(isMoveRefusal({ ok: true })).toBe(false);
    expect(isMoveRefusal(null)).toBe(false);
  });
});

describe("askedFieldsFor (the card forms)", () => {
  const refusal: MoveRefusal = { ok: false, message: "x", missing: [askedField(contract)], values: { stage_id: STAGE_WON } };
  it("the refused target's fields while the form still points at it", () => {
    expect(askedFieldsFor(refusal, "stage_id", STAGE_WON).map((field) => field.key)).toEqual(["contract"]);
  });
  it("another target picked since, or no refusal: none", () => {
    expect(askedFieldsFor(refusal, "stage_id", STAGE_A)).toEqual([]);
    expect(askedFieldsFor({ ok: false, message: "x" }, "stage_id", STAGE_WON)).toEqual([]);
    expect(askedFieldsFor(null, "stage_id", STAGE_WON)).toEqual([]);
  });
});

describe("one path for every move by hand", () => {
  const root = join(__dirname, "..", "..");
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("the board, the table cell and the card forms all go through moveRecord / moveRecordAction", () => {
    for (const path of ["src/features/leads/actions.ts", "src/features/deals/actions.ts", "src/features/inline-edit/actions.ts"]) {
      expect(read(path)).toContain("moveRecord(");
    }
    for (const path of [
      "src/features/leads/components/leads-board.tsx",
      "src/features/leads/components/lead-status-menu.tsx",
      "src/features/deals/components/deals-board.tsx",
    ]) {
      expect(read(path)).toContain("moveRecordAction(");
    }
    // the won window asks for the fields itself instead of sending the user to the card
    expect(read("src/features/deals/actions.ts")).not.toContain("ממלאים בכרטיס העסקה");
    expect(read("src/features/deals/components/deal-won-dialog.tsx")).toContain("<AskedFields");
  });

  it("the lost forms of the cleanup and forecast lists keep the loss fields after a refusal (submitted by hand)", () => {
    for (const path of ["src/features/pipeline-cleanup/components/cleanup-list.tsx", "src/features/reports/components/forecast-overdue.tsx"]) {
      const source = read(path);
      const lostForm = source.slice(source.indexOf("function LostForm("));
      expect(lostForm).toContain("onSubmit={submitWith(action)}");
      expect(lostForm).not.toContain("<form action={action}");
    }
  });
});
