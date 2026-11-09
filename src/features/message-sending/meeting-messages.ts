// CAL-12 (owner's answers 177-182, 9 November 2026; migration meeting_customer_reminders): a confirmation, a "moved"
// message and reminders of a meeting to its customer. THE rules live in the database (app.meetings_customer_messages, the confirmation;
// app.send_meeting_customer_reminders, the reminders; app.meeting_customer_template, the channel). This file mirrors them
// for the settings page's wording and the unit test, which reads the migration and keeps the numbers equal.

/** The plan key: the plans of lead_distribution (owner (178) ב); a per-business override opens or closes it. */
export const MEETING_REMINDERS_FEATURE = "meeting_reminders";

export type MeetingMessageKind = "confirm" | "day" | "hour";
export type MeetingChannel = "sms" | "email";

/** When a reminder is queued, in minutes before the start: from `from` down to (not including) `until`. */
export const REMINDER_WINDOWS: Record<"day" | "hour", { from: number; until: number; afterConfirm: number }> = {
  day: { from: 24 * 60, until: 23 * 60, afterConfirm: 6 * 60 },
  hour: { from: 60, until: 15, afterConfirm: 30 },
};

/** At most this many meeting messages a business day are queued (app.meeting_customer_day_cap; lead's interim choice). */
export const MEETING_DAY_CAP = 200;

/** A confirmation not sent within this many hours is cancelled (its event_at). */
export const CONFIRM_EXPIRES_HOURS = 2;

/** A confirmation is queued only for a meeting that starts more than this many minutes ahead. */
export const CONFIRM_MIN_LEAD_MINUTES = 15;

/** Is the reminder of this kind due now (minutes from now until the start)? A late one is skipped, never sent late. */
export function reminderDue(kind: "day" | "hour", minutesToStart: number): boolean {
  const w = REMINDER_WINDOWS[kind];
  return minutesToStart > 0 && minutesToStart <= w.from && minutesToStart > w.until;
}

/**
 * The channel a customer is written on: the preferred one when it is SMS or email, then SMS, then email; only a channel
 * with an address (a phone the system could read for SMS, an email for email) and an active template of the message's
 * mark. null = nothing is sent. WhatsApp waits for wave 4.
 */
export function meetingChannel(customer: {
  preferred: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  templates: readonly MeetingChannel[];
}): MeetingChannel | null {
  const order: MeetingChannel[] = [];
  if (customer.preferred === "sms" || customer.preferred === "email") order.push(customer.preferred);
  order.push("sms", "email");
  for (const channel of order) {
    const address = channel === "sms" ? customer.hasPhone : customer.hasEmail;
    if (address && customer.templates.includes(channel)) return channel;
  }
  return null;
}

export const MEETING_MESSAGE_TEXTS = {
  title: "הודעות ללקוח על פגישה",
  // owner (180) א: all off until the business turns them on
  allOff: "בעסק חדש כל ההודעות האלה כבויות. מדליקים כאן רק את מה שרוצים לשלוח.",
  intro:
    "הודעות שירות ללקוח של הפגישה (איש הקשר, ואם אין, הליד), ב-SMS או באימייל לפי הערוץ המועדף שלו. לא נשלחות על זמן חסום, על פגישה בלי לקוח או על פגישה שבוטלה. ההודעות יוצאות רק כשיחובר ספק שליחה.",
  notInPlan: "אישור ותזכורות פגישה ללקוח לא כלולים בחבילה הנוכחית. בעלי העסק רואים את החבילה ב\"הגדרות > חבילה ושימוש\".",
  dayCap: `עד ${MEETING_DAY_CAP} הודעות כאלה ביום לכל עסק, ולכל טלפון או אימייל אישור אחד ביום. מעבר לכך הן לא נשלחות, והבעלים ומנהלי המערכת מקבלים התראה על המכסה היומית.`,
  confirm: "אישור כשנקבעת פגישה, והודעה כשהמועד שלה משתנה",
  confirmHint: `לא לפגישה שמתחילה בעוד פחות מ-${CONFIRM_MIN_LEAD_MINUTES} דקות; בסדרת פגישות, רק על הראשונה. פגישה שנקבעה בדף קביעת התור מקבלת אישור רק כשהלקוח כבר היה רשום לפני כן. אישור שלא יצא תוך שעתיים מבוטל. בקישור שבהודעה הלקוח מאשר, מבטל או משנה את הפגישה.`,
  day: "תזכורת 24 שעות לפני",
  hour: "תזכורת שעה לפני",
  templates: "הנוסח נלקח מהתבניות שמתחילות ב\"פגישה:\" (טיוטה, עד אישור עורך הדין).",
} as const;
