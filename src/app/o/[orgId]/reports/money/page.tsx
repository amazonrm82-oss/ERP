import type { Metadata } from "next";

import { EmptyState, FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { MoneyView } from "@/features/money-waiting/components/money-view";
import { RowActions } from "@/features/money-waiting/components/row-actions";
import { getMoneyWaiting, getRowActionSetup } from "@/features/money-waiting/queries";
import { rowActions } from "@/features/money-waiting/row-actions";
import { withReportShape } from "@/features/reports/schemas";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { recordTemplateValues } from "@/features/whatsapp/templates";
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
  // MNY-02: what the rows' actions need (hints only; the database decides)
  const setup = money.ok && money.value ? await getRowActionSetup(orgId, context.canWrite, money.value.deals) : null;
  const canReassign = (ownerId: string | null) => context.role !== "member" && canEditRecordHint(context, ownerId);

  return (
    <>
      <PageHeader
        title="כסף שמחכה"
        description="כמה כסף אפשר להכניס אם מטפלים במה שכבר נמצא במערכת. לכל שורה יש פעולה: משימה, הקצאה לנציג או WhatsApp."
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
        <MoneyView
          orgId={orgId}
          money={money.value}
          owner={mine ? "me" : "all"}
          dealAction={(deal) => {
            const person = deal.contactId ? setup?.contacts.get(deal.contactId) : undefined;
            const target = {
              kind: "deal" as const,
              id: deal.id,
              name: deal.name,
              ownerId: deal.ownerId,
              phoneE164: person?.phoneE164 ?? null,
              values: recordTemplateValues({ firstName: person?.firstName, fullName: person?.fullName ?? null }, context),
              personName: person?.fullName || deal.name,
            };
            const actions = rowActions({ kind: "deal", ownerId: deal.ownerId, phoneE164: target.phoneE164, canWrite: context.canWrite, canReassign: canReassign(deal.ownerId) });
            return <RowActions orgId={orgId} target={target} actions={actions} owners={setup?.owners ?? []} />;
          }}
          leadAction={(lead) => {
            const target = {
              kind: "lead" as const,
              id: lead.id,
              name: lead.name,
              ownerId: lead.ownerId,
              phoneE164: lead.phoneE164,
              values: recordTemplateValues({ fullName: lead.fullName }, context),
              personName: lead.name,
            };
            const actions = rowActions({ kind: "lead", ownerId: lead.ownerId, phoneE164: lead.phoneE164, canWrite: context.canWrite, canReassign: canReassign(lead.ownerId) });
            return <RowActions orgId={orgId} target={target} actions={actions} owners={setup?.owners ?? []} />;
          }}
        />
      )}
    </>
  );
}
