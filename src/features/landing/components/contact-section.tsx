import { paths } from "@/lib/paths";
import { SUPPORT } from "@/lib/support";

import { contactFormToken } from "../contact";
import { ContactForm } from "./contact-form";
import styles from "./landing.module.css";

/** The public site key of Turnstile (inlined at build). The server (turnstile-server.ts) checks only while both keys are set;
 * read here directly so the landing page does not import the verifier's file. */
function siteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";
  return /^[A-Za-z0-9_-]{8,100}$/.test(key) ? key : null;
}

/** LND-20 v2 (8): "נחזור אליכם" (#contact). Without Mexuz's own form address the section offers WhatsApp instead. */
export function ContactSection({ whatsappHref }: { whatsappHref: string }) {
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
          <ContactForm siteKey={siteKey()} privacyHref={paths.legal("privacy")} />
        ) : (
          <a href={whatsappHref} className={`${styles.btn} ${styles.primary}`}>
            כתבו לנו ב-WhatsApp
          </a>
        )}
      </div>
    </section>
  );
}
