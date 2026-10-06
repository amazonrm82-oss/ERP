import type { Metadata } from "next";

import { ComingSoon } from "@/features/shell/components/coming-soon";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "משימות" };

type Props = { params: Promise<{ orgId: string }> };

export default async function TasksPage({ params }: Props) {
  const { orgId } = await params;
  await getOrgContext(orgId);
  return <ComingSoon orgId={orgId} title="משימות" description="כאן תהיה רשימת המשימות המלאה, עם סינון לפי תאריך ואחראי. בינתיים אפשר להוסיף ולסיים משימות מדף הבית." />;
}
