import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { SiteFooter } from "@/components/public-shell";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { ChatIcon } from "@/components/ui/icons";
import { Wordmark } from "@/components/wordmark";
import { LIVE_FEATURES, SOON_FEATURES } from "@/features/landing/catalog";
import { StandaloneRedirect } from "@/features/landing/components/standalone-redirect";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";
import desktopShot from "@/assets/landing/desktop.webp";
import phoneShot from "@/assets/landing/phone.webp";

export const metadata: Metadata = {
  title: { absolute: `${APP_NAME} | ${APP_DESCRIPTION}` },
  description: "מערכת לניהול לידים, לקוחות ועסקאות לעסקים קטנים ובינוניים בישראל. בעברית, בטלפון ובמחשב.",
  // the one page search engines should find (LND-11)
  robots: { index: true, follow: true },
};

// "דברו איתנו" leads to Mexuz's own lead form, built in the system (LND-12).
// The address is a setting; without it the button is not shown.
const CONTACT_FORM_URL = process.env.NEXT_PUBLIC_CONTACT_FORM_URL?.trim() || null;

// The public landing page (LND-01 to LND-05, LND-09 to LND-12). A signed-in
// visitor never sees it: the proxy sends them into the app first (LND-06).
// What it lists comes from one catalog, and only what works is "available".
export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <StandaloneRedirect />
      {/* stays on screen while scrolling, so sign-in and sign-up are always one tap away (LND-05) */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href={paths.landing} className="shrink-0 rounded-md">
            <Wordmark className="h-6 sm:h-7" />
          </Link>
          <nav aria-label="כניסה והרשמה" className="flex items-center gap-2">
            <ButtonLink href={paths.login} variant="ghost" size="md">
              כניסה
            </ButtonLink>
            <ButtonLink href={paths.signup} size="md">
              הרשמה
            </ButtonLink>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section aria-labelledby="hero-title" className="bg-canvas">
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div>
              <h1 id="hero-title" className="text-3xl font-semibold leading-tight text-balance sm:text-4xl">
                כל הלידים, הלקוחות והעסקאות של העסק, במקום אחד
              </h1>
              <p className="mt-4 max-w-xl text-lead text-ink-soft">
                {APP_NAME} היא מערכת לניהול לקוחות לעסקים קטנים ובינוניים בישראל. פניות מהאתר נכנסות לבד, כל אחד בצוות יודע מה מחכה לו היום, ואתם רואים
                איפה הכסף. בעברית, בטלפון ובמחשב.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href={paths.signup}>הרשמה לתקופת ניסיון</ButtonLink>
                {CONTACT_FORM_URL ? (
                  <a href={CONTACT_FORM_URL} className={buttonClasses("secondary")}>
                    <ChatIcon className="size-4.5" />
                    דברו איתנו
                  </a>
                ) : null}
              </div>
            </div>
            {/* real screens of the product, with sample data (LND-02) */}
            <div className="relative pb-10 sm:pb-12">
              <Image
                src={desktopShot}
                alt='מסך "היום שלי" במחשב: משימות להיום, לידים חדשים ועסקאות פתוחות'
                priority
                sizes="(min-width: 1024px) 600px, 100vw"
                className="w-full rounded-lg border border-line shadow-lg"
              />
              <Image
                src={phoneShot}
                alt="רשימת הלידים בטלפון: כרטיס לכל ליד עם חיוג ו-WhatsApp"
                sizes="160px"
                className="absolute start-3 -bottom-2 w-32 rounded-xl border-4 border-ink shadow-xl sm:start-6 sm:w-40"
              />
            </div>
          </div>
        </section>

        <section aria-labelledby="features-title" className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <h2 id="features-title" className="text-2xl font-semibold">
            כל מה שיש במערכת
          </h2>
          <p className="mt-2 max-w-2xl text-md text-ink-soft">כל מה שברשימה הזו עובד היום. מה שעוד לא מוכן מופיע בנפרד למטה.</p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {LIVE_FEATURES.map((feature) => (
              <li key={feature.key} className="flex gap-4 rounded-lg border border-line bg-surface p-5">
                <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <feature.icon className="size-5.5" />
                </span>
                <span>
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="mt-1 text-md text-ink-soft">{feature.text}</p>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="soon-title" className="border-t border-line bg-canvas">
          <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="soon-title" className="text-xl font-semibold">
              בקרוב
            </h2>
            <p className="mt-2 max-w-2xl text-md text-ink-soft">בבנייה עכשיו. עוד לא חלק מהמערכת.</p>
            <ul className="mt-6 grid gap-4 md:grid-cols-3">
              {SOON_FEATURES.map((feature) => (
                <li key={feature.key} className="rounded-lg border border-dashed border-line-strong bg-surface p-5">
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="mt-1 text-md text-ink-soft">{feature.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="start-title" className="mx-auto w-full max-w-6xl px-4 py-14 text-center sm:px-6 sm:py-20">
          <h2 id="start-title" className="text-2xl font-semibold">
            מתחילים בכמה דקות
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-md text-ink-soft">נרשמים, נותנים שם לעסק, ומוסיפים את הליד הראשון. אפשר לייבא את מה שיש לכם באקסל.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink href={paths.signup}>הרשמה</ButtonLink>
            <ButtonLink href={paths.help} variant="ghost">
              מרכז עזרה
            </ButtonLink>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
