import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/features/auth/components/signup-form";
import { turnstileSiteKey } from "@/features/auth/turnstile-server";
import { carriedSource, LANDING_SOURCE_PARAM } from "@/features/landing/measure";
import { paths, safeNextPath } from "@/lib/paths";
import { publicPageMetadata } from "@/features/seo/page-metadata";

// WEB-03: a title and description for a shared link; the sign-in screens stay out of search engines (LND-11)
export const metadata: Metadata = publicPageMetadata({
  title: "הרשמה",
  description: "פותחים חשבון ב-Mexuz ומתחילים לנהל לידים, לקוחות ועסקאות. בעברית, בטלפון ובמחשב.",
  path: paths.signup,
  index: false,
});

type Props = { searchParams: Promise<{ next?: string | string[]; [LANDING_SOURCE_PARAM]?: string | string[] }> };

export default async function SignupPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const loginHref = next === "/" ? paths.login : `${paths.login}?next=${encodeURIComponent(next)}`;

  // FXU-05: someone who came from an invitation joins a business; the trial is not theirs to start
  const invited = next.startsWith("/invite/");
  // LND-14: the source a visitor carried from the landing page's sign-up button (none for an invitation)
  const landingSource = invited ? null : carriedSource(params[LANDING_SOURCE_PARAM]);

  return (
    <>
      <h1 className="text-2xl font-semibold">{invited ? "הוזמנתם להצטרף לעסק" : "יצירת חשבון"}</h1>
      <p className="mt-1 mb-6 text-ink-soft">
        {invited ? "יוצרים חשבון אישי, ואחרי אימות האימייל מצטרפים לעסק שהזמין אתכם." : "14 ימי ניסיון, בלי כרטיס אשראי."}
      </p>
      <SignupForm next={next} turnstileSiteKey={turnstileSiteKey()} landingSource={landingSource} />
      <p className="mt-6 text-md text-ink-soft">
        כבר יש לכם חשבון?{" "}
        <Link href={loginHref} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
          כניסה
        </Link>
      </p>
    </>
  );
}
