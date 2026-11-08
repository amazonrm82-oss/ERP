import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_WINDOW_FROM, DEFAULT_WINDOW_UNTIL, RATE_PER_MINUTE, shortTime, untilFromInput, untilInputValue, windowText } from "@/features/message-sending/hours";
import { sendingHoursSchema } from "@/features/message-sending/schema";

const root = join(__dirname, "..", "..");
const migration = (suffix: string) => {
  const file = readdirSync(join(root, "supabase/migrations")).find((f) => f.endsWith(suffix));
  expect(file, suffix).toBeDefined();
  return readFileSync(join(root, "supabase/migrations", file as string), "utf8");
};

describe("sending hours (MSG-06)", () => {
  const sql = migration("_message_sending_hours.sql");

  it("the defaults and the rate mirror the migration", () => {
    expect(sql).toContain(`window_from      time not null default time '${DEFAULT_WINDOW_FROM}'`);
    expect(sql).toContain(`window_until     time not null default time '${DEFAULT_WINDOW_UNTIL}'`);
    expect(sql).toContain(
      `case p_channel when 'email' then ${RATE_PER_MINUTE.email} when 'sms' then ${RATE_PER_MINUTE.sms} when 'whatsapp' then ${RATE_PER_MINUTE.whatsapp}`,
    );
  });

  it("times: midnight at the end is 24:00 in the database and 00:00 in the form", () => {
    expect(shortTime("08:00:00", "x")).toBe("08:00");
    expect(shortTime("24:00:00", "x")).toBe("24:00");
    expect(shortTime(null, "20:00")).toBe("20:00");
    expect(untilInputValue("24:00")).toBe("00:00");
    expect(untilFromInput("00:00")).toBe("24:00");
    expect(windowText({ from: "08:00", until: "20:00", skipRestDays: true })).toBe("בין 08:00 ל-20:00");
    expect(windowText({ from: "09:00", until: "24:00", skipRestDays: true })).toBe("בין 09:00 לחצות");
    expect(windowText({ from: "00:00", until: "24:00", skipRestDays: false })).toBe("כל שעות היממה");
  });

  it("the form: whole minutes, the end after the start, 00:00 as the end is midnight", () => {
    expect(sendingHoursSchema.parse({ window_from: "08:00", window_until: "20:00", skip_rest_days: "on" })).toEqual({
      window_from: "08:00",
      window_until: "20:00",
      skip_rest_days: true,
    });
    expect(sendingHoursSchema.parse({ window_from: "09:30", window_until: "00:00", skip_rest_days: null })).toEqual({
      window_from: "09:30",
      window_until: "24:00",
      skip_rest_days: false,
    });
    expect(sendingHoursSchema.safeParse({ window_from: "20:00", window_until: "08:00", skip_rest_days: "on" }).success).toBe(false);
    expect(sendingHoursSchema.safeParse({ window_from: "8:00", window_until: "20:00", skip_rest_days: "on" }).success).toBe(false);
    expect(sendingHoursSchema.safeParse({ window_from: "08:00:30", window_until: "20:00", skip_rest_days: "on" }).success).toBe(false);
  });
});
