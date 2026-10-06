import type { ReactNode } from "react";

import { SettingsTabs } from "@/features/settings/components/settings-tabs";

type Props = { children: ReactNode; params: Promise<{ orgId: string }> };

export default async function SettingsLayout({ children, params }: Props) {
  const { orgId } = await params;
  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold leading-tight">הגדרות</h1>
      <SettingsTabs orgId={orgId} />
      {children}
    </>
  );
}
