/**
 * INT-01: the integrations catalog, by category. Only what the code really has is "available": Meta Lead Ads (CAP-11, a
 * business's own page connected by its page token). SMS goes out through one platform account (owner's answer 207), so
 * the SMS providers are shown as managed by the system, never as a business's connection. Email and payment providers are
 * not chosen yet (owner decisions): shown as coming soon, without naming a provider.
 */

export type CatalogAvailability = "available" | "platform" | "coming_soon";

export type CatalogItem = {
  key: string;
  name: string;
  description: string;
  availability: CatalogAvailability;
  /** the provider code in public.integrations, for an item a business connects itself */
  provider?: "meta_lead_ads";
};

export type CatalogCategory = { key: string; label: string; items: CatalogItem[] };

export const INTEGRATIONS_CATALOG: readonly CatalogCategory[] = [
  {
    key: "leads",
    label: "לידים ממודעות",
    items: [
      {
        key: "meta_lead_ads",
        name: "פייסבוק ואינסטגרם (טופסי לידים)",
        description: "מי שממלא טופס לידים במודעה נכנס למערכת כליד, עם המקור ושם הקמפיין.",
        availability: "available",
        provider: "meta_lead_ads",
      },
    ],
  },
  {
    key: "sms",
    label: "הודעות SMS",
    items: [
      {
        key: "inforu",
        name: "InforU",
        description: "הודעות SMS יוצאות מחשבון אחד של מקסוז. אין צורך לחבר חשבון משלכם.",
        availability: "platform",
      },
      {
        key: "sms4free",
        name: "SMS4Free",
        description: "הודעות SMS יוצאות מחשבון אחד של מקסוז. אין צורך לחבר חשבון משלכם.",
        availability: "platform",
      },
    ],
  },
  {
    key: "email",
    label: "אימייל",
    items: [
      {
        key: "email",
        name: "שליחת אימייל ללקוחות",
        description: "חיבור לספק אימייל לשליחה מהמערכת.",
        availability: "coming_soon",
      },
    ],
  },
  {
    key: "payments",
    label: "תשלומים וסליקה",
    items: [
      {
        key: "payments",
        name: "סליקת אשראי וקבלות",
        description: "חיבור לחברת סליקה, כדי שתשלומים ומסמכים ייכנסו למערכת לבד.",
        availability: "coming_soon",
      },
    ],
  },
];

export const AVAILABILITY_LABELS: Record<CatalogAvailability, string> = {
  available: "אפשר לחבר",
  platform: "מנוהל על ידי מקסוז",
  coming_soon: "בקרוב",
};
