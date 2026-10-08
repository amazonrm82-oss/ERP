import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/features/auth/components/signup-form";
import { paths, safeNextPath } from "@/lib/paths";

export const metadata: Metadata = { title: "הרשמה" };

type Props = { searchParams: Promise<{ next?: string | string[] }> };

export default async function SignupPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const loginHref = next === "/" ? paths.login : `${paths.login}?next=${encodeURIComponent(next)}`;

  return (
    <>
      <h1 className="text-2xl font-semibold">יצירת חשבון</h1>
      <p className="mt-1 mb-6 text-ink-soft">14 ימי ניסיון, בלי כרטיס אשראי.</p>
      <SignupForm next={next} />
      <p className="mt-6 text-md text-ink-soft">
        כבר יש לך חשבון?{" "}
        <Link href={loginHref} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
          כניסה
        </Link>
      </p>
    </>
  );
}
