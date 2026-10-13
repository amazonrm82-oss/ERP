import type { Metadata } from "next";

import { EmptyState, FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { MoneyView } from "@/features/money-waiting/components/money-view";
import { getMoneyWaiting } from "@/features/money-waiting/queries";
import { withReportShape } from "@/features/reports/schemas";
import { getOrgContext } from "@/features/shell/queries";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "כסף שמחכה" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * MNY-01: how much money the business can bring in by handling what is already in the system.
 * Every user counts only the records they may see (the report is security invoker); a rep starts
 * on their own records, others on everything they see.
 */
export default async function MoneyWaitingPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const requested = firstParam(query.owner);
  const mine = requested === "me" || (requested !== "all" && context.role === "member");
  const money = await withReportShape(() => getMoneyWaiting(orgId, mine ? context.user.id : null));

  return (
    <>
      <PageHeader
        title="כסף שמחכה"
        description="כמה כסף אפשר להכניס אם מטפלים במה שכבר נמצא במערכת. כל שורה היא רשומה שאפשר לטפל בה."
        back={{ href: paths.reports(orgId), label: "דוחות" }}
      />
      <Tabs
        label="של מי הרשומות"
        className="mb-4"
        items={[
          { href: paths.moneyWaiting(orgId, "me"), label: "שלי", current: mine },
          { href: paths.moneyWaiting(orgId, "all"), label: "כל מה שאני רואה", current: !mine },
        ]}
      />
      {!money.ok ? (
        <FormError message={money.message} />
      ) : !money.value ? (
        <EmptyState title="אין נתונים להצגה" />
      ) : (
        <MoneyView orgId={orgId} money={money.value} owner={mine ? "me" : "all"} />
      )}
    </>
  );
}
