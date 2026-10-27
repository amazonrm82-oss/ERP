import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ForwardIcon } from "@/components/ui/icons";
import { Wordmark } from "@/components/wordmark";
import { listMyOrganizations } from "@/features/onboarding/queries";
import { readShareParams, sharePath } from "@/features/share/share";
import { LAST_ORG_COOKIE, shortcutOrg } from "@/features/shortcuts/shortcuts";
import { APP_NAME } from "@/lib/app";
import { requireUser } from "@/lib/auth";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: `שיתוף | ${APP_NAME}` };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * WAB-06: a share from another app lands here (the proxy sent a signed-out person to the login page and back). It opens
 * in the business the person last worked in on this device, as the app shortcuts do (USR-08); with several and no usable
 * one, the person picks. The business's own share screen checks membership, two-step verification and the rest.
 */
export default async function SharePage({ searchParams }: Props) {
  const user = await requireUser();
  const params = readShareParams(await searchParams);
  const organizations = await listMyOrganizations(user.id);
  if (organizations.length === 0) redirect(paths.home);
  const orgId = shortcutOrg((await cookies()).get(LAST_ORG_COOKIE)?.value, organizations.map((org) => org.id));
  if (orgId) redirect(sharePath(orgId, params));

  return (
    <div className="min-h-dvh bg-surface">
      <header className="px-5 py-4 sm:px-10">
        <Wordmark className="h-7" />
      </header>
      <main className="mx-auto w-full max-w-md px-5 pt-6 pb-16 sm:pt-12">
        <h1 className="text-2xl font-semibold">לאיזה עסק לשמור את השיתוף?</h1>
        <p className="mt-1 mb-6 text-ink-soft">החשבון שלכם משויך לכמה עסקים.</p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {organizations.map((org) => (
            <li key={org.id}>
              <Link href={sharePath(org.id, params)} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 hover:bg-canvas">
                <span className="min-w-0 truncate font-medium">{org.name}</span>
                <ForwardIcon className="size-5 shrink-0 text-ink-soft" />
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
