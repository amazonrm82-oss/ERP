// AUT-03: the "fixed schedule" trigger (trigger type schedule, trigger_config {frequency, time, days?}). The engine
// (app.run_schedule_automations, every 15 minutes) runs the rule once per record that meets its conditions at each
// scheduled time in the business's time zone; a time is worked on for 24 hours, then dropped. These helpers turn the
// builder's values into the stored setting and back, as app.schedule_slot reads it.

export const SCHEDULE_FREQUENCIES = ["daily", "weekly"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

/** The job runs every 15 minutes, so the minutes offered are the quarters of an hour. */
export const SCHEDULE_MINUTES = ["00", "15", "30", "45"] as const;

/** 0 = Sunday, as the weekday condition (AUT-05) and PostgreSQL's dow. */
export const WEEKDAYS: Array<{ value: number; label: string; short: string }> = [
  { value: 0, label: "ראשון", short: "א׳" },
  { value: 1, label: "שני", short: "ב׳" },
  { value: 2, label: "שלישי", short: "ג׳" },
  { value: 3, label: "רביעי", short: "ד׳" },
  { value: 4, label: "חמישי", short: "ה׳" },
  { value: 5, label: "שישי", short: "ו׳" },
  { value: 6, label: "שבת", short: "ש׳" },
];

/**
 * At most this many runs per business in one pass of the job (app.schedule_runs_per_business), shared among its rules;
 * a pass also stops at 2,000 runs across all businesses (app.schedule_runs_per_pass).
 */
export const SCHEDULE_RUNS_PER_BUSINESS = 200;

export type ScheduleConfig = { frequency: ScheduleFrequency; time: string; days?: number[] };

const TIME = /^([01][0-9]|2[0-3]):(00|15|30|45)$/;

/** The builder's values -> the stored trigger setting, or a Hebrew message. */
export function scheduleTriggerConfig(input: { frequency?: string; time?: string; days?: number[] }): ScheduleConfig | string {
  const frequency = input.frequency === "weekly" ? "weekly" : input.frequency === "daily" ? "daily" : null;
  if (!frequency) return "יש לבחור כל כמה זמן.";
  if (!input.time || !TIME.test(input.time)) return "יש לבחור שעה (ברבעי שעה).";
  if (frequency === "daily") return { frequency, time: input.time };
  const days = [...new Set(input.days ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length === 0) return "יש לבחור לפחות יום אחד בשבוע.";
  return { frequency, time: input.time, days };
}

/** A stored setting -> the builder's values. */
export function scheduleTriggerDraft(config: Record<string, unknown>): { frequency: ScheduleFrequency; hour: string; minute: string; days: number[] } {
  const frequency: ScheduleFrequency = config.frequency === "weekly" ? "weekly" : "daily";
  const time = typeof config.time === "string" && /^\d{2}:\d{2}$/.test(config.time) ? config.time : "09:00";
  const days = Array.isArray(config.days) ? config.days.filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return { frequency, hour: time.slice(0, 2), minute: time.slice(3, 5), days };
}

/** "כל יום ב-09:00", "בימים ראשון, רביעי ב-08:30". */
export function describeScheduleTrigger(config: Record<string, unknown>): string {
  const draft = scheduleTriggerDraft(config);
  const time = `${draft.hour}:${draft.minute}`;
  if (draft.frequency === "daily") return `כל יום ב-${time}`;
  const names = WEEKDAYS.filter((d) => draft.days.includes(d.value)).map((d) => d.label);
  if (names.length === 0) return `כל שבוע ב-${time}`;
  return `${names.length === 1 ? "ביום" : "בימים"} ${names.join(", ")} ב-${time}`;
}
