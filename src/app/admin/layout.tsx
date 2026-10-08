import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Wordmark } from "@/components/wordmark";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { MfaGate } from "@/features/auth/components/mfa-gate";
import { PLATFORM_ROLE_LABELS } from "@/features/platform/labels";
import { getPlatformMe } from "@/features/platform/queries";
import { requireUser } from "@/lib/auth";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: { default: "ניהול הפלטפורמה", template: "%s | ניהול הפלטפורמה" }, robots: { index: false } };

const NAV = [
  { href: paths.admin, label: "מדדים" },
  { href: paths.adminOrgs, label: "ארגונים" },
  { href: paths.adminUsers, label: "משתמשים" },
  { href: paths.adminPlans, label: "חבילות" },
  { href: paths.adminStaff, label: "צוות" },
  { href: paths.adminLog, label: "יומן" },
];

// The platform owner's panel. To everyone who is not platform staff it does not exist (404).
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireUser();
  const me = await getPlatformMe();
  if (!me) {
    notFound();
  }

  return (
    <div className="min-h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="rounded-md bg-danger-soft px-2 py-0.5 text-sm font-medium text-danger-strong">ניהול הפלטפורמה</span>
          <span className="text-sm text-ink-soft">{PLATFORM_ROLE_LABELS[me.role]}</span>
        </div>
        <SignOutButton />
      </header>
      {me.needsMfa ? (
        <main id="main" className="px-4 py-8 sm:px-6">
          <MfaGate />
        </main>
      ) : (
        <>
          <nav aria-label="ניהול" className="overflow-x-auto border-b border-line bg-surface px-4 sm:px-6">
            <ul className="flex gap-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="flex min-h-11 items-center px-3 text-md whitespace-nowrap text-ink-soft hover:text-ink">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
            {children}
          </main>
        </>
      )}
    </div>
  );
}
