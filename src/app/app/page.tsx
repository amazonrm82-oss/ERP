import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ForwardIcon } from "@/components/ui/icons";
import { Wordmark } from "@/components/wordmark";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { listMfaBlockedOrganizations, listMyOrganizations } from "@/features/onboarding/queries";
import { requireAgreement } from "@/features/legal/queries";
import { getPlatformMe } from "@/features/platform/queries";
import { ROLE_LABELS } from "@/features/shell/labels";
import { APP_NAME } from "@/lib/app";
import { requireUser } from "@/lib/auth";
import { paths } from "@/lib/paths";

// The title template of the root layout does not apply to the root page itself.
export const metadata: Metadata = { title: `בחירת עסק | ${APP_NAME}` };

// Entry point after sign-in: no business -> onboarding, one -> straight in,
// several -> pick one.
export default async function RootPage() {
  const user = await requireUser();
  await requireAgreement(paths.home);
  const organizations = await listMyOrganizations(user.id);

  const blocked = await listMfaBlockedOrganizations();
  const mfaHref = (orgId: string) => `${paths.loginMfa}?next=${encodeURIComponent(paths.org(orgId))}`;
  if (organizations.length === 0 && blocked.length > 0) {
    redirect(mfaHref(blocked[0].id));
  }
  if (organizations.length === 0) {
    // platform staff without a business of their own go to the admin panel
    redirect((await getPlatformMe()) ? paths.admin : paths.onboarding);
  }
  if (organizations.length === 1 && blocked.length === 0) {
    redirect(paths.org(organizations[0].id));
  }

  return (
    <div className="min-h-dvh bg-surface">
      <header className="flex items-center justify-between px-5 py-4 sm:px-10">
        <Wordmark className="h-7" />
        <SignOutButton />
      </header>
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-16 sm:pt-12">
        <h1 className="text-2xl font-semibold">לאיזה עסק להיכנס?</h1>
        <p className="mt-1 mb-6 text-ink-soft">החשבון שלכם משויך לכמה עסקים.</p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {organizations.map((org) => (
            <li key={org.id}>
              <Link
                href={paths.org(org.id)}
                className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-canvas"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{org.name}</span>
                  <span className="block text-sm text-ink-soft">{ROLE_LABELS[org.role]}</span>
                </span>
                <ForwardIcon className="size-5 shrink-0 text-ink-soft" />
              </Link>
            </li>
          ))}
          {blocked.map((org) => (
            <li key={org.id}>
              <Link href={mfaHref(org.id)} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-canvas">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{org.name}</span>
                  <span className="block text-sm text-ink-soft">העסק דורש אימות דו-שלבי</span>
                </span>
                <ForwardIcon className="size-5 shrink-0 text-ink-soft" />
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-md">
          <Link href={`${paths.onboarding}?new=1`} className="text-accent underline underline-offset-4 hover:text-accent-strong">
            הוספת עסק חדש
          </Link>
        </p>
      </main>
    </div>
  );
}
