import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { cache } from "react";

import { AccessibilityLink } from "@/components/accessibility-link";
import { buttonClasses } from "@/components/ui/button";
import { BackIcon, ForwardIcon } from "@/components/ui/icons";
import { PublicBookingForm } from "@/features/booking/components/public-booking-form";
import { publicBookingPath } from "@/features/booking/paths";
import { addDays, fromParam, slotsByDay } from "@/features/booking/public";
import { getPublicBooking } from "@/features/booking/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { longDay } from "@/lib/calendar-grid";
import { zoneTime } from "@/lib/format";
import { BotPreviewPage } from "@/features/link-preview/components/bot-preview-page";
import { botPreviewMetadata } from "@/features/link-preview/bot-preview";
import { isPreviewBotRequest, loadBotPreview } from "@/features/link-preview/bot-request";
import { businessPreview, genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// WAB-05: the link's preview and the page share ONE read per request (booking_page_public counts a view per sender)
const loadBooking = cache(async (token: string, from: string | null) => getPublicBooking(token, from, clientIp(await headers())));

/** WAB-05: the link's preview: "קביעת תור אצל <business>", the page's title and meeting, and the logo. */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  // WAB-05 follow-up (owner, 27 October 2026): a listed preview bot gets the business's display name and logo only; the page's
  // own read (which counts a view) never runs for it
  if (await isPreviewBotRequest()) return botPreviewMetadata("booking", await loadBotPreview("booking", (await params).token));
  const page = await loadBooking((await params).token, fromParam((await searchParams).from));
  const t = PREVIEW_TEXTS.booking;
  if (typeof page === "string") return genericPreview(t.what, t.description);
  const what = [page.title, page.meeting.name !== page.title ? page.meeting.name : null, `${page.meeting.durationMinutes} דקות`].filter(Boolean).join(" · ");
  return businessPreview({ ...t, business: page.business, logoUrl: logoPublicUrl(page.brand.logoPath), description: `${what}. ${t.description}` });
}

const MESSAGES = {
  "not-found": "הדף לא נמצא או שאינו פעיל.",
  unavailable: "אי אפשר לקבוע תור כרגע.",
  "rate-limited": "הדף נפתח יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "קביעת התורים אינה זמינה כרגע.",
} as const;

/** CAL-10: the public booking page. No sign-in, no cookies; `?from=` is the week shown, `?at=` the picked time. */
export default async function PublicBookingPage({ params, searchParams }: Props) {
  const { token } = await params;
  // WAB-05 follow-up: a listed preview bot gets one line, and nothing of the page is read or counted
  if (await isPreviewBotRequest()) return <BotPreviewPage kind="booking" state={await loadBotPreview("booking", token)} />;
  const query = await searchParams;
  const page = await loadBooking(token, fromParam(query.from));

  if (typeof page === "string") {
    return (
      <main className="mx-auto min-h-dvh w-full max-w-md px-5 py-10 sm:py-16">
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {MESSAGES[page]}
        </p>
        <AccessibilityLink />
      </main>
    );
  }

  const logoUrl = logoPublicUrl(page.brand.logoPath);
  const base = publicBookingPath(token);
  const weekHref = (from: string) => `${base}?from=${from}`;
  const picked = typeof query.at === "string" && page.slots.includes(query.at) ? query.at : null;
  const days = slotsByDay(page);
  const prev = page.from > page.today ? (addDays(page.from, -7) < page.today ? page.today : addDays(page.from, -7)) : null;
  const next = addDays(page.from, 7) <= page.lastDay ? addDays(page.from, 7) : null;
  const details = [
    page.meeting.name,
    `${page.meeting.durationMinutes} דקות`,
    MEETING_TYPE_LABEL[page.meeting.format] ?? null,
    page.meeting.location,
  ].filter(Boolean);

  return (
    // FLD-04 / DSN-17: the business's colour (corrected for contrast) on its own page
    <BrandScope color={page.brand.color}>
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 py-10 sm:py-16">
        {logoUrl ? <OrgLogo url={logoUrl} alt={`הלוגו של ${page.business}`} className="mb-5 h-12 max-w-48" /> : null}
        <h1 className="text-2xl font-semibold">{page.title}</h1>
        <p className="mt-1 text-md text-ink-soft">
          {page.business}
          {page.rep && page.rep !== page.business ? ` · עם ${page.rep}` : ""}
        </p>
        <p className="mt-1 text-md text-ink-soft">{details.join(" · ")}</p>
        {page.intro ? <p className="mt-3 whitespace-pre-wrap">{page.intro}</p> : null}

        {picked ? (
          <section aria-labelledby="booking-details" className="mt-6 space-y-4">
            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 id="booking-details" className="text-lead font-semibold">
                {longDay(days.find((d) => d.slots.includes(picked))?.day ?? page.from)}, {zoneTime(new Date(picked), page.timeZone)}
              </h2>
              <Link href={weekHref(page.from)} className="text-sm font-medium text-accent underline underline-offset-4">
                בחירת זמן אחר
              </Link>
            </div>
            <PublicBookingForm token={token} business={page.business} startsAt={picked} timeZone={page.timeZone} questions={page.questions} backHref={weekHref(page.from)} />
          </section>
        ) : (
          <section aria-labelledby="booking-times" className="mt-6 space-y-4">
            <h2 id="booking-times" className="text-lead font-semibold">
              בחרו זמן
            </h2>
            {days.every((d) => d.slots.length === 0) ? <p className="text-md text-ink-soft">אין זמנים פנויים בשבוע הזה.</p> : null}
            <ol className="space-y-4">
              {days.map(({ day, slots }) =>
                slots.length > 0 ? (
                  <li key={day}>
                    <h3 className="mb-2 text-md font-medium">{longDay(day)}</h3>
                    <ul className="flex flex-wrap gap-2">
                      {slots.map((slot) => (
                        <li key={slot}>
                          <Link href={`${weekHref(page.from)}&at=${encodeURIComponent(slot)}`} className={buttonClasses("secondary", "sm", "min-w-20 tabular-nums")}>
                            <span dir="ltr">{zoneTime(new Date(slot), page.timeZone)}</span>
                            <span className="sr-only">, {longDay(day)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : null,
              )}
            </ol>
            <nav aria-label="שבועות" className="flex flex-wrap justify-between gap-2">
              {prev ? (
                <Link href={weekHref(prev)} className={buttonClasses("ghost", "sm")}>
                  <BackIcon className="size-4" aria-hidden="true" />
                  השבוע הקודם
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link href={weekHref(next)} className={buttonClasses("ghost", "sm")}>
                  השבוע הבא
                  <ForwardIcon className="size-4" aria-hidden="true" />
                </Link>
              ) : null}
            </nav>
            <p className="text-sm text-ink-soft">השעות לפי שעון {page.timeZone === "Asia/Jerusalem" ? "ישראל" : page.timeZone}.</p>
          </section>
        )}
        {page.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </main>
    </BrandScope>
  );
}
