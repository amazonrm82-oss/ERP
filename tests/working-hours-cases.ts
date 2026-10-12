// USR-01: stored working hours shapes and whether they are valid. The unit tests
// check src/features/profile/working-hours.ts against this table and the
// database tests check app.working_hours_ok() against it, so the two stay in step.

const r = (start: string, end: string) => ({ start, end });

export const WORKING_HOURS_CASES: { name: string; value: unknown; ok: boolean }[] = [
  // not set / empty week
  { name: "null", value: null, ok: true },
  { name: "empty week", value: {}, ok: true },
  // first version: one object per day (rows of it exist on the hosted project)
  { name: "old: one day", value: { sat: r("00:00", "23:59") }, ok: true },
  { name: "old: two days", value: { sun: r("09:00", "17:00"), mon: r("10:00", "12:00") }, ok: true },
  { name: "old: end before start", value: { sun: r("17:00", "09:00") }, ok: false },
  { name: "old: start equals end", value: { sun: r("09:00", "09:00") }, ok: false },
  { name: "old: 24:00", value: { sun: r("09:00", "24:00") }, ok: false },
  { name: "old: one digit hour", value: { sun: r("9:00", "17:00") }, ok: false },
  { name: "old: missing end", value: { sun: { start: "09:00" } }, ok: false },
  { name: "old: extra key", value: { sun: { start: "09:00", end: "17:00", note: "x" } }, ok: false },
  { name: "old: numbers", value: { sun: { start: 900, end: 1700 } }, ok: false },
  // new: a list of 1 to 3 ranges per day
  { name: "new: one range", value: { sun: [r("09:00", "17:00")] }, ok: true },
  { name: "new: split day", value: { sun: [r("08:00", "12:00"), r("16:00", "19:00")] }, ok: true },
  { name: "new: three ranges", value: { mon: [r("06:00", "08:00"), r("09:00", "12:00"), r("18:00", "23:59")] }, ok: true },
  { name: "new: ranges that touch", value: { tue: [r("08:00", "12:00"), r("12:00", "16:00")] }, ok: true },
  { name: "mixed: old and new days", value: { sun: r("09:00", "17:00"), mon: [r("08:00", "12:00"), r("16:00", "19:00")] }, ok: true },
  { name: "new: empty list", value: { sun: [] }, ok: false },
  {
    name: "new: four ranges",
    value: { sun: [r("06:00", "07:00"), r("08:00", "09:00"), r("10:00", "11:00"), r("12:00", "13:00")] },
    ok: false,
  },
  { name: "new: overlapping", value: { sun: [r("08:00", "12:00"), r("11:00", "14:00")] }, ok: false },
  { name: "new: one inside another", value: { sun: [r("08:00", "18:00"), r("10:00", "12:00")] }, ok: false },
  { name: "new: unsorted", value: { sun: [r("16:00", "19:00"), r("08:00", "12:00")] }, ok: false },
  { name: "new: same range twice", value: { sun: [r("08:00", "12:00"), r("08:00", "12:00")] }, ok: false },
  { name: "new: end before start", value: { sun: [r("08:00", "12:00"), r("19:00", "16:00")] }, ok: false },
  { name: "new: start equals end", value: { sun: [r("08:00", "08:00")] }, ok: false },
  { name: "new: bad time", value: { sun: [r("08:00", "12:60")] }, ok: false },
  { name: "new: 24:00", value: { sun: [r("20:00", "24:00")] }, ok: false },
  { name: "new: extra key", value: { sun: [{ start: "08:00", end: "12:00", x: 1 }] }, ok: false },
  { name: "new: missing start", value: { sun: [{ end: "12:00" }] }, ok: false },
  { name: "new: a string in the list", value: { sun: ["08:00-12:00"] }, ok: false },
  { name: "new: null in the list", value: { sun: [null] }, ok: false },
  { name: "new: nested list", value: { sun: [[r("08:00", "12:00")]] }, ok: false },
  // not a week at all
  { name: "unknown day", value: { sunday: r("09:00", "17:00") }, ok: false },
  { name: "unknown day, new shape", value: { xyz: [r("09:00", "17:00")] }, ok: false },
  { name: "day is null", value: { sun: null }, ok: false },
  { name: "day is a string", value: { sun: "09-17" }, ok: false },
  { name: "top-level list", value: [], ok: false },
  { name: "string", value: "09:00-17:00", ok: false },
  { name: "number", value: 1, ok: false },
];
