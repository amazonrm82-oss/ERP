import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { missingFieldsMessage } from "@/features/custom-fields/conditions";
import { REQUIRED_ASKED_FIELD, requiredAnswer } from "@/features/custom-fields/required-move";
import { inputName } from "@/features/custom-fields/types";
import { stageInput, stageSchema } from "@/features/customization/schema";
import {
  STAGE_REQUIRED_FIELDS,
  splitMovePatch,
  stageFieldMissing,
  stageRequiredDefinition,
  stageRequiredFields,
} from "@/features/deals/stage-required";

const form = (entries: Array<[string, string]>) => {
  const data = new FormData();
  for (const [k, v] of entries) data.append(k, v);
  return data;
};

// DEAL-05 (owner, 18 October 2026, answer (א)): amount, expected close date and contact, required per stage.
describe("built-in fields required to enter a stage (DEAL-05)", () => {
  it("the list is the owner's three, the same as the database's check", () => {
    expect([...STAGE_REQUIRED_FIELDS]).toEqual(["amount", "expected_close_date", "contact_id"]);
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261006020475_stage_required_fields.sql"), "utf8");
    const listed = /required_fields <@ array\[([^\]]*)\]/.exec(sql)?.[1] ?? "";
    expect([...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...STAGE_REQUIRED_FIELDS]);
  });

  it("reads the stored list in order and ignores unknown keys; a missing value is null or empty (0 is an amount)", () => {
    expect(stageRequiredFields(["contact_id", "amount", "x"])).toEqual(["amount", "contact_id"]);
    expect(stageRequiredFields(null)).toEqual([]);
    expect(stageFieldMissing("amount", { amount_agorot: null })).toBe(true);
    expect(stageFieldMissing("amount", { amount_agorot: 0 })).toBe(false);
    expect(stageFieldMissing("expected_close_date", { expected_close_date: "2027-01-01" })).toBe(false);
    expect(stageFieldMissing("contact_id", {})).toBe(true);
  });

  it("a move asks for them like FLD-09's fields and sends them to the deal's own columns", () => {
    const fields = [
      stageRequiredDefinition("amount"),
      stageRequiredDefinition("expected_close_date"),
      stageRequiredDefinition("contact_id", [{ id: "c-1", name: "דנה" }]),
    ];
    // first try: a refusal that names them (also the bulk skip's wording)
    const refused = requiredAnswer(fields, null);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toBe(missingFieldsMessage([{ label: "סכום" }, { label: "תאריך סגירה צפוי" }, { label: "איש קשר" }]));
    expect(missingFieldsMessage(fields)).toBe("חסר שדה חובה: סכום, תאריך סגירה צפוי, איש קשר");
    // asked and sent: amount in agorot, the date, the contact
    const sent = requiredAnswer(
      fields,
      form([
        [REQUIRED_ASKED_FIELD, "1"],
        [inputName("builtin:amount"), "1,250.50"],
        [inputName("builtin:expected_close_date"), "2027-02-01"],
        [inputName("builtin:contact_id"), "c-1"],
      ]),
    );
    expect(sent).toEqual({ ok: true, patch: { "builtin:amount": 125050, "builtin:expected_close_date": "2027-02-01", "builtin:contact_id": "c-1" } });
    expect(splitMovePatch(sent.ok ? sent.patch : undefined)).toEqual({
      columns: { amount_agorot: 125050, expected_close_date: "2027-02-01", contact_id: "c-1" },
      custom: undefined,
    });
    // a custom field asked with them stays a custom field
    expect(splitMovePatch({ "builtin:amount": 5, budget: "גבוה" })).toEqual({ columns: { amount_agorot: 5 }, custom: { budget: "גבוה" } });
    // a contact that is not in the list: said as a contact, not as a user
    const wrong = requiredAnswer(fields.slice(2), form([[REQUIRED_ASKED_FIELD, "1"], [inputName("builtin:contact_id"), "someone-else"]]));
    expect(!wrong.ok && wrong.fieldErrors?.[inputName("builtin:contact_id")]).toBe("יש לבחור איש קשר מהרשימה.");
    // empty after asking: a field error
    const empty = requiredAnswer(fields.slice(0, 1), form([[REQUIRED_ASKED_FIELD, "1"]]));
    expect(!empty.ok && empty.fieldErrors?.[inputName("builtin:amount")]).toBe("יש למלא את השדה.");
  });

  it("the stage form saves the ticked fields, and a form without them leaves them as they are", () => {
    const base: Array<[string, string]> = [["name", "הצעה"], ["kind", "open"], ["probability", "40"], ["color", ""], ["rot_days", ""]];
    const ticked = stageSchema.safeParse(stageInput(form([...base, ["required_fields_sent", "1"], ["required_fields", "contact_id"], ["required_fields", "amount"]])));
    expect(ticked.success && ticked.data.required_fields).toEqual(["amount", "contact_id"]);
    const none = stageSchema.safeParse(stageInput(form([...base, ["required_fields_sent", "1"]])));
    expect(none.success && none.data.required_fields).toEqual([]);
    const untouched = stageSchema.safeParse(stageInput(form(base)));
    expect(untouched.success && untouched.data.required_fields).toBeUndefined();
    expect(stageSchema.safeParse(stageInput(form([...base, ["required_fields_sent", "1"], ["required_fields", "company_id"]]))).success).toBe(false);
  });
});
