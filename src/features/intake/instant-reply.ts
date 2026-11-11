// SPD-04 (owner (80) א, 3 November 2026; (259) א, (261) א, (280) ג, 11 November 2026): a web form may send an instant
// automatic reply, a service message, to the address the person typed in each submission, once per submission and at most
// once a day per address, 200 a business day (migration instant_reply, app.instant_reply_queue). Each form has its own switch;
// a new form starts from the business default (Settings > Forms). Plan key `instant_reply`. In working hours the reply says
// when the business will get back (CAP-10's response target, counted in working time); outside them "ביום העבודה הבא עד".
// SMS when the person typed a phone and the business has SMS in its plan, else email. The two templates per channel are the
// system's (Settings > message templates), fixed wording (only switched off or on), DRAFT until the lawyer edits them.

/** The hidden input that says the editor showed the switch (the business has the plan key); without it the stored value stays. */
export const INSTANT_REPLY_MARKER = "instant_reply_shown";

export const INSTANT_REPLY_LABEL = "מענה מיידי ללקוח";

export const INSTANT_REPLY_HINT =
  "ברגע שמישהו ממלא את הטופס, נשלחת אליו הודעה אוטומטית: \"קיבלנו, נחזור אליך עד השעה …\", לפי זמן המענה שהעסק קבע ושעות הפעילות. מחוץ לשעות הפעילות כתוב בה \"ביום העבודה הבא עד …\". ההודעה יוצאת רק לכתובת או למספר שהוזנו בטופס, פעם אחת לכל פנייה ולכל היותר פעם ביום לאותה כתובת: ב-SMS כשהוזן טלפון והחבילה כוללת SMS, אחרת באימייל.";

export const INSTANT_REPLY_DEFAULT_LABEL = "מענה מיידי בטפסים חדשים";

export const INSTANT_REPLY_DEFAULT_HINT =
  "טופס חדש שתיצרו יתחיל עם מענה מיידי פעיל. בכל טופס אפשר לשנות את זה בנפרד, וטפסים קיימים לא משתנים.";

/** Which channel the reply goes on (= app.instant_reply_queue's order): SMS first when the business has SMS, then email. */
export function instantReplyChannels(input: { typedPhoneMatches: boolean; typedEmailMatches: boolean; sms: boolean }): Array<"sms" | "email"> {
  const channels: Array<"sms" | "email"> = [];
  if (input.typedPhoneMatches && input.sms) channels.push("sms");
  if (input.typedEmailMatches) channels.push("email");
  return channels;
}
