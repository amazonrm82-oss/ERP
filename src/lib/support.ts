import { whatsappUrl } from "@/lib/format";
import { SUPPORT_PHONE } from "@/lib/support-phone";

export { SUPPORT_LINE } from "@/lib/support-phone";

/**
 * How a customer reaches support (FXU-04; owner's answer of 8 October 2026:
 * a call, a WhatsApp message, or the lead form on the site once there is one).
 * The one place every message and page takes them from.
 */
const E164 = `+972${SUPPORT_PHONE.replace(/\D/g, "").replace(/^0/, "")}`;

export const SUPPORT = {
  phone: SUPPORT_PHONE,
  telHref: `tel:${E164}`,
  whatsappHref: whatsappUrl(E164) ?? "",
  // LND-12: Mexuz's own lead form; empty until the owner sets it
  formUrl: process.env.NEXT_PUBLIC_CONTACT_FORM_URL?.trim() || null,
} as const;
