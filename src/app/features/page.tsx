import type { Metadata } from "next";
import Link from "next/link";

import { LIVE_FEATURES } from "@/features/landing/catalog";
import styles from "@/features/landing/components/landing.module.css";
import { LandingFooter, LandingNav } from "@/features/landing/components/sections";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";
import { publicPageMetadata } from "@/features/seo/page-metadata";

// LND-20 v2 (5): public and listed in the sitemap, like the landing page; WEB-03: canonical and share texts
export const metadata: Metadata = publicPageMetadata({
  title: `כל היכולות | ${APP_NAME}`,
  absoluteTitle: true,
  description: "כל מה שיש ב-Mexuz היום: לידים, אנשי קשר, עסקאות, משימות, הצעות מחיר, תשלומים, דוחות ועוד.",
  path: paths.features,
  index: true,
});

/** LND-20 v2 (5): every capability that works today, from the landing catalog (texts unchanged), in the landing page's dark style. */
export default function FeaturesPage() {
  return (
    <div className={styles.page}>
      <LandingNav />
      <main className={`flex-1 ${styles.sec}`}>
        <div className={styles.wrap}>
          <span className={styles.eyebrow}>כל היכולות</span>
          <h1 className="mt-3 text-ln-h2">כל מה שיש במערכת</h1>
          <p className={`${styles.lead} mt-4 text-ln-lead`}>כל מה שברשימה הזו עובד היום.</p>
          <ul className={styles.featureList}>
            {LIVE_FEATURES.map((feature) => (
              <li key={feature.key}>
                <h2 className="text-lead font-bold">{feature.title}</h2>
                <p>{feature.text}</p>
              </li>
            ))}
          </ul>
          <div className={styles.ctas}>
            <Link href={paths.signup} className={`${styles.btn} ${styles.primary}`}>
              הרשמה לתקופת ניסיון
            </Link>
            <Link href={paths.landing} className={`${styles.btn} ${styles.ghost}`}>
              לדף הבית
            </Link>
          </div>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
