import type { ReactNode } from "react";

import { SettingsFrame } from "@/features/settings/components/settings-frame";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

export default async function SettingsLayout({ children, params }: Props) {
  const { orgId } = await params;
  const { canDelete, canWrite, role } = await getOrgContext(orgId);
  const admin = isAdminRole(role);
  const priceLists = await orgHasFeature(orgId, "price_lists");
  return (
    <SettingsFrame
      orgId={orgId}
      access={{
        admin,
        // owners, admins and team managers import (app.can_import)
        canImport: canWrite && (admin || role === "manager"),
        canDelete,
        priceLists,
      }}
    >
      {children}
    </SettingsFrame>
  );
}
