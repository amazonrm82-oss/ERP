import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { OrganizationForm } from "@/features/onboarding/components/organization-form";
import { listMyOrganizations } from "@/features/onboarding/queries";
import { Wordmark } from "@/components/wordmark";
import { AccessibilityLink } from "@/components/accessibility-link";
import { requireAgreement } from "@/features/legal/queries";
import { requireUser } from "@/lib/auth";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הקמת העסק" };

type Props = { searchParams: Promise<{ new?: string | string[] }> };

export default async function OnboardingPage({ searchParams }: Props) {
  const user = await requireUser();
  await requireAgreement(paths.onboarding);
  const organizations = await listMyOrganizations(user.id);
  const wantsAnother = (await searchParams).new === "1";

  // Someone who already belongs to a business only gets here on purpose (?new=1).
  if (organizations.length > 0 && !wantsAnother) {
    redirect(paths.home);
  }

  return (
    <div className="min-h-dvh bg-surface">
      <header className="flex items-center justify-between px-5 py-4 sm:px-10">
        <Wordmark className="h-7" />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-16 sm:pt-12">
        <h1 className="text-2xl font-semibold">{organizations.length > 0 ? "הוספת עסק" : "נקים את העסק שלך"}</h1>
        <p className="mt-1 mb-6 text-ink-soft">
          כמה פרטים, ונכין עבורך תהליך מכירה, סטטוסים ומקורות לידים. אפשר לשנות הכול אחר כך.
        </p>
        <OrganizationForm />
        {organizations.length > 0 ? (
          <p className="mt-6 text-md">
            <Link href={paths.home} className="text-accent underline underline-offset-4 hover:text-accent-strong">
              חזרה לעסקים שלי
            </Link>
          </p>
        ) : null}
        <AccessibilityLink />
      </main>
    </div>
  );
}
