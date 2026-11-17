import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/features/auth/components/signup-form";
import { turnstileSiteKey } from "@/features/auth/turnstile-server";
import { availableSignupPlan, carriedSource, LANDING_SOURCE_PARAM, SIGNUP_PLAN_PARAM, signupPlanKey } from "@/features/landing/measure";
import { readPublicPlans } from "@/features/landing/price-list-server";
import { paths, safeNextPath } from "@/lib/paths";
import { publicPageMetadata } from "@/features/seo/page-metadata";

// WEB-03: a title and description for a shared link; the sign-in screens stay out of search engines (LND-11)
export const metadata: Metadata = publicPageMetadata({
  title: "הרשמה",
  description: "פותחים חשבון ב-Mexuz ומתחילים לנהל לידים, לקוחות ועסקאות. בעברית, בטלפון ובמחשב.",
  path: paths.signup,
  index: false,
});

type Props = {
  searchParams: Promise<{ next?: string | string[]; [LANDING_SOURCE_PARAM]?: string | string[]; [SIGNUP_PLAN_PARAM]?: string | string[] }>;
};

export default async function SignupPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const loginHref = next === "/" ? paths.login : `${paths.login}?next=${encodeURIComponent(next)}`;

  // FXU-05: someone who came from an invitation joins a business; the trial is not theirs to start
  const invited = next.startsWith("/invite/");
  // LND-14: the source a visitor carried from the landing page's sign-up button (none for an invitation)
  const landingSource = invited ? null : carriedSource(params[LANDING_SOURCE_PARAM]);
  // WEB-02: a price card's plan, only while it is available (else ignored silently); the database checks it again when the
  // business is made
  const plans = invited || !params[SIGNUP_PLAN_PARAM] ? null : await readPublicPlans();
  const plan = invited ? null : availableSignupPlan(plans, params[SIGNUP_PLAN_PARAM]);
  // when the price list could not be read, a well-formed key is still carried (no "חבילה X" line): the database decides
  const carriedPlan = invited ? null : plan ? plan.key : plans === null ? signupPlanKey(params[SIGNUP_PLAN_PARAM]) : null;

  return (
    <>
      <h1 className="text-2xl font-semibold">{invited ? "הוזמנתם להצטרף לעסק" : "יצירת חשבון"}</h1>
      <p className="mt-1 mb-6 text-ink-soft">
        {invited
          ? "יוצרים חשבון אישי, ואחרי אימות האימייל מצטרפים לעסק שהזמין אתכם."
          : plan
            ? plan.free
              ? `חבילה ${plan.name}: ללא תשלום, בלי כרטיס אשראי.`
              : `חבילה ${plan.name}: 14 ימי ניסיון, בלי כרטיס אשראי.`
            : "14 ימי ניסיון, בלי כרטיס אשראי."}
      </p>
      <SignupForm next={next} turnstileSiteKey={turnstileSiteKey()} landingSource={landingSource} signupPlan={carriedPlan} />
      <p className="mt-6 text-md text-ink-soft">
        כבר יש לכם חשבון?{" "}
        <Link href={loginHref} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
          כניסה
        </Link>
      </p>
    </>
  );
}
