import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackIcon } from "@/components/ui/icons";
import { RuleBuilder } from "@/features/automations/components/rule-builder";
import { fromDbRule } from "@/features/automations/convert";
import { getAutomation, getLookups } from "@/features/automations/queries";
import { canManageAutomations } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "עריכת אוטומציה" };

type Props = { params: Promise<{ orgId: string; automationId: string }> };

export default async function EditAutomationPage({ params }: Props) {
  const { orgId, automationId } = await params;
  const { role, canWrite, org } = await getOrgContext(orgId);
  // PRM-01: a member with the automations permission manages them too
  if (!canManageAutomations(role, await getMyPermissions(orgId)) || !canWrite || !isUuid(automationId)) {
    notFound();
  }
  const [automation, lookups] = await Promise.all([getAutomation(orgId, automationId), getLookups(orgId)]);
  const initial = automation ? fromDbRule(automation, { fields: lookups.fields, timeZone: org.timeZone }) : null;
  if (!automation || !initial) {
    notFound();
  }
  return (
    <div className="max-w-3xl space-y-4">
      <Link href={paths.settingsAutomation(orgId, automation.id)} className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <BackIcon className="size-4" />
        חזרה לאוטומציה
      </Link>
      <h2 className="text-xl font-semibold break-words">עריכת אוטומציה: {automation.name}</h2>
      <p className="text-sm text-ink-soft">השינויים חלים מהאירוע הבא. מה שכבר רץ נשאר ביומן ההרצות. סוג הרשומה לא משתנה.</p>
      <RuleBuilder orgId={orgId} lookups={lookups} edit={{ id: automation.id, initial }} />
    </div>
  );
}
