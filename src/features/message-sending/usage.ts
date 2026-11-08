import { z } from "zod";

// MSG-05 (owner 4 November 2026, answers (122)-(125)): the usage of messages per channel this month, and the caps. Counted in
// the database (app.message_usage_days, public.job_message_may_send); read with public.message_usage (owners and admins).

export const MESSAGE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type MessageChannelKey = (typeof MESSAGE_CHANNELS)[number];

export const CHANNEL_LABELS: Record<MessageChannelKey, string> = { email: "אימייל", sms: "SMS", whatsapp: "WhatsApp" };

/** The form's field of each channel's cap (= the columns of org_message_settings). */
export const CAP_FIELDS: Record<MessageChannelKey, "monthly_cap_email" | "monthly_cap_sms" | "monthly_cap_whatsapp"> = {
  email: "monthly_cap_email",
  sms: "monthly_cap_sms",
  whatsapp: "monthly_cap_whatsapp",
};

export const CAP_MAX = 10_000_000;
/** The share of the month's cap at which the owners and admins are told (= the database's used x 5 >= cap x 4). */
export const WARN_SHARE = 0.8;

const count = z.number().int().min(0);
const cap = count.nullable();

const channelSchema = z.object({
  channel: z.enum(MESSAGE_CHANNELS),
  marketing: count,
  service: count,
  marketing_today: count,
  business_cap: cap,
  plan_month_cap: cap,
  plan_day_cap: cap,
  waiting_cap: count,
  waiting_hours: count,
});

const usageSchema = z.union([
  z.object({ allowed: z.literal(false) }),
  z.object({ allowed: z.literal(true), month: z.string().regex(/^[0-9]{4}-[0-9]{2}$/), channels: z.array(channelSchema) }),
]);

export type ChannelUsage = {
  channel: MessageChannelKey;
  marketing: number;
  service: number;
  marketingToday: number;
  businessCap: number | null;
  planMonthCap: number | null;
  planDayCap: number | null;
  /** the month's cap of marketing: the lower of the business's cap and the plan's quota (null = none) */
  cap: number | null;
  waitingCap: number;
  waitingHours: number;
};

export type MessageUsage = { allowed: false } | { allowed: true; month: string; channels: ChannelUsage[] };

/** The lower of two caps; null means no cap (= SQL least(), which skips nulls). */
export function effectiveCap(business: number | null, plan: number | null): number | null {
  if (business === null) return plan;
  if (plan === null) return business;
  return Math.min(business, plan);
}

/** Parses public.message_usage; a malformed answer throws (the page shows its error screen). */
export function parseMessageUsage(raw: unknown): MessageUsage {
  const parsed = usageSchema.parse(raw);
  if (!parsed.allowed) return { allowed: false };
  return {
    allowed: true,
    month: parsed.month,
    channels: parsed.channels.map((c) => ({
      channel: c.channel,
      marketing: c.marketing,
      service: c.service,
      marketingToday: c.marketing_today,
      businessCap: c.business_cap,
      planMonthCap: c.plan_month_cap,
      planDayCap: c.plan_day_cap,
      cap: effectiveCap(c.business_cap, c.plan_month_cap),
      waitingCap: c.waiting_cap,
      waitingHours: c.waiting_hours,
    })),
  };
}

/** Whether the month's marketing has reached the warning share of its cap. */
export function nearCap(usage: Pick<ChannelUsage, "marketing" | "cap">): boolean {
  return usage.cap !== null && usage.cap > 0 && usage.marketing * 5 >= usage.cap * 4;
}

/** The month's line: "120 מתוך 1,000 הודעות שיווק" or "120 הודעות שיווק · בלי תקרה". */
export function marketingLine(usage: Pick<ChannelUsage, "marketing" | "cap">, format: (n: number) => string): string {
  if (usage.cap === null) return `${format(usage.marketing)} הודעות שיווק · בלי תקרה`;
  const full = usage.marketing >= usage.cap;
  return `${format(usage.marketing)} מתוך ${format(usage.cap)} הודעות שיווק${full ? " · התקרה מלאה" : nearCap(usage) ? " · קרוב לתקרה" : ""}`;
}
