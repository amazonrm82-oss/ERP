// MSG-06 (owner 4 November 2026, answers (119)-(121)): the sending window of messages to customers. The rule itself lives in
// the database (app.message_window_open_at, public.job_message_may_send); this file holds the defaults, the form's time
// format and the texts the settings page shows.

export const DEFAULT_WINDOW_FROM = "08:00";
export const DEFAULT_WINDOW_UNTIL = "20:00";
/** On a short working day (a Friday or a holiday eve before a rest day) sending ends at this hour (SPD-05's rule). */
export const SHORT_DAY_UNTIL = "15:00";

/** (121) א: a fixed system rate, messages a minute per business and channel (= app.message_rate_per_minute). */
export const RATE_PER_MINUTE = { email: 60, sms: 30, whatsapp: 20 } as const;
/** (133) ג: the system-wide rate across all businesses, 10x, until a provider sets one (= app.message_system_rate_per_minute). */
export const SYSTEM_RATE_PER_MINUTE = { email: 600, sms: 300, whatsapp: 200 } as const;

export type SendingHours = { from: string; until: string; skipRestDays: boolean };

/** "HH:MM" from the database's "HH:MM:SS"; midnight at the end of the day ("24:00:00") stays "24:00". */
export function shortTime(value: string | null | undefined, fallback: string): string {
  const match = /^([01][0-9]|2[0-4]):([0-5][0-9])/.exec(value ?? "");
  return match ? `${match[1]}:${match[2]}` : fallback;
}

/** The value a time input shows for the end of the window: midnight is "00:00" there. */
export function untilInputValue(until: string): string {
  return until === "24:00" ? "00:00" : until;
}

/** The end of the window as typed: "00:00" means until midnight. */
export function untilFromInput(value: string): string {
  return value === "00:00" ? "24:00" : value;
}

/** The window in words, for the page: "בין 08:00 ל-20:00" ("לחצות" for midnight). */
export function windowText(hours: SendingHours): string {
  if (hours.from === "00:00" && hours.until === "24:00") return "כל שעות היממה";
  if (hours.until === "24:00") return `בין ${hours.from} לחצות`;
  return `בין ${hours.from} ל-${hours.until}`;
}
