import type { ReactNode } from "react";

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
  const priceLists = await orgHasFeature(orgId, "price_lists");
  return (
    <SettingsFrame
      orgId={orgId}
      access={{
        admin,
        // owners, admins and team managers import (app.can_import); the owner also exports in read-only
        canImport: (canWrite && (admin || role === "manager")) || role === "owner",
        canDelete,
        priceLists,
      }}
    >
      {children}
    </SettingsFrame>
  );
}
