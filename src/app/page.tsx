import type { Metadata } from "next";
import Link from "next/link";

import { SiteFooter } from "@/components/public-shell";
import { ButtonLink } from "@/components/ui/button";
import { Wordmark } from "@/components/wordmark";
import { StandaloneRedirect } from "@/features/landing/components/standalone-redirect";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: { absolute: `${APP_NAME} | ${APP_DESCRIPTION}` }, description: APP_DESCRIPTION };

// The public landing page (LND-01). A signed-in visitor never sees it: the proxy
// sends them into the app first (LND-06). The full page, with what the system
// does and real screenshots (LND-02 to LND-05), comes with the chosen design.
export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <StandaloneRedirect />
      <header className="sticky top-0 z-10 border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-12 sm:px-6 sm:py-20">
        <h1 className="max-w-2xl text-3xl font-semibold sm:text-4xl">כל הלידים, הלקוחות והעסקאות של העסק, במקום אחד</h1>
        <p className="mt-4 max-w-xl text-lg text-ink-soft">
          {APP_NAME} היא מערכת לניהול לקוחות לעסקים קטנים ובינוניים בישראל. לידים מהאתר נכנסים לבד, כל אחד בצוות יודע מה מחכה לו היום, ואתם רואים איפה הכסף.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href={paths.signup} size="md">
            הרשמה לתקופת ניסיון
          </ButtonLink>
          <ButtonLink href={paths.help} variant="ghost" size="md">
            איך זה עובד
          </ButtonLink>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
