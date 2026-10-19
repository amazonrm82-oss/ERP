import type { ReactNode } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { ModuleOff } from "@/features/modules/components/module-off";
import { getOrgModules } from "@/features/modules/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

// LEAD-08: while the business has this module switched off, its pages show one screen instead. Nothing is removed and
// RLS is unchanged (a layout hides; it does not guard: the export routes and the data stay as they were).
export default async function ModuleLayout({ children, params }: Props) {
  const { orgId } = await params;
  const modules = await getOrgModules(orgId);
  if (modules.leads) return children;
  const [context, terms] = await Promise.all([getOrgContext(orgId), getOrgTerms(orgId)]);
  return (
    <>
      <PageHeader title={terms.lead.plural} />
      <ModuleOff orgId={orgId} title={`מודול ה${terms.lead.plural}`} canChange={isAdminRole(context.role) && context.canWrite} />
    </>
  );
}
