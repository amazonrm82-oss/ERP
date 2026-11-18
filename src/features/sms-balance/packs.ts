// SMS-06 (owner, 18 November 2026): SMS is sold as prepaid packs of segments; packs add up and the balance does not expire
// while the business is active. Mirrors app.sms_packs() and app.sms_service_overdraft() (migration sms_packs; unit test
// sms-segments compares them).

export type SmsPack = { segments: number; priceAgorot: number };

/** The packs, prices in agorot before VAT (35 / 99 / 390 ₪). */
export const SMS_PACKS: readonly SmsPack[] = [
  { segments: 300, priceAgorot: 3500 },
  { segments: 1000, priceAgorot: 9900 },
  { segments: 5000, priceAgorot: 39000 },
];

/** How far below 0 a service SMS may take the balance; the next pack covers it. */
export const SMS_SERVICE_OVERDRAFT = 50;

export const SMS_MOVEMENT_KINDS = ["grant", "purchase", "charge", "refund", "clear"] as const;
export type SmsMovementKind = (typeof SMS_MOVEMENT_KINDS)[number];

export const SMS_MOVEMENT_LABELS: Record<SmsMovementKind, string> = {
  grant: "טעינת חבילה",
  purchase: "רכישת חבילה",
  charge: "שליחת SMS",
  refund: "החזר: ההודעה לא נשלחה",
  clear: "איפוס היתרה",
};

export type SmsChannelState = "off_plan" | "no_balance" | "open";

export type SmsMovement = { kind: SmsMovementKind; segments: number; balanceAfter: number; pack: number | null; at: string };

export type SmsBalance = {
  channel: SmsChannelState | null;
  balance: number;
  loaded: boolean;
  lastLoad: number | null;
  lowAt: number | null;
  overdraft: number;
  movements: SmsMovement[];
};

const isKind = (v: unknown): v is SmsMovementKind => typeof v === "string" && (SMS_MOVEMENT_KINDS as readonly string[]).includes(v);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** public.sms_balance_summary's answer (or the platform read's), checked; null when not allowed or malformed. */
export function parseSmsBalance(raw: unknown): SmsBalance | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.allowed === false) return null;
  const balance = int(r.balance);
  if (balance === null) return null;
  const channel = r.channel === "off_plan" || r.channel === "no_balance" || r.channel === "open" ? r.channel : null;
  const movements = Array.isArray(r.movements)
    ? r.movements.flatMap((m): SmsMovement[] => {
        if (!m || typeof m !== "object") return [];
        const x = m as Record<string, unknown>;
        const segments = int(x.segments);
        const after = int(x.balance_after);
        if (!isKind(x.kind) || segments === null || after === null || typeof x.at !== "string") return [];
        return [{ kind: x.kind, segments, balanceAfter: after, pack: int(x.pack), at: x.at }];
      })
    : [];
  return {
    channel,
    balance,
    loaded: r.loaded === true,
    lastLoad: int(r.last_load),
    lowAt: int(r.low_at),
    overdraft: int(r.overdraft) ?? SMS_SERVICE_OVERDRAFT,
    movements,
  };
}

/** The balance in one line, plain Hebrew (DRAFT wording). */
export function smsBalanceLine(b: SmsBalance): string {
  if (!b.loaded) return "לעסק אין עדיין יתרת SMS, ולכן שליחת SMS ללקוחות כבויה.";
  if (b.balance < 0) return `היתרה במינוס: ${Math.abs(b.balance)} מקטעים. הם יקוזזו מהחבילה הבאה.`;
  if (b.balance === 0) return "היתרה נגמרה. הודעות שיווק מחכות עד 24 שעות ואז מתבטלות; הודעות שירות יוצאות עד 50 מקטעים במינוס.";
  return `נשארו ${b.balance} מקטעי SMS.`;
}

/** The offer to buy (DRAFT wording; payment through us until a clearing provider is chosen). */
export const SMS_OFFER_TEXT =
  "SMS נמכר בחבילות מראש. החבילות מצטברות, והיתרה לא פגה כל עוד העסק פעיל. מקטע הוא עד 70 תווים בעברית (160 באנגלית); הודעה ארוכה יותר נספרת כמה מקטעים. כדי לרכוש חבילה, דברו איתנו:";

export const SMS_PACK_NOTE = "המחירים לפני מע\"מ.";
