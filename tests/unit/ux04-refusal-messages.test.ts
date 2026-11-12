import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { authErrorMessage, dbErrorMessage } from "@/lib/errors";

import rewritten from "./fixtures/ux04-rewritten-messages.json";
import { OTHER_CASES, REWRITTEN_HINTS } from "./ux04-cases";

// UX-04: a refusal says what happened and what the user can do next. Every hint message in src/lib/errors.ts is
// non-empty and its last sentence tells an action (an imperative, "אפשר ל…", "יש ל…", or where the owners fix it),
// unless the hint is listed below as one where there is nothing for the user to do.

const source = readFileSync(join(process.cwd(), "src/lib/errors.ts"), "utf8");
const mapBody = source.slice(source.indexOf("const LIMIT_MESSAGES"), source.indexOf("// P0001 raised without a hint"));
const MAP_HINTS = [...mapBody.matchAll(/^\s{2}"([a-z_]+:[a-z_0-9]+)":/gm)].map((m) => m[1]);
// the hints customFieldMessage() answers (with and without the field's label in the detail)
const FIELD_HINTS = [
  "custom_field:unique",
  "custom_field:read_only",
  "custom_field:unique_existing",
  "custom_field:unique_type",
  "custom_field:unique_default",
  "custom_field:default",
  "custom_field:record_link",
  "custom_field:file",
  "custom_field:condition",
];

// a refusal where nothing is left for the user to do: the message only explains
const NOTHING_TO_DO = new Set([
  // history the system writes and keeps
  "activity:quote_entry",
  "activity:order_entry",
  "activity:money_entry",
  "activity:record_link_entry",
  "activity:punch_card_entry",
  "import:original_date_fixed",
  "number_sequences:fixed",
  "number_sequences:delete",
  "privacy_request:verified",
  // a state that is already final
  // owner (347) ב: the owner's closing lines explain; nothing more to do
  "quote_pdf:not_accepted",
  "contact_channel:primary",
  "banner:not_dismissable",
  "roadmap:done",
  // only the person themselves can lift these (privacy), and the message says how
  "consent:erasure_block",
  "consent:optout_locked",
  "consent:address_blocked",
  // the owner's own wording (CAP-11, CLAUDE.md), pinned by test 304
  "integration:taken",
]);

const ACTION = new RegExp(
  [
    // imperatives (plural, the app's voice)
    "רעננו|נסו|בחרו|הוסיפו|מחקו|בדקו|פנו|בקשו|כתבו|צרו|הסירו|בטלו|העלו|סמנו|תקנו|הזינו|שנו|חכו|המתינו|פתחו|חלקו|רשמו",
    "הורידו|התחילו|ערכו|קצרו|אשרו|שמרו|לחצו|העבירו|מזגו|נתקו|קשרו|שייכו|צרפו|מלאו|הקטינו|אחדו|שחזרו|סגרו|השאירו|העתיקו",
    "ייצאו|המשיכו|עבדו|החליפו|הגדירו|הפעילו|קבעו|מכרו|הקלידו|שלחו|השלימו|שכפלו|התחברו|התנתקו",
    // an alternative, an instruction, or where the owners fix it
    "אפשר ל",
    "יש ל",
    "צריך לכתוב",
    "כותבים",
    "בעלי העסק (רואים|קובעים)",
  ].join("|"),
);

function lastSentence(text: string): string {
  const parts = text.trim().split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== "");
  return parts[parts.length - 1] ?? "";
}

const message = (hint: string, detail?: string) => dbErrorMessage({ code: "P0001", hint, message: "", details: detail }, "__fallback__");

describe("refusal messages say what to do (UX-04)", () => {
  it("finds the hint map", () => {
    expect(MAP_HINTS.length).toBeGreaterThan(300);
  });

  it("every hint message is non-empty and is not the fallback", () => {
    for (const hint of [...MAP_HINTS, ...FIELD_HINTS]) {
      const text = message(hint, "שדה");
      expect(text.trim(), hint).not.toBe("");
      expect(text, hint).not.toBe("__fallback__");
      expect(text.trim().endsWith(".") || text.trim().endsWith(")") || hint === "integration:taken", `${hint}: ${text}`).toBe(true);
    }
  });

  it("ends with what the user can do, where there is something to do", () => {
    const missing: string[] = [];
    for (const hint of [...MAP_HINTS, ...FIELD_HINTS]) {
      if (NOTHING_TO_DO.has(hint)) continue;
      for (const detail of [undefined, "שדה"]) {
        const text = message(hint, detail);
        if (!ACTION.test(lastSentence(text))) missing.push(`${hint}: ${text}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the plan fallbacks say where to look", () => {
    expect(ACTION.test(lastSentence(message("limit:not_a_real_key")))).toBe(true);
    expect(ACTION.test(lastSentence(message("feature:not_a_real_key")))).toBe(true);
  });

  it("every exempt hint is still a real hint", () => {
    for (const hint of NOTHING_TO_DO) {
      expect(MAP_HINTS, hint).toContain(hint);
    }
  });
});

// UX-04 second pass: the messages outside the hint map, and the pinned wording of what was rewritten
describe("refusal messages outside the hint map (UX-04)", () => {
  const HEBREW = /[\u05d0-\u05ea]/;
  const textOf = (name: string) => {
    const c = OTHER_CASES[name];
    return c.kind === "auth" ? authErrorMessage(c.error, "__fallback__") : dbErrorMessage(c.error, "__fallback__");
  };

  it("every hint message and every other case is Hebrew", () => {
    for (const hint of MAP_HINTS) expect(HEBREW.test(message(hint)), hint).toBe(true);
    for (const name of Object.keys(OTHER_CASES)) expect(HEBREW.test(textOf(name)), name).toBe(true);
  });

  it("the shared answers, the raised and own messages and the Auth codes end with what to do", () => {
    for (const name of Object.keys(OTHER_CASES)) {
      const text = textOf(name);
      expect(text, name).not.toBe("__fallback__");
      expect(ACTION.test(lastSentence(text)), `${name}: ${text}`).toBe(true);
    }
  });

  it("the rewritten wording is pinned (an edit shows up here)", () => {
    const hints: Record<string, string> = {};
    for (const hint of REWRITTEN_HINTS) hints[hint] = message(hint);
    const other: Record<string, string> = {};
    for (const name of Object.keys(OTHER_CASES)) other[name] = textOf(name);
    expect({ hints, other }).toEqual(rewritten);
  });

  it("a rewritten hint is not exempt from saying what to do, unless it only explains", () => {
    for (const hint of REWRITTEN_HINTS) {
      expect(MAP_HINTS, hint).toContain(hint);
      if (NOTHING_TO_DO.has(hint)) continue;
      expect(ACTION.test(lastSentence(message(hint))), hint).toBe(true);
    }
  });
});

describe("own role refusal (owner (346) ב)", () => {
  it("is recognised, and the owner's wording points to transferring ownership", async () => {
    const errors = await import("@/lib/errors");
    expect(errors.isOwnRoleRefusal({ code: "42501", message: "you cannot change your own role, seat or status" })).toBe(true);
    expect(errors.isOwnRoleRefusal({ code: "42501", message: "only the owner can change another admin" })).toBe(false);
    expect(errors.OWN_ROLE_OWNER_MESSAGE).toContain("הגדרות > משתמשים > העברת בעלות");
    expect(errors.dbErrorMessage({ code: "42501", message: "you cannot change your own role, seat or status" }, "x")).toBe(errors.OWN_ROLE_MESSAGE);
  });
  it("the users actions use the owner's wording", () => {
    const actions = readFileSync(join(process.cwd(), "src/features/settings/actions.ts"), "utf8");
    expect(actions.match(/ownRoleRefusal\(context, orgId, error,/g)?.length).toBe(2);
  });
});
