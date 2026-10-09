import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TrashRecordButton } from "@/components/trash-record-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { listCompanyOptions } from "@/features/companies/queries";
import { listContactOptions } from "@/features/contacts/queries";
import { trashDealAction } from "@/features/deals/actions";
import { DealDetailsCard } from "@/features/deals/components/deal-details-card";
import { DealStageForm } from "@/features/deals/components/deal-stage-form";
import { DEAL_STATUS } from "@/features/deals/display";
import { getDeal } from "@/features/deals/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";
import { RecordFiles } from "@/features/files/components/record-files";
import { isAdminRole } from "@/features/settings/permissions";

export const metadata: Metadata = { title: "עסקה" };

type Props = { params: Promise<{ orgId: string; dealId: string }> };

export default async function DealPage({ params }: Props) {
  const { orgId, dealId } = await params;
  const context = await getOrgContext(orgId);
  if (!isUuid(dealId)) {
    notFound();
  }
  const [deal, fields, tags] = await Promise.all([getDeal(orgId, dealId), listFieldDefinitions(orgId, "deal"), listTags(orgId)]);
  if (!deal) {
    notFound();
  }
  const canEdit = canEditRecordHint(context, deal.owner_id);
  const [contacts, companies] = canEdit
    ? await Promise.all([listContactOptions(orgId), listCompanyOptions(orgId)])
    : [[], []];
  const stage = deal.stages.find((option) => option.id === deal.stage_id);
  const status = DEAL_STATUS[deal.status];
  const amount = deal.amount_agorot;

  return (
    <>
      <PageHeader
        title={deal.name}
        description={deal.pipelineName ? `תהליך המכירה "${deal.pipelineName}"` : undefined}
        back={{ href: paths.deals(orgId), label: "עסקאות" }}
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} />
          <RecordFiles orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <RecordHistory orgId={orgId} entityType="deals" entityId={deal.id} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordTasks orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} />
          <Card aria-labelledby="deal-stage-title">
            <CardHeader id="deal-stage-title" title="שלב" />
            <CardBody>
              <p className="text-md">
                <span className="font-medium">{stage?.name ?? "ללא שלב"}</span>
                <span className="text-ink-soft">, {formatMoney(amount)}</span>
              </p>
              {canEdit ? (
                <DealStageForm
                  key={deal.stage_id}
                  orgId={orgId}
                  dealId={deal.id}
                  dealName={deal.name}
                  currentStageId={deal.stage_id}
                  stages={deal.stages}
                />
              ) : null}
            </CardBody>
          </Card>

          <DealDetailsCard
            orgId={orgId}
            canEdit={canEdit}
            contacts={contacts}
            companies={companies}
            deal={{
              id: deal.id,
              name: deal.name,
              status: deal.status,
              contactId: deal.contact_id,
              contactName: deal.contactName,
              companyId: deal.company_id,
              companyName: deal.companyName,
              lostReason: deal.lost_reason,
              amountText: formatMoney(amount),
              amountInput: amount % 100 === 0 ? String(amount / 100) : (amount / 100).toFixed(2),
              expectedCloseDate: deal.expected_close_date,
              expectedCloseText: deal.expected_close_date ? formatDate(deal.expected_close_date) : null,
              closedAtText: deal.closed_at ? formatDateTime(deal.closed_at) : null,
              ownerName: deal.ownerName,
              createdAtText: formatDateTime(deal.created_at),
              custom: { definitions: fields, values: asCustomValues(deal.custom_fields) },
            }}
          />

          <TagPicker orgId={orgId} kind="deal" recordId={deal.id} allTags={tags} selectedIds={deal.tag_ids} canEdit={canEdit} />

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 border-t border-line pt-5 empty:hidden">
        {context.canDelete ? <TrashRecordButton noun="העסקה" action={trashDealAction.bind(null, orgId, deal.id)} /> : null}
      </div>
    </>
  );
}
