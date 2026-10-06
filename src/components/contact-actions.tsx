import { buttonClasses } from "@/components/ui/button";
import { ChatIcon, MailIcon, PhoneIcon } from "@/components/ui/icons";
import { telUrl, whatsappUrl } from "@/lib/format";

type Props = { phone: string | null; phoneE164: string | null; email: string | null };

/** One-tap ways to reach a person: call, WhatsApp, email. Renders nothing when there is no way. */
export function ContactActions({ phone, phoneE164, email }: Props) {
  const tel = telUrl(phoneE164, phone);
  const whatsapp = whatsappUrl(phoneE164);
  if (!tel && !whatsapp && !email) {
    return null;
  }
  return (
    <ul className="flex flex-wrap gap-2" aria-label="יצירת קשר">
      {tel ? (
        <li>
          <a href={tel} className={buttonClasses("secondary", "sm")}>
            <PhoneIcon className="size-4.5 text-accent" />
            חיוג
          </a>
        </li>
      ) : null}
      {whatsapp ? (
        <li>
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
            <ChatIcon className="size-4.5 text-accent" />
            <span dir="ltr">WhatsApp</span>
            <span className="sr-only">(נפתח בחלון חדש)</span>
          </a>
        </li>
      ) : null}
      {email ? (
        <li>
          <a href={`mailto:${email}`} className={buttonClasses("secondary", "sm")}>
            <MailIcon className="size-4.5 text-accent" />
            אימייל
          </a>
        </li>
      ) : null}
    </ul>
  );
}
