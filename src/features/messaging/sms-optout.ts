// SMS-03: is an inbound SMS reply an opt-out? Owner's answer (209) ב: the WHOLE message, after removing spaces, niqqud and
// punctuation (and digits, emoji, other marks), Latin letters case-insensitive, equals one word of the one shared list
// (sms-optout-words.json, mirrored by app.sms_optout_words() in migration _sms_c_optout.sql); a word inside a sentence never
// counts. Mirrors app.sms_optout_reply / app.sms_optout_fold; both run tests/unit/fixtures/sms-optout-replies.json. The future
// inbound webhook (wave 3 use (2), not built) passes the reply to public.sms_inbound_optout, which judges it there.

import list from "./sms-optout-words.json";

/** = app.sms_optout_words(): the shared list as written (with its spaces). */
export const SMS_OPTOUT_WORDS: readonly string[] = Object.freeze([...list.words]);

/** The longest reply that is judged at all (code points). */
export const SMS_OPTOUT_MAX = 160;

/** = app.sms_optout_fold(): ASCII rules only (no locale), so the two never differ. Keeps Hebrew letters and a-z only. */
export function foldSmsReply(body: string): string {
  return body.replace(/[A-Z]/g, (ch) => ch.toLowerCase()).replace(/[^א-תa-z]/g, "");
}

const FOLDED = new Set(SMS_OPTOUT_WORDS.map(foldSmsReply));

export function isSmsOptOutReply(body: string | null | undefined): boolean {
  if (typeof body !== "string" || [...body].length > SMS_OPTOUT_MAX) return false;
  const folded = foldSmsReply(body);
  return folded !== "" && FOLDED.has(folded);
}
