import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChevronIcon } from "@/components/ui/icons";
import { RuleBuilder } from "@/features/automations/components/rule-builder";
import { getLookups } from "@/features/automations/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "אוטומציה חדשה" };

type Props = { params: Promise<{ orgId: string }> };

export default async function NewAutomationPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role) || !canWrite) {
    notFound();
  }
  const lookups = await getLookups(orgId);
  return (
    <div className="max-w-3xl space-y-4">
      <Link href={paths.settingsAutomations(orgId)} className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronIcon className="size-4 rtl:rotate-180" />
        כל האוטומציות
      </Link>
      <h2 className="text-xl font-semibold">אוטומציה חדשה</h2>
      <RuleBuilder orgId={orgId} lookups={lookups} />
    </div>
  );
}
