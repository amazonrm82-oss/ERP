import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { cache } from "react";

import { AccessibilityLink } from "@/components/accessibility-link";
import { buttonClasses } from "@/components/ui/button";
import { BackIcon, ForwardIcon } from "@/components/ui/icons";
import { BookingManageCancel, BookingManageChange } from "@/features/booking/components/booking-manage-actions";
import { bookingManagePath } from "@/features/booking/paths";
import { addDays, fromParam, localDate, slotsByDay } from "@/features/booking/public";
import { getBookingManage } from "@/features/booking/public-server";
import { clientIp } from "@/lib/keyed-ip-hash";
import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { logoPublicUrl } from "@/features/branding/logo";
import { BuiltWithLine } from "@/features/built-with/components/built-with-line";
import { MEETING_TYPE_LABEL } from "@/features/meetings/schema";
import { longDay } from "@/lib/calendar-grid";
import { zoneTime } from "@/lib/format";
import { businessPreview, genericPreview, PREVIEW_TEXTS } from "@/lib/link-preview";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// WAB-05: the link's preview and the page share ONE read per request (booking_manage_public counts a view per sender)
const loadManage = cache(async (token: string, from: string | null) => getBookingManage(token, from, clientIp(await headers())));

/** WAB-05: the link's preview: "הפגישה שלך אצל <business>" and the logo; never the meeting's time or the customer. */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const page = await loadManage((await params).token, fromParam((await searchParams).from));
  const t = PREVIEW_TEXTS.manage;
  if (typeof page === "string") return genericPreview(t.what, t.description);
  return businessPreview({ ...t, business: page.business, logoUrl: logoPublicUrl(page.brand.logoPath) });
}

const MESSAGES = {
  "not-found": "הקישור לא נמצא או שכבר אינו פעיל.",
  unavailable: "אי אפשר לשנות פגישות כרגע.",
  "rate-limited": "הדף נפתח יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.",
  "not-configured": "קביעת התורים אינה זמינה כרגע.",
} as const;

/** "עד יום לפני" for the page's threshold in hours. */
function noticeText(hours: number): string {
  if (hours === 0) return "עד תחילת הפגישה";
  if (hours === 24) return "עד יום לפני הפגישה";
  if (hours === 48) return "עד יומיים לפני הפגישה";
  if (hours === 1) return "עד שעה לפני הפגישה";
  if (hours === 2) return "עד שעתיים לפני הפגישה";
  return `עד ${hours} שעות לפני הפגישה`;
}

/**
 * CAL-10b: the customer's personal page for one booked meeting: its time, type and rep; cancel, or move it to
 * another free time of the page. No sign-in, no cookies; `?from=` is the week shown, `?at=` the picked new time.
 */
export default async function BookingManagePage({ params, searchParams }: Props) {
  const { token } = await params;
  const query = await searchParams;
  const page = await loadManage(token, fromParam(query.from));

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
  const base = bookingManagePath(token);
  const change = page.change;
  const weekHref = (from: string) => `${base}?from=${from}`;
  const picked = change && typeof query.at === "string" && change.slots.includes(query.at) ? query.at : null;
  const days = change ? slotsByDay({ ...change, timeZone: page.timeZone }) : [];
  const prev = change && change.from > change.today ? (addDays(change.from, -7) < change.today ? change.today : addDays(change.from, -7)) : null;
  const next = change && addDays(change.from, 7) <= change.lastDay ? addDays(change.from, 7) : null;
  const when = `${longDay(localDate(page.startsAt, page.timeZone))}, ${zoneTime(new Date(page.startsAt), page.timeZone)}-${zoneTime(new Date(page.endsAt), page.timeZone)}`;
  const details = [page.meeting.name, page.rep && page.rep !== page.business ? `עם ${page.rep}` : null, MEETING_TYPE_LABEL[page.meeting.format] ?? null, page.meeting.location].filter(Boolean);

  return (
    <BrandScope color={page.brand.color}>
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 py-10 sm:py-16">
        {logoUrl ? <OrgLogo url={logoUrl} alt={`הלוגו של ${page.business}`} className="mb-5 h-12 max-w-48" /> : null}
        <h1 className="text-2xl font-semibold">הפגישה שלך ב{page.business}</h1>
        <div className="mt-4 rounded-lg border border-line bg-surface p-4">
          <p className={page.status === "cancelled" ? "text-lead font-semibold line-through" : "text-lead font-semibold"}>{when}</p>
          <p className="mt-1 text-md text-ink-soft">{details.join(" · ")}</p>
          {page.status === "cancelled" ? (
            <p role="status" className="mt-3 font-medium text-danger">
              הפגישה בוטלה.
            </p>
          ) : null}
          {page.status === "past" ? <p className="mt-3 text-md text-ink-soft">הפגישה כבר התקיימה או שהסתיימה.</p> : null}
        </div>

        {page.status === "planned" && !page.canCancel ? (
          <div className="mt-6 space-y-1">
            <p className="text-md">אפשר לבטל או לשנות כאן {noticeText(page.noticeHours)}, והמועד הזה עבר.</p>
            {page.callPhone ? (
              <p className="text-md">
                לביטול יש להתקשר:{" "}
                <a href={`tel:${page.callPhone.replace(/[^\d+]/g, "")}`} dir="ltr" className="font-medium text-accent underline underline-offset-4">
                  {page.callPhone}
                </a>
              </p>
            ) : null}
          </div>
        ) : null}

        {page.status === "planned" && page.canCancel ? (
          <div className="mt-6 space-y-6">
            <p className="text-sm text-ink-soft">אפשר לבטל או לשנות כאן {noticeText(page.noticeHours)}.</p>
            {!picked ? <BookingManageCancel token={token} /> : null}
            {change ? (
              picked ? (
                <section aria-labelledby="manage-new-time" className="space-y-4">
                  <div className="rounded-lg border border-line bg-surface p-4">
                    <h2 id="manage-new-time" className="text-lead font-semibold">
                      הזמן החדש: {longDay(localDate(picked, page.timeZone))}, {zoneTime(new Date(picked), page.timeZone)}
                    </h2>
                    <Link href={weekHref(change.from)} className="text-sm font-medium text-accent underline underline-offset-4">
                      בחירת זמן אחר
                    </Link>
                  </div>
                  <BookingManageChange token={token} startsAt={picked} timeZone={page.timeZone} business={page.business} backHref={weekHref(change.from)} />
                </section>
              ) : (
                <section aria-labelledby="manage-times" className="space-y-4">
                  <h2 id="manage-times" className="text-lead font-semibold">
                    או בחירת זמן אחר
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
                                <Link href={`${weekHref(change.from)}&at=${encodeURIComponent(slot)}`} className={buttonClasses("secondary", "sm", "min-w-20 tabular-nums")}>
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
              )
            ) : null}
          </div>
        ) : null}
        {page.builtWith ? <BuiltWithLine /> : null}
        <AccessibilityLink />
      </main>
    </BrandScope>
  );
}
