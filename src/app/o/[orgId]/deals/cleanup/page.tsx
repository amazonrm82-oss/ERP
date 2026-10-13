import type { Metadata } from "next";

import { EmptyState, FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { CleanupList } from "@/features/pipeline-cleanup/components/cleanup-list";
import { getCleanupActions, getPipelineCleanup } from "@/features/pipeline-cleanup/queries";
import { getOrgContext } from "@/features/shell/queries";
import { withReportShape } from "@/features/reports/schemas";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";
import { firstParam } from "@/lib/search";

export const metadata: Metadata = { title: "ניקוי שבועי" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * MNY-05: the weekly pipeline cleanup. The open deals the user may see that need a decision:
 * stuck longer than their stage allows, or past their expected close date (owner, 13 October
 * 2026). A rep starts on their own deals, others on everything they see.
 */
export default async function PipelineCleanupPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const requested = firstParam(query.owner);
  const mine = requested === "me" || (requested !== "all" && context.role === "member");
  const list = await withReportShape(() => getPipelineCleanup(orgId, mine ? context.user.id : null));
  const actions = list.ok && list.value ? await getCleanupActions(context, list.value.deals, list.value.today) : null;

  return (
    <>
      <PageHeader
        title="ניקוי שבועי"
        description="עסקאות שתקועות בשלב יותר מהזמן שנקבע לו, ועסקאות שתאריך הסגירה שלהן עבר. לכל אחת: לקדם, לדחות עם תאריך, או לסגור כאבודה."
        back={{ href: paths.deals(orgId), label: "עסקאות" }}
      />
      <Tabs
        label="של מי העסקאות"
        className="mb-4"
        items={[
          { href: paths.dealsCleanup(orgId, "me"), label: "שלי", current: mine },
          { href: paths.dealsCleanup(orgId, "all"), label: "כל מה שאני רואה", current: !mine },
        ]}
      />
      {!list.ok ? (
        <FormError message={list.message} />
      ) : !list.value || list.value.total === 0 ? (
        <EmptyState kind="done" title="אין עסקאות שמחכות להחלטה" description="עסקה שתיתקע בשלב או שתאריך הסגירה שלה יעבור תופיע כאן." />
      ) : (
        <>
          <p className="mb-3 text-md">
            <span className="font-semibold tabular-nums">{formatNumber(list.value.total)}</span> עסקאות בשווי{" "}
            <span className="font-semibold tabular-nums">{formatMoney(list.value.amount)}</span> מחכות להחלטה. הרשימה מתחילה בעסקאות בלי פעילות.
          </p>
          <CleanupList orgId={orgId} deals={list.value.deals} total={list.value.total} actions={actions} />
        </>
      )}
    </>
  );
}
