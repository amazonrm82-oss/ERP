import { FollowButton } from "@/features/followers/components/follow-button";
import { getFollowState } from "@/features/followers/queries";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TrashRecordButton } from "@/components/trash-record-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { ShareSummary } from "@/features/share/components/share-summary";
import { recordSummary } from "@/features/share/summary";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { listCompanyOptions } from "@/features/companies/queries";
import { listContactOptions } from "@/features/contacts/queries";
import { trashDealAction } from "@/features/deals/actions";
import { DealContactsCard } from "@/features/deal-contacts/components/deal-contacts-card";
import { addableDealContacts } from "@/features/deal-contacts/options";
import { listDealContacts } from "@/features/deal-contacts/queries";
import { activeLossReasons, listLossReasons } from "@/features/deal-loss-reasons/queries";
import { DealDetailsCard } from "@/features/deals/components/deal-details-card";
import { DealStageForm } from "@/features/deals/components/deal-stage-form";
import { DEAL_STATUS } from "@/features/deals/display";
import { getDeal } from "@/features/deals/queries";
import { stageTone } from "@/features/deals/stage-colors";
import { getStuckDeals } from "@/features/deals/stuck";
import { closeWindowSetup } from "@/features/deals/close-window";
import { listMembers } from "@/features/settings/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDate, formatDateTime, formatMoney, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";
import { RecordFiles } from "@/features/files/components/record-files";
import { isAdminRole } from "@/features/settings/permissions";

export const metadata: Metadata = { title: "עסקה" };

type Props = {
  params: Promise<{ orgId: string; dealId: string }>;
  // REC-06: tl = the timeline filter
  searchParams: Promise<{ tl?: string | string[] }>;
};

export default async function DealPage({ params, searchParams }: Props) {
  const [{ orgId, dealId }, { tl }] = await Promise.all([params, searchParams]);
  const context = await getOrgContext(orgId);
  if (!isUuid(dealId)) {
    notFound();
  }
  const [deal, fields, tags, follow, dealContacts, lossReasons] = await Promise.all([
    getDeal(orgId, dealId),
    listFieldDefinitions(orgId, "deal"),
    listTags(orgId),
    getFollowState(orgId, { kind: "deal", id: dealId }, context.user.id),
    listDealContacts(orgId, dealId),
    listLossReasons(orgId),
  ]);
  if (!deal) {
    notFound();
  }
  const canEdit = canEditRecordHint(context, deal.owner_id);
  const [contacts, companies, members] = canEdit
    ? await Promise.all([listContactOptions(orgId), listCompanyOptions(orgId), listMembers(orgId)])
    : [[], [], []];
  // DEAL-04: the close window of a move into a won stage; the onboarding task goes to an active member who writes
  const closeWindow = closeWindowSetup(
    members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
    context.org.timeZone,
  );
  const stuckReason = deal.status === "open" ? (await getStuckDeals(orgId, deal.pipeline_id))[deal.id] : undefined;
  const stage = deal.stages.find((option) => option.id === deal.stage_id);
  const status = DEAL_STATUS[deal.status];
  const amount = deal.amount_agorot;
  // DEAL-03: the picked reason by its current name; else the stored text (old free text, or a deleted reason)
  const lossReason = lossReasons.find((reason) => reason.id === deal.lost_reason_id) ?? null;
  const lossOptions = activeLossReasons(lossReasons);

  return (
    <>
      <PageHeader
        title={deal.name}
        description={deal.pipelineName ? `תהליך המכירה "${deal.pipelineName}"` : undefined}
        back={{ href: paths.deals(orgId), label: "עסקאות" }}
        actions={
          <>
            <Badge tone={status.tone}>{status.label}</Badge>
            <FollowButton orgId={orgId} subject={{ kind: "deal", id: deal.id }} state={follow} />
          </>
        }
      />

      {stuckReason ? (
        <p role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          <span className="font-semibold">העסקה תקועה:</span>
          <span>{stuckReason}.</span>
          <span>כדאי לקבוע משימה הבאה או לתעד מה קרה.</span>
        </p>
      ) : null}
      <div className="mb-5">
        <ShareSummary
          text={recordSummary(deal.name, [
            ["איש קשר", deal.contactName],
            ["טלפון", deal.contactPhone],
            ["חברה", deal.companyName],
            ["שלב", stage?.name],
            ["סכום", amount ? formatMoney(amount) : null],
            ["תאריך סגירה צפוי", deal.expected_close_date ? formatDate(deal.expected_close_date) : null],
          ])}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} filter={tl} />
          <RecordFiles orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <RecordHistory orgId={orgId} entityType="deals" entityId={deal.id} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordTasks orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} />
          <RecordMeetings orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} timeZone={context.org.timeZone} userId={context.user.id} />
          <Card aria-labelledby="deal-stage-title">
            <CardHeader id="deal-stage-title" title="שלב" />
            <CardBody>
              <p className="flex flex-wrap items-center gap-2 text-md">
                {stage ? <Badge tone={stageTone(stage)}>{stage.name}</Badge> : <span className="font-medium">ללא שלב</span>}
                <span className="text-ink-soft">{formatMoney(amount)}</span>
              </p>
              {canEdit ? (
                <DealStageForm
                  key={deal.stage_id}
                  orgId={orgId}
                  dealId={deal.id}
                  dealName={deal.name}
                  currentStageId={deal.stage_id}
                  stages={deal.stages}
                  lossReasons={lossOptions}
                  competitor={deal.competitor}
                  lossReason={lossReason ? { id: lossReason.id, name: lossReason.name } : null}
                  closeWindow={closeWindow}
                  amountAgorot={amount}
                  ownerId={deal.owner_id}
                />
              ) : null}
            </CardBody>
          </Card>

          <DealDetailsCard
            orgId={orgId}
            canEdit={canEdit}
            contacts={contacts}
            companies={companies}
            lossReasons={lossOptions}
            deal={{
              id: deal.id,
              name: deal.name,
              status: deal.status,
              contactId: deal.contact_id,
              contactName: deal.contactName,
              companyId: deal.company_id,
              companyName: deal.companyName,
              lostReason: lossReason?.name ?? deal.lost_reason,
              lossReason: lossReason ? { id: lossReason.id, name: lossReason.name } : null,
              competitor: deal.competitor,
              amountText: formatMoney(amount),
              amountInput: amount % 100 === 0 ? String(amount / 100) : (amount / 100).toFixed(2),
              expectedCloseDate: deal.expected_close_date,
              expectedCloseText: deal.expected_close_date ? formatDate(deal.expected_close_date) : null,
              // DEAL-04: a day the close window picked is kept at midday, so the day is shown, not the hour
              closedAtText: deal.closed_at ? formatDate(zoneDate(new Date(deal.closed_at), context.org.timeZone)) : null,
              ownerName: deal.ownerName,
              createdAtText: formatDateTime(deal.created_at),
              custom: { definitions: fields, values: asCustomValues(deal.custom_fields) },
            }}
          />

          <DealContactsCard
            orgId={orgId}
            dealId={deal.id}
            canEdit={canEdit}
            items={dealContacts}
            options={addableDealContacts(
              contacts,
              dealContacts.map((item) => item.contactId),
              deal.contact_id,
            )}
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
