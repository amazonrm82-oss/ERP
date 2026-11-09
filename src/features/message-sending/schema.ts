import { z } from "zod";

import { untilFromInput } from "./hours";

export const SENDING_HOURS_FIELD_NAMES = ["window_from", "window_until", "skip_rest_days"] as const;

const time = (missing: string) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string({ error: missing }).regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { error: "שעה בצורה 08:00." }),
  );

const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** MSG-06: the window of one day, whole minutes; "00:00" as the end is midnight; the end comes after the start. */
export const sendingHoursSchema = z
  .object({
    window_from: time("יש לבחור שעת התחלה."),
    window_until: time("יש לבחור שעת סיום.").transform(untilFromInput),
    skip_rest_days: z.preprocess((value) => value === "on" || value === "true", z.boolean()),
  })
  .refine((v) => minutes(v.window_until) > minutes(v.window_from), { path: ["window_until"], error: "שעת הסיום צריכה להיות אחרי שעת ההתחלה." });

export type SendingHoursInput = z.infer<typeof sendingHoursSchema>;

export const MESSAGE_CAP_FIELD_NAMES = ["monthly_cap_email", "monthly_cap_sms", "monthly_cap_whatsapp"] as const;

const CAP_RANGE = "בין 0 ל-10,000,000 הודעות.";

// empty = no cap of the business; else a whole number 0..10,000,000
const cap = z.preprocess(
  (value) => (typeof value === "string" ? (value.trim() === "" ? null : Number(value.trim().replaceAll(",", ""))) : null),
  z.number({ error: "מספר שלם של הודעות." }).int({ error: "מספר שלם של הודעות." }).min(0, { error: CAP_RANGE }).max(10_000_000, { error: CAP_RANGE }).nullable(),
);

/** MSG-05: the business's monthly cap of marketing messages per channel. */
export const messageCapsSchema = z.object({
  monthly_cap_email: cap,
  monthly_cap_sms: cap,
  monthly_cap_whatsapp: cap,
});

export type MessageCapsInput = z.infer<typeof messageCapsSchema>;

export const MEETING_MESSAGE_FIELD_NAMES = ["meeting_confirm", "meeting_remind_day", "meeting_remind_hour"] as const;

const checkbox = z.preprocess((value) => value === "on" || value === "true", z.boolean());

/** CAL-12: which meeting messages go to the customer (all off by default). */
export const meetingMessagesSchema = z.object({
  meeting_confirm: checkbox,
  meeting_remind_day: checkbox,
  meeting_remind_hour: checkbox,
});

export type MeetingMessagesInput = z.infer<typeof meetingMessagesSchema>;
