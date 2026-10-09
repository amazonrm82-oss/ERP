import type { Metadata } from "next";
import Link from "next/link";

import { ForwardIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { isAdminRole } from "@/features/settings/permissions";
import { settingsGroups } from "@/features/settings/sections";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הגדרות" };

type Props = { params: Promise<{ orgId: string }> };

// FXU-13: the settings as one list in groups, instead of a row of tabs.
export default async function SettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { canDelete, canWrite, role } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const groups = settingsGroups(orgId, { admin, canImport: canWrite && (admin || role === "manager"), canDelete });

  return (
    <>
      <PageHeader title="הגדרות" description="הגדרות העסק. ההגדרות האישיות שלכם נמצאות ב&quot;החשבון שלי&quot; בתפריט המשתמש." />
      <div className="grid gap-6 lg:grid-cols-2">
        {groups.map((group) => (
          <section key={group.label} aria-labelledby={`group-${group.label}`}>
            <h2 id={`group-${group.label}`} className="mb-2 text-lead font-semibold">
              {group.label}
            </h2>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {group.sections.map((section) => (
                <li key={section.href}>
                  <Link href={section.href} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-canvas">
                    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <section.icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink">{section.label}</span>
                      <span className="block text-sm text-ink-soft">{section.description}</span>
                    </span>
                    <ForwardIcon className="size-5 shrink-0 text-ink-soft" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-6 text-sm text-ink-soft">
        <Link href={paths.settingsAccount(orgId)} className="text-accent underline underline-offset-4">
          החשבון שלי
        </Link>
        : סיסמה, אימות דו-שלבי, התראות ומכשירים מחוברים.
      </p>
    </>
  );
}
