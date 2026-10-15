import type { WhatsappLog } from "../templates";
import { WhatsappButton } from "./whatsapp-button";

/**
 * WA-01 follow-up: a list table's phone cell. The number, and for someone who can write and a
 * valid phone the WhatsApp templates icon (same window and timeline entry as the record page).
 */
export function PhoneCell({ phone, phoneE164, whatsappLog }: { phone: string | null; phoneE164: string | null; whatsappLog?: WhatsappLog }) {
  if (!phone) return null;
  return (
    <span className="flex items-center gap-2">
      <span dir="ltr" className="whitespace-nowrap">
        {phone}
      </span>
      {whatsappLog && phoneE164 ? <WhatsappButton phoneE164={phoneE164} {...whatsappLog} iconOnly /> : null}
    </span>
  );
}
