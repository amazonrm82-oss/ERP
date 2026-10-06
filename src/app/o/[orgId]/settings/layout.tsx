import type { ReactNode } from "react";

import { SettingsTabs } from "@/features/settings/components/settings-tabs";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

export default async function SettingsLayout({ children, params }: Props) {
  const { orgId } = await params;
  const { canDelete, canWrite, role } = await getOrgContext(orgId);
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold leading-tight">הגדרות</h1>
      <SettingsTabs
        orgId={orgId}
        showTrash={canDelete}
        showCustomization={isAdminRole(role)}
        // owners, admins and team managers import (app.can_import)
        showImport={canWrite && (isAdminRole(role) || role === "manager")}
      />
      {children}
    </>
  );
}
