import { whatsappUrl } from "@/lib/format";
import { SUPPORT_PHONE } from "@/lib/support-phone";

export { SUPPORT_LINE } from "@/lib/support-phone";

/**
 * How a customer reaches support (FXU-04; owner's answer of 8 October 2026:
 * a call, a WhatsApp message, or the lead form on the site once there is one).
 * The one place every message and page takes them from.
 */
/** The owner's "דברו איתנו" lead form (LND-12). */
export const CONTACT_FORM_PATH = "/f/32bd5218d280423fa83fa0f553c62588";

const E164 = `+972${SUPPORT_PHONE.replace(/\D/g, "").replace(/^0/, "")}`;

export const SUPPORT = {
  phone: SUPPORT_PHONE,
  telHref: `tel:${E164}`,
  whatsappHref: whatsappUrl(E164) ?? "",
  // LND-12: Mexuz's own lead form, made by the owner in his business in the system (4 November 2026). A path on the
  // same site, so it follows the domain; NEXT_PUBLIC_CONTACT_FORM_URL overrides it.
  formUrl: process.env.NEXT_PUBLIC_CONTACT_FORM_URL?.trim() || CONTACT_FORM_PATH,
} as const;
