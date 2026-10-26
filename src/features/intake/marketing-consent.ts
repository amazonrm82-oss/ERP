// CAP-07 / CNS-04: the marketing-consent boxes of the public web form. forms.marketing_consent_channels turns a box on
// per channel; a box shows only while the form collects its address (the email field for email, the phone field for SMS
// and WhatsApp), never ticked in advance. intake_form() returns the boxes with the business's wording; intake_submit()
// writes one form consent per ticked box (public.consents, source 'form', wording and version) and keeps them with the
// inquiry. The wording is a DRAFT until the lawyer edits it (owner, 8 October 2026). This file mirrors
// app.marketing_consent_version() and app.marketing_consent_wording() of migration *_form_marketing_consent.sql (a unit
// test reads it): changing the text means a new version in a new migration.

import type { Json } from "@/lib/database.types";

export const MARKETING_CONSENT_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type MarketingConsentChannel = (typeof MARKETING_CONSENT_CHANNELS)[number];

/** The version stored with every consent the form records. DRAFT wording. */
export const MARKETING_CONSENT_VERSION = "form-draft-1";

/** The input's name on the hosted form (one checkbox per channel, value = the channel), and the payload key. */
export const MARKETING_CONSENT_INPUT = "marketing_consent";

/** Shown in the form settings next to the wording (never on the public page). */
export const MARKETING_CONSENT_DRAFT_NOTE = "נוסח טיוטה, עד שעורך דין יאשר אותו.";

const CHANNEL_PHRASE: Record<MarketingConsentChannel, string> = { email: "באימייל", sms: "ב-SMS", whatsapp: "בוואטסאפ" };

export const MARKETING_CONSENT_LABELS: Record<MarketingConsentChannel, string> = { email: "אימייל", sms: "SMS", whatsapp: "וואטסאפ" };

export function isMarketingConsentChannel(value: unknown): value is MarketingConsentChannel {
  return typeof value === "string" && (MARKETING_CONSENT_CHANNELS as readonly string[]).includes(value);
}

/** The box's text for a channel, naming the business by its display name (= app.marketing_consent_wording). */
export function marketingConsentWording(channel: MarketingConsentChannel, business: string): string {
  const name = business.trim() || "הזה";
  return `אני מאשר/ת לקבל עדכונים ופרסומות ${CHANNEL_PHRASE[channel]} מהעסק ${name}. אפשר לבטל את ההסכמה בכל עת.`;
}

/** The field a channel's address comes from on the form. */
export function addressField(channel: MarketingConsentChannel): "email" | "phone" {
  return channel === "email" ? "email" : "phone";
}

/** The channels a form shows a box for: turned on and collected by the form, in the fixed order (= app.form_marketing_channels). */
export function formMarketingChannels(channels: readonly string[], fieldKeys: readonly string[]): MarketingConsentChannel[] {
  return MARKETING_CONSENT_CHANNELS.filter((channel) => channels.includes(channel) && fieldKeys.includes(addressField(channel)));
}

/** Settings form: the ticked channels (inputs marketing_consent_<channel>), in order. */
export function marketingConsentSetting(formData: FormData): MarketingConsentChannel[] {
  return MARKETING_CONSENT_CHANNELS.filter((channel) => formData.get(`${MARKETING_CONSENT_INPUT}_${channel}`) === "on");
}

export type MarketingConsentBox = { channel: MarketingConsentChannel; text: string };
export type MarketingConsentOffer = { version: string; boxes: MarketingConsentBox[] };

function isObject(value: unknown): value is Record<string, Json | undefined> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** intake_form().marketing_consent as the boxes to show, or null for none. */
export function marketingConsentFrom(data: Json | undefined): MarketingConsentOffer | null {
  if (!isObject(data) || typeof data.version !== "string" || !Array.isArray(data.channels)) {
    return null;
  }
  const boxes: MarketingConsentBox[] = [];
  for (const item of data.channels) {
    if (isObject(item) && isMarketingConsentChannel(item.channel) && typeof item.text === "string" && item.text.trim() !== "") {
      if (!boxes.some((box) => box.channel === item.channel)) {
        boxes.push({ channel: item.channel, text: item.text });
      }
    }
  }
  return boxes.length > 0 ? { version: data.version, boxes } : null;
}

/** The ticked boxes of a post (one value or a list), only channels the form shows; the database checks again. */
export function marketingConsentInput(value: unknown, offer: MarketingConsentOffer | null): MarketingConsentChannel[] {
  if (!offer) {
    return [];
  }
  const sent = (Array.isArray(value) ? value : [value]).slice(0, 10);
  return offer.boxes.map((box) => box.channel).filter((channel) => sent.includes(channel));
}
