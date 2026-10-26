import { getOrgTerms } from "@/features/terminology/queries";
import { byGender } from "@/features/terminology/terms";
import { FollowButton } from "@/features/followers/components/follow-button";
import { getFollowState } from "@/features/followers/queries";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TrashRecordButton } from "@/components/trash-record-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PrintButton } from "@/features/print/components/print-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { Timeline } from "@/features/activities/components/timeline";
import { ShareSummary } from "@/features/share/components/share-summary";
import { recordSummary } from "@/features/share/summary";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { listCompanyOptions } from "@/features/companies/queries";
import { getOrgModules } from "@/features/modules/queries";
import { trashDealAction } from "@/features/deals/actions";
import { DealContactsCard } from "@/features/deal-contacts/components/deal-contacts-card";
import { dealContactExclude } from "@/features/deal-contacts/options";
import { listDealContactRoles, listDealContacts } from "@/features/deal-contacts/queries";
import { activeLossReasons, listLossReasons } from "@/features/deal-loss-reasons/queries";
import { getCardLayout } from "@/features/card-layout/queries";
import { DealDetailsCard } from "@/features/deals/components/deal-details-card";
import { agorotInput, BILLING_KIND_LABELS, billingKindOf, recurringText, shownRecurringAmount } from "@/features/deals/recurring";
import { DealSnoozeForm } from "@/features/deals/components/deal-snooze-form";
import { DealStageForm } from "@/features/deals/components/deal-stage-form";
import { DEAL_STATUS } from "@/features/deals/display";
import { getDeal, getDealLinks, listPipelines } from "@/features/deals/queries";
import { DealContinuationCard } from "@/features/deals/components/deal-continuation-card";
import { skippedNotice } from "@/features/deals/copy";
import { stageTone } from "@/features/deals/stage-colors";
import { isSnoozed } from "@/features/deals/snooze";
import { getDealAttention } from "@/features/deals/stuck";
import { DEFAULT_CALENDAR_SETTINGS } from "@/features/calendar-days/holidays";
import { getCalendarSettings } from "@/features/calendar-days/queries";
import { closeWindowSetup } from "@/features/deals/close-window";
import { listMembers } from "@/features/settings/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDate, formatDateTime, formatMoney, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";
import { RecordFiles } from "@/features/files/components/record-files";
import { canEditCatalog, canViewCosts } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { readDealLineCosts, readProductCosts } from "@/features/product-costs/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { editFocusParam } from "@/features/data-quality/completeness";
import { CompletenessCard } from "@/features/data-quality/components/completeness-card";
import { DealLinesCard } from "@/features/deal-lines/components/deal-lines-card";
import { RecordQuotesCard } from "@/features/quotes/components/record-quotes-card";
import { RecordOrdersCard } from "@/features/orders/components/record-orders-card";
import { RecordDocumentsCard } from "@/features/documents/components/record-documents-card";
import { RecordPaymentsCard } from "@/features/payments/components/record-payments-card";
import { getOrdersAccess } from "@/features/orders/access";
import { quoteAmountMark } from "@/features/quotes/accept-deal";
import { getQuoteNumberDisplay } from "@/features/quotes/queries";
import { getDealPricing, listDealLines } from "@/features/deal-lines/queries";
import { orgHasFeature } from "@/features/settings/queries";

// FLD-10: the tab title in the business's word
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { orgId } = await params;
  return { title: (await getOrgTerms(orgId)).deal.singular };
}

type Props = {
  params: Promise<{ orgId: string; dealId: string }>;
  // REC-06: tl = the timeline filter
  // DEAL-11: copy_fields = the custom fields a copy left out (keys, or "all")
  searchParams: Promise<{ tl?: string | string[]; edit?: string | string[]; copy_fields?: string | string[] }>;
};

export default async function DealPage({ params, searchParams }: Props) {
  const [{ orgId, dealId }, { tl, edit, copy_fields: copyFields }] = await Promise.all([params, searchParams]);
  // DQL-01: open the details for editing at this input
  const focus = editFocusParam(edit);
  const context = await getOrgContext(orgId);
  if (!isUuid(dealId)) {
    notFound();
  }
  // CON-03 follow-up: the business's list of roles names each linked contact's role
  const contactRoles = await listDealContactRoles(orgId);
  const [deal, fields, tags, follow, dealContacts, lossReasons, cardLayout, terms] = await Promise.all([
    getDeal(orgId, dealId),
    listFieldDefinitions(orgId, "deal"),
    listTags(orgId),
    getFollowState(orgId, { kind: "deal", id: dealId }, context.user.id),
    listDealContacts(orgId, dealId, contactRoles),
    listLossReasons(orgId),
    // FLD-08: the business's card layout (null = the default)
    getCardLayout(orgId, "deal"),
    // FLD-10: the business's words for deals and contacts
    getOrgTerms(orgId),
  ]);
  if (!deal) {
    notFound();
  }
  const canEdit = canEditRecordHint(context, deal.owner_id);
  // LEAD-08: with companies switched off the deal's company field is left out (null)
  const modules = await getOrgModules(orgId);
  const [companyOptions, members, calendar] = canEdit
    ? await Promise.all([modules.companies ? listCompanyOptions(orgId) : [], listMembers(orgId), getCalendarSettings(orgId)])
    : [[], [], DEFAULT_CALENDAR_SETTINGS];
  const companies = modules.companies ? companyOptions : null;
  // DEAL-04: the close window of a move into a won stage; the onboarding task goes to an active member who writes
  const closeWindow = {
    ...closeWindowSetup(
      members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
      context.org.timeZone,
      calendar,
      context.user.id,
    ),
    // DEAL-04 wave 2: the close window also offers the deal's order while the orders module is on
    orders: (await getOrdersAccess(orgId)).on,
  };
  // DEAL-11: the deal this one continues and its follow-ups; the pipelines for a new deal (writers only)
  const [links, pipelines, lines, hasProducts, hasDiscounts, hasQuotes] = await Promise.all([
    getDealLinks(orgId, deal.id, deal.previous_deal_id),
    context.canWrite ? listPipelines(orgId) : Promise.resolve(null),
    listDealLines(orgId, deal.id),
    orgHasFeature(orgId, "products"),
    orgHasFeature(orgId, "discounts"),
    // QUO-01
    orgHasFeature(orgId, "quotes"),
  ]);
  // DLI-01, PL-03: the day, the VAT and the customer's price list the lines are priced by
  const linesPricing = await getDealPricing(orgId, { contactId: deal.contact_id, companyId: deal.company_id }, lines, context.org.timeZone);
  const granted = await getMyPermissions(orgId);
  // PRD-06: the cost kept on each line, and its product's cost in the catalog today, only for those who see costs; RLS
  // applies the same rule. A line's cost can be changed only on an open deal (the database locks a closed one).
  const seesCosts = canViewCosts(context.role, granted);
  const lineProductIds = lines.flatMap((line) => (line.productId ? [line.productId] : []));
  const [keptCosts, catalogCosts] =
    seesCosts && lines.length > 0
      ? await Promise.all([
          readDealLineCosts(
            orgId,
            lines.map((line) => line.id),
          ),
          lineProductIds.length > 0 ? readProductCosts(orgId, lineProductIds) : Promise.resolve(new Map<string, number>()),
        ])
      : [null, null];
  const lineCosts =
    keptCosts && catalogCosts
      ? Object.fromEntries(
          lines.map((line) => [
            line.id,
            { cost: keptCosts.get(line.id) ?? null, catalog: line.productId ? (catalogCosts.get(line.productId) ?? null) : null },
          ]),
        )
      : null;
  const canEditCosts = seesCosts && canEdit && context.canWrite && hasProducts && deal.status === "open";
  // DEAL-11: right after a copy, the custom fields it could not carry
  const copyNotice = skippedNotice(copyFields, fields);
  const attention = deal.status === "open" ? (await getDealAttention(orgId, [deal.id]))[deal.id] : undefined;
  const today = zoneDate(new Date(), context.org.timeZone);
  const stage = deal.stages.find((option) => option.id === deal.stage_id);
  const status = DEAL_STATUS[deal.status];
  const amount = deal.amount_agorot;
  // DEAL-03: the picked reason by its current name; else the stored text (old free text, or a deleted reason)
  const lossReason = lossReasons.find((reason) => reason.id === deal.lost_reason_id) ?? null;
  const lossOptions = activeLossReasons(lossReasons);

  // QUO-13: the amount is an accepted quote's total (deals.amount_quote_id): its number, as the caller reads it
  const amountQuote = deal.amount_quote_id ? await getQuoteNumberDisplay(orgId, deal.amount_quote_id) : undefined;
  return (
    <>
      {/* GAP-11: the card on paper (business name, printed at; the screen tools are left out) */}
      <PrintHeader orgName={context.org.name} timeZone={context.org.timeZone} />
      <PageHeader
        title={deal.name}
        description={deal.pipelineName ? `תהליך המכירה "${deal.pipelineName}"` : undefined}
        back={{ href: paths.deals(orgId), label: terms.deal.plural }}
        actions={
          <>
            <Badge tone={status.tone}>{status.label}</Badge>
            <PrintButton />
            <FollowButton orgId={orgId} subject={{ kind: "deal", id: deal.id }} state={follow} />
          </>
        }
      />

      {copyNotice ? (
        <p role="status" className="mb-4 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {copyNotice}
        </p>
      ) : null}
      {attention && (attention.stuck || attention.noNextStep) ? (
        <p role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          <span className="font-semibold">{attention.stuck ? `${terms.deal.theSingular} ${byGender(terms.deal, "תקוע", "תקועה")}:` : "אין צעד הבא:"}</span>
          <span>{attention.text}.</span>
          <span>{attention.stuck
              ? `כדאי לקדם ${byGender(terms.deal, "אותו", "אותה")}, לדחות ${byGender(terms.deal, "אותו", "אותה")} לתאריך או לסגור.`
              : "כדאי לקבוע משימה הבאה או לתעד מה קרה."}</span>
        </p>
      ) : null}
      <div className="mb-5 print:hidden">
        <ShareSummary
          text={recordSummary(deal.name, [
            [terms.contact.singular, deal.contactName],
            ["טלפון", deal.contactPhone],
            ["חברה", deal.companyName],
            ["שלב", stage?.name],
            ["סכום", amount ? formatMoney(amount) : null],
            ["תאריך סגירה צפוי", deal.expected_close_date ? formatDate(deal.expected_close_date) : null],
            ["הכנסה חוזרת", recurringText(deal.billing_kind, shownRecurringAmount(deal.recurring_amount_agorot, deal.recurring_amount_auto))],
            ["תאריך חידוש", deal.renewal_date ? formatDate(deal.renewal_date) : null],
          ])}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <DealLinesCard
            orgId={orgId}
            dealId={deal.id}
            dealValue={{
              kind: deal.billing_kind,
              auto: deal.amount_auto === true,
              source: deal.amount_source,
              recurringAuto: deal.recurring_amount_auto === true,
              recurringAgorot: shownRecurringAmount(deal.recurring_amount_agorot, deal.recurring_amount_auto),
            }}
            lines={lines}
            pricing={linesPricing}
            canEdit={canEdit}
            features={{ products: hasProducts, discounts: hasDiscounts }}
            canCreateProducts={hasProducts && context.canWrite && canEditCatalog(context.role, granted)}
            costs={lineCosts}
            canEditCosts={canEditCosts}
          />
          {/* QUO-01: the deal's quotes, and a new one for whoever may edit the deal */}
          <RecordQuotesCard orgId={orgId} subject={{ kind: "deal", id: deal.id }} canCreate={hasQuotes && canEdit} />
          {/* ORD-01: the deal's orders while the orders module is on */}
          <RecordOrdersCard orgId={orgId} subject={{ kind: "deal", id: deal.id }} canCreate={canEdit} dealWon={deal.status === "won"} />
          {/* DOC-01: documents issued outside the system and recorded here */}
          <RecordDocumentsCard orgId={orgId} subject={{ kind: "deal", id: deal.id }} />
          {/* PAY-01: payments received and recorded here */}
          <RecordPaymentsCard orgId={orgId} subject={{ kind: "deal", id: deal.id }} />
          <Timeline orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} filter={tl} />
          {/* GAP-11: the files list prints (names, dates, uploaders); the card hides itself on paper when empty */}
          <RecordFiles orgId={orgId} subject={{ kind: "deal", id: deal.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <div className="space-y-5 print:hidden empty:hidden">
            <RecordHistory orgId={orgId} entityType="deals" entityId={deal.id} />
          </div>
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
              {canEdit && deal.status === "open" ? (
                <DealSnoozeForm
                  orgId={orgId}
                  dealId={deal.id}
                  snoozedUntil={deal.snoozed_until}
                  snoozed={isSnoozed(deal.snoozed_until, today)}
                  today={today}
                  timeZone={context.org.timeZone}
                />
              ) : null}
            </CardBody>
          </Card>

          {/* DQL-01: what is still missing matters while the deal is open */}
          <div className="print:hidden empty:hidden">
            {deal.status === "open" ? <CompletenessCard orgId={orgId} type="deal" id={deal.id} editBase={canEdit ? paths.deal(orgId, deal.id) : null} /> : null}
          </div>
          <DealDetailsCard
            layout={cardLayout}
            key={focus ?? "view"}
            focus={focus}
            orgId={orgId}
            canEdit={canEdit}
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
              // a one-time deal's 0 is "empty" (DEAL-07): left empty, a deal made recurring gets its first-year value
              amountInput: amount === 0 && !deal.billing_kind ? "" : agorotInput(amount),
              amountAuto: deal.amount_auto === true,
              amountSource: deal.amount_source,
              amountQuoteMark: amountQuote === undefined ? null : quoteAmountMark(amountQuote),
              expectedCloseDate: deal.expected_close_date,
              expectedCloseText: deal.expected_close_date ? formatDate(deal.expected_close_date) : null,
              recurring: {
                kind: deal.billing_kind,
                kindText: BILLING_KIND_LABELS[billingKindOf(deal.billing_kind)],
                amountText: recurringText(deal.billing_kind, shownRecurringAmount(deal.recurring_amount_agorot, deal.recurring_amount_auto)),
                amountInput: agorotInput(shownRecurringAmount(deal.recurring_amount_agorot, deal.recurring_amount_auto)),
                amountAuto: deal.recurring_amount_auto === true,
                startDate: deal.recurring_start_date,
                startText: deal.recurring_start_date ? formatDate(deal.recurring_start_date) : null,
                renewalDate: deal.renewal_date,
                renewalText: deal.renewal_date ? formatDate(deal.renewal_date) : null,
              },
              // DEAL-04: a day the close window picked is kept at midday, so the day is shown, not the hour
              closedAtText: deal.closed_at ? formatDate(zoneDate(new Date(deal.closed_at), context.org.timeZone)) : null,
              ownerName: deal.ownerName,
              createdAtText: formatDateTime(deal.created_at),
              custom: { definitions: fields, values: asCustomValues(deal.custom_fields), builtins: { "builtin:stage": deal.stage_id, "builtin:pipeline": deal.pipeline_id } },
            }}
            terms={terms}
          />

          <DealContactsCard
            orgId={orgId}
            dealId={deal.id}
            canEdit={canEdit}
            items={dealContacts}
            roles={contactRoles}
            exclude={dealContactExclude(
              dealContacts.map((item) => item.contactId),
              deal.contact_id,
            )}
            terms={terms}
          />

          <DealContinuationCard
            orgId={orgId}
            deal={{ id: deal.id, name: deal.name, pipelineId: deal.pipeline_id, stageName: stage?.name ?? null, stageOpen: stage?.kind === "open" }}
            links={links}
            pipelines={pipelines}
          />

          <TagPicker orgId={orgId} kind="deal" recordId={deal.id} allTags={tags} selectedIds={deal.tag_ids} canEdit={canEdit} />

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 border-t border-line pt-5 empty:hidden print:hidden">
        {context.canDelete ? <TrashRecordButton noun={terms.deal.theSingular} action={trashDealAction.bind(null, orgId, deal.id)} /> : null}
      </div>
    </>
  );
}
