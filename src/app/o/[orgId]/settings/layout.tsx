import type { ReactNode } from "react";

import { canEditCatalog, canImportWith, canManageAutomations } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { SettingsFrame } from "@/features/settings/components/settings-frame";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContextForOwner } from "@/features/shell/queries";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

export default async function SettingsLayout({ children, params }: Props) {
  const { orgId } = await params;
  // the owner of a business closed until payment still opens the plan and the full export
  // (BIL-09), without the settings list: every other page of it goes to the closed screen
  const { canDelete, canWrite, role, closed } = await getOrgContextForOwner(orgId);
  if (closed) {
    return <>{children}</>;
  }
  const admin = isAdminRole(role);
  const [priceLists, granted] = await Promise.all([orgHasFeature(orgId, "price_lists"), getMyPermissions(orgId)]);
  return (
    <SettingsFrame
      orgId={orgId}
      access={{
        admin,
        // owners, admins and team managers import (app.can_import), and a member with the
        // import permission (PRM-01); the owner also exports in read-only
        canImport: (canWrite && canImportWith(role, granted)) || role === "owner",
        canDelete,
        priceLists,
        catalog: canEditCatalog(role, granted),
        automations: canManageAutomations(role, granted),
        keptQuotes: admin || role === "manager",
      }}
    >
      {children}
    </SettingsFrame>
  );
}
