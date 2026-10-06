import type { Metadata } from "next";

import { ComingSoon } from "@/features/shell/components/coming-soon";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "הגדרות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function SettingsPage({ params }: Props) {
  const { orgId } = await params;
  await getOrgContext(orgId);
  return <ComingSoon orgId={orgId} title="הגדרות" description="כאן יוגדרו פרטי העסק, משתמשים והרשאות, שלבי הפייפליין, סטטוסים ומקורות לידים וסל המחזור." />;
}
