import type { Metadata } from "next";

import { ComingSoon } from "@/features/shell/components/coming-soon";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "חברות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function CompaniesPage({ params }: Props) {
  const { orgId } = await params;
  await getOrgContext(orgId);
  return <ComingSoon orgId={orgId} title="חברות" description="כאן ינוהלו החברות שהעסק עובד איתן, עם אנשי הקשר והעסקאות של כל אחת. בינתיים חברה נוצרת אוטומטית כשממירים ליד שיש לו שם חברה." />;
}
