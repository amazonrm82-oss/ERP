import { buttonClasses } from "@/components/ui/button";
import { ChatIcon, FormIcon, PhoneIcon } from "@/components/ui/icons";
import { SUPPORT } from "@/lib/support";

/** The ways to reach support, from one place (FXU-04). */
export function SupportContact() {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="יצירת קשר עם התמיכה">
      <li>
        <a href={SUPPORT.telHref} className={buttonClasses("secondary", "sm")}>
          <PhoneIcon className="size-4.5 text-accent" />
          <span dir="ltr">{SUPPORT.phone}</span>
        </a>
      </li>
      <li>
        <a href={SUPPORT.whatsappHref} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
          <ChatIcon className="size-4.5 text-accent" />
          <span dir="ltr">WhatsApp</span>
          <span className="sr-only">(נפתח בחלון חדש)</span>
        </a>
      </li>
      {SUPPORT.formUrl ? (
        <li>
          <a href={SUPPORT.formUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
            <FormIcon className="size-4.5 text-accent" />
            טופס פנייה
            <span className="sr-only">(נפתח בחלון חדש)</span>
          </a>
        </li>
      ) : null}
    </ul>
  );
}
