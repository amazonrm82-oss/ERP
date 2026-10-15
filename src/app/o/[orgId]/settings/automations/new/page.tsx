import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackIcon } from "@/components/ui/icons";
import { RuleBuilder } from "@/features/automations/components/rule-builder";
import { getLookups } from "@/features/automations/queries";
import { canManageAutomations } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "אוטומציה חדשה" };

type Props = { params: Promise<{ orgId: string }> };

export default async function NewAutomationPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  // PRM-01: a member with the automations permission manages them too
  if (!canManageAutomations(role, await getMyPermissions(orgId)) || !canWrite) {
    notFound();
  }
  const lookups = await getLookups(orgId);
  return (
    <div className="max-w-3xl space-y-4">
      <Link href={paths.settingsAutomations(orgId)} className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <BackIcon className="size-4" />
        כל האוטומציות
      </Link>
      <h2 className="text-xl font-semibold">אוטומציה חדשה</h2>
      <RuleBuilder orgId={orgId} lookups={lookups} />
    </div>
  );
}
