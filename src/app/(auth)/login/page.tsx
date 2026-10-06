import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/features/auth/components/login-form";
import { paths, safeNextPath } from "@/lib/paths";

export const metadata: Metadata = { title: "כניסה" };

const ERRORS: Record<string, string> = {
  callback: "קישור האימות אינו תקף או שפג תוקפו. נסו להתחבר, או הירשמו שוב כדי לקבל קישור חדש.",
};

type Props = { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const signupHref = next === "/" ? paths.signup : `${paths.signup}?next=${encodeURIComponent(next)}`;
  const error = typeof params.error === "string" ? ERRORS[params.error] : undefined;

  return (
    <>
      <h1 className="text-2xl font-semibold">כניסה למערכת</h1>
      <p className="mt-1 mb-6 text-ink-soft">הזינו את האימייל והסיסמה שלכם.</p>
      <LoginForm next={next} initialError={error} />
      <p className="mt-6 text-[0.9375rem] text-ink-soft">
        עוד אין לך חשבון?{" "}
        <Link href={signupHref} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
          הרשמה
        </Link>
      </p>
    </>
  );
}
