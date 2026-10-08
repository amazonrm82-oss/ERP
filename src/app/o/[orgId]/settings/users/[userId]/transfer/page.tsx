import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { TransferRecordsForm } from "@/features/settings/components/transfer-records-form";
import { isAdminRole } from "@/features/settings/permissions";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "העברת רשומות" };

type Props = { params: Promise<{ orgId: string; userId: string }> };

const KINDS = [
  { table: "leads", label: "לידים" },
  { table: "contacts", label: "אנשי קשר" },
  { table: "companies", label: "חברות" },
  { table: "deals", label: "עסקאות" },
  { table: "tasks", label: "משימות" },
] as const;

export default async function TransferRecordsPage({ params }: Props) {
  const { orgId, userId } = await params;
  if (!isUuid(userId)) notFound();
  const { role, canWrite } = await getOrgContext(orgId);
  const back = { href: paths.settingsUsers(orgId), label: "משתמשים" };
  if (!isAdminRole(role) || !canWrite) {
    return (
      <>
        <PageHeader title="העברת רשומות" back={back} />
        <p>העברת רשומות מותרת לבעלים ולמנהלי מערכת.</p>
      </>
    );
  }
  const members = await listMembers(orgId);
  const person = members.find((m) => m.userId === userId);
  if (!person) notFound();

  const supabase = await createClient();
  const counts = await Promise.all(
    KINDS.map(async (k) => {
      const { count } = await supabase.from(k.table).select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("owner_id", userId);
      return { ...k, count: count ?? 0 };
    }),
  );
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const candidates = members
    .filter((m) => m.userId !== userId && m.status === "active" && m.role !== "viewer")
    .map((m) => ({ userId: m.userId, name: m.name }));

  return (
    <>
      <PageHeader
        title={`העברת הרשומות של ${person.name}`}
        description={`כל מה שבבעלות ${person.name} עובר למשתמש אחר: לידים, אנשי קשר, חברות ועסקאות (גם בסל המחזור), ומשימות.`}
        back={back}
      />
      <Card className="max-w-xl">
        <CardHeader title={total === 0 ? "אין רשומות להעביר" : `${formatNumber(total)} רשומות`} />
        <CardBody className="space-y-4">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-md sm:grid-cols-3">
            {counts.map((c) => (
              <li key={c.table}>
                {c.label}: <span className="font-semibold">{formatNumber(c.count)}</span>
              </li>
            ))}
          </ul>
          <TransferRecordsForm orgId={orgId} fromUserId={userId} fromName={person.name} total={total} candidates={candidates} />
          <p className="text-sm text-ink-soft">המשתמש החדש יקבל התראה אחת עם הסיכום. ההעברה לא מפעילה אוטומציות.</p>
        </CardBody>
      </Card>
    </>
  );
}
