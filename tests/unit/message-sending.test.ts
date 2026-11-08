import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_WINDOW_FROM, DEFAULT_WINDOW_UNTIL, RATE_PER_MINUTE, shortTime, untilFromInput, untilInputValue, windowText } from "@/features/message-sending/hours";
import { messageCapsSchema, sendingHoursSchema } from "@/features/message-sending/schema";
import { CAP_MAX, effectiveCap, marketingLine, nearCap, parseMessageUsage, WARN_SHARE } from "@/features/message-sending/usage";

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

describe("usage and caps (MSG-05)", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    allowed: true,
    month: "2026-11",
    channels: [
      {
        channel: "email",
        marketing: 800,
        service: 12,
        marketing_today: 40,
        business_cap: 1000,
        plan_month_cap: 2000,
        plan_day_cap: 200,
        waiting_cap: 0,
        waiting_hours: 3,
        ...over,
      },
    ],
  });

  it("the month's cap is the lower of the business's and the plan's; null is none", () => {
    expect(effectiveCap(null, null)).toBeNull();
    expect(effectiveCap(1000, null)).toBe(1000);
    expect(effectiveCap(null, 2000)).toBe(2000);
    expect(effectiveCap(3000, 2000)).toBe(2000);
    const usage = parseMessageUsage(raw());
    expect(usage.allowed && usage.channels[0]).toMatchObject({ cap: 1000, marketingToday: 40, waitingHours: 3 });
  });

  it("the 80% line matches the database's rule (used x 5 >= cap x 4)", () => {
    expect(WARN_SHARE).toBe(0.8);
    expect(nearCap({ marketing: 799, cap: 1000 })).toBe(false);
    expect(nearCap({ marketing: 800, cap: 1000 })).toBe(true);
    expect(nearCap({ marketing: 5, cap: null })).toBe(false);
    expect(nearCap({ marketing: 0, cap: 0 })).toBe(false);
    const f = (n: number) => String(n);
    expect(marketingLine({ marketing: 800, cap: 1000 }, f)).toBe("800 מתוך 1000 הודעות שיווק · קרוב לתקרה");
    expect(marketingLine({ marketing: 1000, cap: 1000 }, f)).toBe("1000 מתוך 1000 הודעות שיווק · התקרה מלאה");
    expect(marketingLine({ marketing: 3, cap: null }, f)).toBe("3 הודעות שיווק · בלי תקרה");
  });

  it("a malformed answer is an error; allowed: false is passed on", () => {
    expect(parseMessageUsage({ allowed: false })).toEqual({ allowed: false });
    expect(() => parseMessageUsage(raw({ marketing: -1 }))).toThrow();
    expect(() => parseMessageUsage(raw({ channel: "fax" }))).toThrow();
    expect(() => parseMessageUsage(null)).toThrow();
  });

  it("the caps form: empty = no cap, whole numbers 0..10,000,000", () => {
    expect(messageCapsSchema.parse({ monthly_cap_email: "", monthly_cap_sms: "1,500", monthly_cap_whatsapp: "0" })).toEqual({
      monthly_cap_email: null,
      monthly_cap_sms: 1500,
      monthly_cap_whatsapp: 0,
    });
    for (const bad of ["1.5", "-1", "10000001", "abc"]) {
      expect(messageCapsSchema.safeParse({ monthly_cap_email: bad, monthly_cap_sms: "", monthly_cap_whatsapp: "" }).success, bad).toBe(false);
    }
  });

  it("the caps' range and the notice share mirror the migration", () => {
    const sql = migration("_message_usage_caps.sql");
    expect(sql).toContain(`monthly_cap_email is null or monthly_cap_email between 0 and ${CAP_MAX}`);
    expect(sql).toContain("v_used_month * 5 >= v_cap * 4");
  });
});
