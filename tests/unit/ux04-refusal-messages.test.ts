import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dbErrorMessage } from "@/lib/errors";

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
  "number_sequences:last_number",
  "number_sequences:fixed",
  "number_sequences:delete",
  "privacy_request:closed",
  "privacy_request:verified",
  // a state that is already final
  "cheque:refunded",
  "payment_promise:nothing_open",
  "quote_pdf:closed",
  "quote_pdf:not_accepted",
  "order_pdf:closed",
  "quote_version:closed",
  "quote_version:parent",
  "quote_version:fixed",
  "quote_cancel:closed",
  "quote_cancel:not_accepted",
  "quote_addendum:not_accepted",
  "quote_addendum:parent",
  "quote_addendum:version",
  "quote_addendum:fixed",
  "order:quote_not_accepted",
  "order_link:cancelled",
  "order_link:customer_deleted",
  "quote_deal:no_deal",
  "contact_relation:exists",
  "contact_channel:primary",
  "banner:not_dismissable",
  "roadmap:closed",
  "roadmap:done",
  // only the person themselves can lift these (privacy), and the message says how
  "consent:erasure_block",
  "consent:optout_locked",
  "consent:address_blocked",
  // the shared "no permission" text (raised as 42501)
  "record_email:not_permitted",
  "record_sms:not_permitted",
  // the owner's own wording (CAP-11, CLAUDE.md), pinned by test 304
  "integration:taken",
]);

const ACTION = new RegExp(
  [
    // imperatives (plural, the app's voice)
    "רעננו|נסו|בחרו|הוסיפו|מחקו|בדקו|פנו|בקשו|כתבו|צרו|הסירו|בטלו|העלו|סמנו|תקנו|הזינו|שנו|חכו|המתינו|פתחו|חלקו|רשמו",
    "הורידו|התחילו|ערכו|קצרו|אשרו|שמרו|לחצו|העבירו|מזגו|נתקו|קשרו|שייכו|צרפו|מלאו|הקטינו|אחדו|שחזרו|סגרו|השאירו|העתיקו",
    "ייצאו|המשיכו|עבדו|החליפו|הגדירו|הפעילו|קבעו|מכרו|הקלידו|שלחו|השלימו",
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
