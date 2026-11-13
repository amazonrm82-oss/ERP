import { paths } from "@/lib/paths";
import { SUPPORT } from "@/lib/support";

import { contactFormToken } from "../contact";
import { ContactForm } from "./contact-form";
import styles from "./landing.module.css";

/** LND-20 v2 (8): "נחזור אליכם" (#contact). Without Mexuz's own form address the section offers WhatsApp instead.
 * `turnstileSiteKey` comes from the server page (`turnstileSiteKey()` of turnstile-server.ts), set only while both keys are
 * set and the server checks the token, as on the three auth forms (RVW-99); null = no widget. */
export function ContactSection({ whatsappHref, turnstileSiteKey }: { whatsappHref: string; turnstileSiteKey: string | null }) {
  const ready = contactFormToken(SUPPORT.formUrl) !== null;
  return (
    <section aria-labelledby="contact-title" id="contact" className={`${styles.sec} ${styles.alt}`}>
      <div className={`${styles.wrap} ${styles.leadForm}`}>
        <div className={styles.txt}>
          <span className={styles.eyebrow}>נחזור אליכם</span>
          <h2 id="contact-title" className="mt-3 text-ln-h2">
            רוצים שנראה לכם את זה על העסק שלכם?
          </h2>
          <p>השאירו שם וטלפון. הפנייה נכנסת ל-Mexuz שלנו, ומישהו מהצוות מתקשר תוך דקות בשעות העבודה. כן, בדיוק כמו שמבטיחים למעלה.</p>
        </div>
        {ready ? (
          <ContactForm siteKey={turnstileSiteKey} privacyHref={paths.legal("privacy")} />
        ) : (
          <a href={whatsappHref} className={`${styles.btn} ${styles.primary}`}>
            כתבו לנו ב-WhatsApp
          </a>
        )}
      </div>
    </section>
  );
}
