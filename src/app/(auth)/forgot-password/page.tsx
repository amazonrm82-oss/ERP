import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "שכחתי סיסמה" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">שכחתי סיסמה</h1>
      <p className="mt-1 mb-6 text-ink-soft">נשלח לכם קישור לבחירת סיסמה חדשה.</p>
      <ForgotPasswordForm />
      <p className="mt-6 text-md text-ink-soft">
        <Link href={paths.login} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
          חזרה לכניסה
        </Link>
      </p>
    </>
  );
}
