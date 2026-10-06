import type { Metadata } from "next";
import Link from "next/link";

import { SignupForm } from "@/features/auth/components/signup-form";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הרשמה" };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">יצירת חשבון</h1>
      <p className="mt-1 mb-6 text-ink-soft">14 ימי ניסיון, בלי כרטיס אשראי.</p>
      <SignupForm />
      <p className="mt-6 text-[0.9375rem] text-ink-soft">
        כבר יש לך חשבון?{" "}
        <Link href={paths.login} className="font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
          כניסה
        </Link>
      </p>
    </>
  );
}
