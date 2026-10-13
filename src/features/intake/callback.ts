// SPD-05: "when should we call you back?" on the hosted form.
// The rules live in the database only (migration callback_slot_rules):
// public.intake_form() returns what the form offers right now, computed by
// app.intake_callback_offer() in the business's time zone, and
// public.intake_submit() resolves the choice with the same rules
// (app.intake_callback_pick()), so the page never offers what the server refuses:
// - "now" only from 08:00 to 20:00;
// - today's slots that have not ended, and the slots of the next working day
//   (rest weekdays and closed holidays skipped; "מחר" or the day's name);
// - on a short working day (Friday, holiday eve, Yom HaZikaron) before a rest
//   day of the business (app.short_work_day()), only the
//   slots that end by 15:00 and "now" until 15:00; after 15:00 it is closed;
// - minus the slots the form switched off (forms.callback_slots_off);
// - on the business's rest day neither "now" nor today's slots, only the next
//   working day's, under closedLine ("היום אנחנו סגורים. …").
// A slot's value carries the business date ("2026-10-15-09"), so a page made
// before midnight books the day it showed or is refused; never another day.

export const CALLBACK_INPUT = "callback";

/** The fixed slots (until CAP-09), as in the migration (a unit test compares). */
export const CALLBACK_SLOTS = [
  { start: "09", end: "12" },
  { start: "12", end: "15" },
  { start: "15", end: "18" },
  { start: "18", end: "20" },
] as const;

export type CallbackSlotStart = (typeof CALLBACK_SLOTS)[number]["start"];

export const CALLBACK_SLOT_STARTS = CALLBACK_SLOTS.map((slot) => slot.start) as CallbackSlotStart[];

export function isCallbackSlotStart(value: unknown): value is CallbackSlotStart {
  return typeof value === "string" && (CALLBACK_SLOT_STARTS as string[]).includes(value);
}

/** "09:00–12:00" for the settings screen. */
export function slotLabel(slot: (typeof CALLBACK_SLOTS)[number]): string {
  return `${slot.start}:00–${slot.end}:00`;
}

/** The form input of one slot's switch in the form settings. */
export function slotInputName(start: CallbackSlotStart): string {
  return `callback_slot_${start}`;
}

export type CallbackOption = { value: string; label: string };
export type CallbackGroup = { label: string; options: CallbackOption[] };
/** What the hosted form offers: "now" or not, the line of a closed day, and the slots by day. */
export type CallbackOffer = { now: boolean; closedLine: string | null; groups: CallbackGroup[] };

/** "now", or a slot: its business date and start hour, as app.intake_callback_options() makes it (built from CALLBACK_SLOTS). */
export const CALLBACK_CHOICE = new RegExp(`^(now|\\d{4}-\\d{2}-\\d{2}-(${CALLBACK_SLOT_STARTS.join("|")}))$`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The `callback` part of intake_form()'s reply; null when the form does not ask. Unknown entries are dropped. */
export function callbackOfferFrom(value: unknown): CallbackOffer | null {
  if (!isRecord(value)) return null;
  const groups: CallbackGroup[] = [];
  for (const group of Array.isArray(value.groups) ? value.groups : []) {
    if (!isRecord(group) || typeof group.label !== "string" || group.label.trim() === "") continue;
    const options = (Array.isArray(group.options) ? group.options : [])
      .filter(isRecord)
      .filter((o): o is { value: string; label: string } => typeof o.value === "string" && o.value !== "now" && CALLBACK_CHOICE.test(o.value) && typeof o.label === "string")
      .map((o) => ({ value: o.value, label: o.label }));
    if (options.length > 0) groups.push({ label: group.label, options });
  }
  const closedLine = typeof value.closed_line === "string" && value.closed_line.trim() !== "" ? value.closed_line : null;
  return { now: value.now === true, closedLine, groups };
}
