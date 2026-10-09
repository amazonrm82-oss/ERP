import { buttonClasses, iconButtonClasses } from "@/components/ui/button";
import { ChatIcon, MailIcon, PhoneIcon, UsersIcon } from "@/components/ui/icons";
import { CallLogButton } from "@/features/activities/components/call-log-button";
import type { TimelineSubject } from "@/features/activities/schema";
import { telUrl, whatsappUrl } from "@/lib/format";

type Props = {
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  // in a list row: call and WhatsApp as icon buttons, named after the person
  compact?: { name: string };
  // a record page: download the person's card into the phone's contacts (GAP-02)
  saveHref?: string;
  // a record page: after dialling, offer to log the call (TASK-02)
  callLog?: { orgId: string; subject: TimelineSubject; name: string };
};

/** One-tap ways to reach a person: call, WhatsApp, email. Renders nothing when there is no way. */
export function ContactActions({ phone, phoneE164, email, compact, saveHref, callLog }: Props) {
  const tel = telUrl(phoneE164, phone);
  const whatsapp = whatsappUrl(phoneE164);
  if (compact) {
    if (!tel && !whatsapp) return null;
    const icon = iconButtonClasses("secondary");
    return (
      <span className="flex shrink-0 gap-1.5">
        {tel ? (
          <a href={tel} aria-label={`חיוג אל ${compact.name}`} title="חיוג" className={icon}>
            <PhoneIcon className="size-5 text-accent" />
          </a>
        ) : null}
        {whatsapp ? (
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp אל ${compact.name} (נפתח בחלון חדש)`} title="WhatsApp" className={icon}>
            <ChatIcon className="size-5 text-accent" />
          </a>
        ) : null}
      </span>
    );
  }
  if (!tel && !whatsapp && !email) {
    return null;
  }
  return (
    <ul className="flex flex-wrap gap-2" aria-label="יצירת קשר">
      {tel ? (
        <li>
          {callLog ? (
            <CallLogButton tel={tel} {...callLog} />
          ) : (
            <a href={tel} className={buttonClasses("secondary", "sm")}>
              <PhoneIcon className="size-4.5 text-accent" />
              חיוג
            </a>
          )}
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
      {saveHref && (tel || email) ? (
        <li>
          <a href={saveHref} download className={buttonClasses("secondary", "sm")}>
            <UsersIcon className="size-4.5 text-accent" />
            שמירה באנשי הקשר בטלפון
          </a>
        </li>
      ) : null}
    </ul>
  );
}
