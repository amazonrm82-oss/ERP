import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { buttonClasses } from "@/components/ui/button";
import { Wordmark } from "@/components/wordmark";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import { countUnread, listNotifications } from "@/features/notifications/queries";
import { AvailabilityToggle } from "@/features/shell/components/availability-toggle";
import { BottomNav, SidebarNav } from "@/features/shell/components/nav";
import { PlanBadge } from "@/features/shell/components/plan-badge";
import { UserMenu } from "@/features/shell/components/user-menu";
import { ORG_STATUS_NOTICES, ROLE_LABELS } from "@/features/shell/labels";
import { getOrgContext } from "@/features/shell/queries";
import { daysUntil } from "@/lib/format";
import { paths } from "@/lib/paths";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgId } = await params;
  const { org } = await getOrgContext(orgId);
  return { title: { default: org.name, template: `%s | ${org.name}` } };
}

export default async function OrgLayout({ children, params }: Props) {
  const { orgId } = await params;
  // 404s unless the signed-in user is an active member of this organization
  const context = await getOrgContext(orgId);
  const { org, user, subscription } = context;
  const notice = ORG_STATUS_NOTICES[org.status];
  const [notifications, unread] = await Promise.all([listNotifications(org.id, user.id, 8), countUnread(org.id, user.id)]);

  return (
    <div className="min-h-dvh md:ps-60">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow"
      >
        דילוג לתוכן
      </a>

      {/* Sidebar: fixed on the start side (right in RTL) */}
      <aside className="fixed inset-y-0 start-0 z-20 hidden w-60 flex-col border-e border-line bg-surface md:flex">
        <div className="flex h-14 items-center px-5">
          <Link href={paths.org(org.id)} className="rounded-md">
            <Wordmark />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <SidebarNav orgId={org.id} />
        </div>
      </aside>

      <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <p className="truncate font-semibold">{org.name}</p>
          {subscription ? <PlanBadge subscription={subscription} trialDaysLeft={daysUntil(subscription.trialEndsAt)} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <NotificationBell
            // new server data (after marking read, or navigation) starts the bell afresh
            key={`${unread}:${notifications[0]?.id ?? ""}`}
            orgId={org.id}
            userId={user.id}
            initial={notifications}
            unread={unread}
          />
          <UserMenu
            name={user.displayName}
            email={user.email}
            roleLabel={ROLE_LABELS[context.role]}
            links={[
              { href: paths.companies(org.id), label: "חברות", mobileOnly: true },
              { href: paths.reports(org.id), label: "דוחות", mobileOnly: true },
              { href: paths.settings(org.id), label: "הגדרות", mobileOnly: true },
              { href: paths.home, label: "החלפת עסק" },
            ]}
          >
            {context.role === "viewer" ? null : (
              <div className="border-b border-line pb-1.5">
                <AvailabilityToggle key={String(context.isAvailable)} orgId={org.id} userId={user.id} available={context.isAvailable} />
              </div>
            )}
            <SignOutButton className={buttonClasses("ghost", "sm", "w-full justify-start")} />
          </UserMenu>
        </div>
      </header>

      {notice ? (
        <p role="status" className="border-b border-line bg-warning-soft px-4 py-2.5 text-sm text-warning sm:px-6">
          {notice}
        </p>
      ) : null}

      {/* bottom padding leaves room for the phone navigation bar */}
      <main id="main" className="mx-auto w-full max-w-6xl px-4 pt-5 pb-24 sm:px-6 sm:pt-7 md:pb-12">
        {children}
      </main>

      <BottomNav orgId={org.id} />
    </div>
  );
}
