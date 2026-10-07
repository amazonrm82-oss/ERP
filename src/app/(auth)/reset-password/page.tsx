import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NewPasswordForm } from "@/features/auth/components/new-password-form";
import { owesSecondStep, requireUser } from "@/lib/auth";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "סיסמה חדשה" };

// Reached from the reset link (the callback has signed the user in).
export default async function ResetPasswordPage() {
  await requireUser();
  // an account with two-step verification changes its password only after the code
  if (await owesSecondStep()) {
    redirect(`${paths.loginMfa}?next=${encodeURIComponent(paths.resetPassword)}`);
  }
  return (
    <>
      <h1 className="text-2xl font-semibold">בחירת סיסמה חדשה</h1>
      <p className="mt-1 mb-6 text-ink-soft">אחרי השמירה תמשיכו מחוברים.</p>
      <NewPasswordForm continueHref={paths.home} />
    </>
  );
}
