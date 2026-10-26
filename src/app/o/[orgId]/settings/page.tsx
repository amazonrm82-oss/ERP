import type { Metadata } from "next";
import Link from "next/link";

import { ForwardIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { conversionMapSettingsPath } from "@/features/conversion-map/paths";
import { conversionMapNeedsFix } from "@/features/conversion-map/queries";
import { TARGET_REMOVED_REMINDER } from "@/features/conversion-map/rules";
import { getMyPermissions } from "@/features/permissions/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { settingsAccessFor, settingsGroups } from "@/features/settings/sections";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "הגדרות" };

type Props = { params: Promise<{ orgId: string }> };

// FXU-13: the settings as one list in groups, instead of a row of tabs.
export default async function SettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { canDelete, canWrite, role } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const [priceLists, granted] = await Promise.all([orgHasFeature(orgId, "price_lists"), getMyPermissions(orgId)]);
  // the owner also reaches the full export while the business is read-only; PRM-01: extra permissions
  const groups = settingsGroups(orgId, settingsAccessFor({ role, canWrite, canDelete, priceLists, granted }));
  // LEAD-06: a picked conversion target was deleted; owners and admins see it until someone chooses again
  const mappingNeedsFix = admin ? await conversionMapNeedsFix(orgId) : false;

  return (
    <>
      <PageHeader title="הגדרות" description="הגדרות העסק. ההגדרות האישיות שלכם נמצאות ב&quot;החשבון שלי&quot; בתפריט המשתמש." />
      {mappingNeedsFix ? (
        <p role="note" className="mb-6 flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {TARGET_REMOVED_REMINDER}
          <Link href={conversionMapSettingsPath(orgId)} className="font-medium underline underline-offset-4">
            לבחירת שדה אחר
          </Link>
        </p>
      ) : null}
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
