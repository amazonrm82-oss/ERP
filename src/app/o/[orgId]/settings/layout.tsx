import type { ReactNode } from "react";

import { getMyPermissions } from "@/features/permissions/queries";
import { SettingsFrame } from "@/features/settings/components/settings-frame";
import { orgHasFeature } from "@/features/settings/queries";
import { settingsAccessFor } from "@/features/settings/sections";
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
  const [priceLists, granted] = await Promise.all([orgHasFeature(orgId, "price_lists"), getMyPermissions(orgId)]);
  return (
    <SettingsFrame
      orgId={orgId}
      // the same rule as the settings page and the command palette (REC-09)
      access={settingsAccessFor({ role, canWrite, canDelete, priceLists, granted })}
    >
      {children}
    </SettingsFrame>
  );
}
