import type { ReactNode } from "react";

import { buttonClasses, iconButtonClasses } from "@/components/ui/button";
import { ChatIcon, MailIcon, PhoneIcon, UsersIcon } from "@/components/ui/icons";
import { CallLogButton } from "@/features/activities/components/call-log-button";
import type { TimelineSubject } from "@/features/activities/schema";
import { WhatsappButton } from "@/features/whatsapp/components/whatsapp-button";
import type { TemplateValues } from "@/features/whatsapp/templates";
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
  // someone who can write (a record page, and since the WA-01 follow-up a list row): WhatsApp offers the
  // templates and logs the message
  whatsappLog?: { orgId: string; subject: TimelineSubject; name: string; values: TemplateValues };
  // a record page (CON-10): the person's preferred channel; its button comes first and it is named
  preferred?: { channel: string; label: string } | null;
};

/** One-tap ways to reach a person: call, WhatsApp, email. Renders nothing when there is no way. */
export function ContactActions({ phone, phoneE164, email, compact, saveHref, callLog, whatsappLog, preferred }: Props) {
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
        {whatsapp && whatsappLog && phoneE164 ? (
          // WA-01 follow-up: the templates and the timeline entry, as on the record page
          <WhatsappButton phoneE164={phoneE164} {...whatsappLog} iconOnly />
        ) : whatsapp ? (
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
  // CON-10: the person's preferred way is offered first and named under the buttons (display only)
  const items: Array<{ key: string; node: ReactNode }> = [];
  if (tel) {
    items.push({
      key: "phone",
      node: callLog ? (
        <CallLogButton tel={tel} {...callLog} />
      ) : (
        <a href={tel} className={buttonClasses("secondary", "sm")}>
          <PhoneIcon className="size-4.5 text-accent" />
          חיוג
        </a>
      ),
    });
  }
  if (whatsapp) {
    items.push({
      key: "whatsapp",
      node:
        whatsappLog && phoneE164 ? (
          <WhatsappButton phoneE164={phoneE164} {...whatsappLog} />
        ) : (
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
            <ChatIcon className="size-4.5 text-accent" />
            <span dir="ltr">WhatsApp</span>
            <span className="sr-only">(נפתח בחלון חדש)</span>
          </a>
        ),
    });
  }
  if (email) {
    items.push({
      key: "email",
      node: (
        <a href={`mailto:${email}`} className={buttonClasses("secondary", "sm")}>
          <MailIcon className="size-4.5 text-accent" />
          אימייל
        </a>
      ),
    });
  }
  const first = items.findIndex((item) => item.key === preferred?.channel);
  if (first > 0) items.unshift(...items.splice(first, 1));
  return (
    <div>
      <ul className="flex flex-wrap gap-2" aria-label="יצירת קשר">
        {items.map((item) => (
          <li key={item.key}>{item.node}</li>
        ))}
        {saveHref && (tel || email) ? (
          <li>
            <a href={saveHref} download className={buttonClasses("secondary", "sm")}>
              <UsersIcon className="size-4.5 text-accent" />
              שמירה באנשי הקשר בטלפון
            </a>
          </li>
        ) : null}
      </ul>
      {preferred ? <p className="mt-2 text-sm text-ink-soft">ערוץ מועדף: {preferred.label}</p> : null}
    </div>
  );
}
