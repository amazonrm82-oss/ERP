import { describe, expect, it } from "vitest";

import { foldSmsReply, isSmsOptOutReply, SMS_OPTOUT_MAX, SMS_OPTOUT_WORDS } from "@/features/messaging/sms-optout";
import list from "@/features/messaging/sms-optout-words.json";

import { latestMigrationText } from "./helpers/migrations";
import cases from "./fixtures/sms-optout-replies.json";

describe("SMS-03: an inbound reply is an opt-out only as a whole message (shared fixture with app.sms_optout_reply)", () => {
  it.each(cases.optout)("opt-out: %j", (body) => expect(isSmsOptOutReply(body)).toBe(true));
  it.each(cases.not)("not an opt-out: %j", (body) => expect(isSmsOptOutReply(body)).toBe(false));

  it("removes spaces, marks, punctuation and digits, and folds Latin capitals", () => {
    expect(foldSmsReply("  הָסֵר   אותי!! ")).toBe("הסראותי");
    expect(foldSmsReply("STOP\n")).toBe("stop");
    expect(foldSmsReply("לא-לשלוח 2")).toBe("לאלשלוח");
  });

  it("judges nothing longer than 160 characters, and nothing that is not text", () => {
    expect(isSmsOptOutReply(`הסר${" ".repeat(SMS_OPTOUT_MAX)}`)).toBe(false);
    expect(isSmsOptOutReply(null)).toBe(false);
    expect(isSmsOptOutReply(undefined)).toBe(false);
  });

  it("the owner's list (209) ב is the one shared file, and the migration mirrors it word for word", () => {
    expect(SMS_OPTOUT_WORDS).toEqual(list.words);
    for (const word of ["הסר", "הפסק", "הפסיקו", "תפסיקו", "לא לשלוח", "אל תשלחו", "הסר מרשימת התפוצה", "stop", "unsubscribe", "remove"]) {
      expect(SMS_OPTOUT_WORDS).toContain(word);
    }
    // every word is written as the fold keeps it (Hebrew letters, small Latin letters and single spaces), so the
    // folded list has no two equal entries
    for (const word of SMS_OPTOUT_WORDS) expect(word).toMatch(/^[א-תa-z]+( [א-תa-z]+)*$/);
    expect(new Set(SMS_OPTOUT_WORDS.map(foldSmsReply)).size).toBe(SMS_OPTOUT_WORDS.length);
    const sql = latestMigrationText("create or replace function app.sms_optout_words")!;
    expect(sql).toContain(`array[${SMS_OPTOUT_WORDS.map((w) => `'${w}'`).join(", ")}]::text[]`);
    expect(sql).toContain(`char_length(p_body) <= ${SMS_OPTOUT_MAX}`);
  });
});
