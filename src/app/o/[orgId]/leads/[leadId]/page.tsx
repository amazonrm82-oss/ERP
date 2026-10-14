import { RecordConsents } from "@/features/consents/components/record-consents";
import { FollowButton } from "@/features/followers/components/follow-button";
import { getFollowState } from "@/features/followers/queries";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { recordTemplateValues } from "@/features/whatsapp/templates";
import { ShareSummary } from "@/features/share/components/share-summary";
import { recordSummary } from "@/features/share/summary";
import { QuickNote } from "@/features/activities/components/quick-note";
import { TrashRecordButton } from "@/components/trash-record-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PrintButton } from "@/features/print/components/print-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { Timeline } from "@/features/activities/components/timeline";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { trashLeadAction } from "@/features/leads/actions";
import { ConvertLeadPanel } from "@/features/leads/components/convert-lead-panel";
import { attributionRows } from "@/features/intake/attribution";
import { LeadDetailsCard } from "@/features/leads/components/lead-details-card";
import { activeReasonNames } from "@/features/disqualify-reasons/queries";
import { LeadStatusForm } from "@/features/leads/components/lead-status-form";
import { leadDisplayName, statusTone } from "@/features/leads/display";
import { getLead, getLeadLookups } from "@/features/leads/queries";
import { getRequestedProduct, requestedProductEnabled } from "@/features/requested-product/queries";
import { utmValues } from "@/features/leads/schema";
import { canEditRecordHint, getOrgContext, getUserNames } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDate, formatDateTime } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";
import { RecordFiles } from "@/features/files/components/record-files";
import { DuplicatesCard } from "@/features/merge/components/duplicates-card";
import { isAdminRole } from "@/features/settings/permissions";
import { editFocusParam } from "@/features/data-quality/completeness";
import { CompletenessCard } from "@/features/data-quality/components/completeness-card";

export const metadata: Metadata = { title: "ליד" };

type Props = {
  params: Promise<{ orgId: string; leadId: string }>;
  // REC-06: tl = the timeline filter; DQL-01: edit = open the details for editing at this input
  searchParams: Promise<{ tl?: string | string[]; edit?: string | string[] }>;
};

const linkClass = "font-medium text-accent underline underline-offset-4 hover:text-accent-strong";

export default async function LeadPage({ params, searchParams }: Props) {
  const [{ orgId, leadId }, { tl, edit }] = await Promise.all([params, searchParams]);
  const focus = editFocusParam(edit);
  const context = await getOrgContext(orgId);
  const { canWrite, canDelete } = context;
  if (!isUuid(leadId)) {
    notFound();
  }

  const [lead, lookups, fields, reasons, follow] = await Promise.all([
    getLead(orgId, leadId),
    getLeadLookups(orgId),
    listFieldDefinitions(orgId, "lead"),
    activeReasonNames(orgId),
    getFollowState(orgId, { kind: "lead", id: leadId }, context.user.id),
  ]);
  if (!lead) {
    notFound();
  }
  // LEAD-04: the requested product, and whether the plan has the product catalog
  const [tags, owners, productsEnabled, requestedProduct] = await Promise.all([
    listTags(orgId),
    getUserNames([lead.owner_id]),
    requestedProductEnabled(orgId),
    getRequestedProduct(orgId, lead.requested_product_id),
  ]);

  const name = leadDisplayName({ fullName: lead.full_name, email: lead.email, phone: lead.phone });
  const status = lookups.statuses.find((option) => option.id === lead.status_id);
  const isConverted = lead.converted_at !== null;

  return (
    <>
      {/* GAP-11: the card on paper (business name, printed at; the screen tools are left out) */}
      <PrintHeader orgName={context.org.name} timeZone={context.org.timeZone} />
      <PageHeader
        title={name}
        back={{ href: paths.leads(orgId), label: "לידים" }}
        actions={
          <>
            <Badge tone={statusTone(status)}>{status?.name ?? "ללא סטטוס"}</Badge>
            <PrintButton />
            <FollowButton orgId={orgId} subject={{ kind: "lead", id: lead.id }} state={follow} />
          </>
        }
      />
      <div className="mb-5 print:hidden">
        <ContactActions phone={lead.phone} phoneE164={lead.phone_e164} email={lead.email} saveHref={paths.vcard(orgId, "lead", lead.id)}
          callLog={context.canWrite ? { orgId, subject: { kind: "lead", id: lead.id }, name } : undefined}
          whatsappLog={
            context.canWrite
              ? { orgId, subject: { kind: "lead", id: lead.id }, name, values: recordTemplateValues({ fullName: lead.full_name }, context) }
              : undefined
          }
        />
        <div className="mt-2">
          <ShareSummary
            text={recordSummary(name, [
              ["טלפון", lead.phone],
              ["אימייל", lead.email],
              ["חברה", lead.company_name],
              ["תפקיד", lead.job_title],
              ["פנייה", lead.message],
            ])}
          />
        </div>
        {context.canWrite ? <QuickNote orgId={orgId} subject={{ kind: "lead", id: lead.id }} className="mt-4 lg:hidden" /> : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "lead", id: lead.id }} canWrite={canWrite} filter={tl} />
          {/* GAP-11: the files list prints (names, dates, uploaders); the card hides itself on paper when empty */}
          <RecordFiles orgId={orgId} subject={{ kind: "lead", id: lead.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <div className="space-y-5 print:hidden empty:hidden">
            <DuplicatesCard orgId={orgId} type="lead" id={lead.id} canMerge={context.canDelete} />
            <RecordHistory orgId={orgId} entityType="leads" entityId={lead.id} />
          </div>
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordTasks orgId={orgId} subject={{ kind: "lead", id: lead.id }} canWrite={context.canWrite} />
          <RecordMeetings orgId={orgId} subject={{ kind: "lead", id: lead.id }} canWrite={context.canWrite} timeZone={context.org.timeZone} userId={context.user.id} />
          {isConverted ? (
            <Card aria-labelledby="converted-title">
              <CardHeader id="converted-title" title="הליד הומר" />
              <CardBody>
                <p className="text-md text-ink-soft">הומר בתאריך {formatDate(lead.converted_at)}.</p>
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-md">
                  {lead.converted_contact_id ? (
                    <Link href={paths.contact(orgId, lead.converted_contact_id)} className={linkClass}>
                      לאיש הקשר
                    </Link>
                  ) : null}
                  {lead.converted_deal_id ? (
                    <Link href={paths.deal(orgId, lead.converted_deal_id)} className={linkClass}>
                      לעסקה
                    </Link>
                  ) : null}
                </p>
              </CardBody>
            </Card>
          ) : canWrite ? (
            <Card aria-labelledby="status-title" className="print:hidden">
              <CardHeader id="status-title" title="סטטוס והמרה" />
              <CardBody className="space-y-5">
                <LeadStatusForm
                  key={lead.status_id}
                  orgId={orgId}
                  leadId={lead.id}
                  currentStatusId={lead.status_id}
                  statuses={lookups.statuses}
                  reasons={reasons}
                />
                <div className="border-t border-line pt-5">
                  <ConvertLeadPanel
                    orgId={orgId}
                    leadId={lead.id}
                    defaultDealName={lead.full_name ?? lead.company_name ?? ""}
                    hasCompany={Boolean(lead.company_name)}
                  />
                </div>
              </CardBody>
            </Card>
          ) : null}

          {/* DQL-01: a converted lead lives on as its contact and deal */}
          {!isConverted ? (
            <div className="print:hidden empty:hidden">
              <CompletenessCard orgId={orgId} type="lead" id={lead.id} editBase={canWrite && canEditRecordHint(context, lead.owner_id) ? paths.lead(orgId, lead.id) : null} />
            </div>
          ) : null}

          <LeadDetailsCard
            key={focus ?? "view"}
            focus={focus}
            orgId={orgId}
            canWrite={canWrite}
            sources={lookups.sources}
            lead={{
              id: lead.id,
              fullName: lead.full_name,
              phone: lead.phone,
              email: lead.email,
              companyName: lead.company_name,
              sourceId: lead.source_id,
              message: lead.message,
              // an old reason left on a lead that is no longer "not relevant" is not shown (RVW-9)
              disqualifyReason: status?.kind === "disqualified" ? lead.disqualify_reason : null,
              ownerName: lead.owner_id ? (owners.get(lead.owner_id) ?? null) : null,
              createdAtText: formatDateTime(lead.created_at),
              lastContactText: lead.last_contacted_at ? formatDateTime(lead.last_contacted_at) : null,
              custom: { definitions: fields, values: asCustomValues(lead.custom_fields), builtins: { "builtin:status": lead.status_id, "builtin:source": lead.source_id } },
              attribution: attributionRows(lead),
              campaign: lead.campaign,
              budgetAgorot: lead.budget_agorot,
              utm: utmValues(lead.utm),
              requestedProduct: { enabled: productsEnabled, product: requestedProduct },
            }}
          />

          <TagPicker
            orgId={orgId}
            kind="lead"
            recordId={lead.id}
            allTags={tags}
            selectedIds={lead.tag_ids}
            canEdit={canEditRecordHint(context, lead.owner_id)}
          />

          <div className="print:hidden">
            <RecordConsents
              orgId={orgId}
              subject={{ kind: "lead", id: lead.id }}
              canEdit={canEditRecordHint(context, lead.owner_id)}
              hasPhone={Boolean(lead.phone_e164)}
              hasEmail={Boolean(lead.email?.trim())}
              canLift={isAdminRole(context.role)}
            />
          </div>

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 border-t border-line pt-5 empty:hidden print:hidden">
        {canDelete ? <TrashRecordButton noun="הליד" action={trashLeadAction.bind(null, orgId, lead.id)} /> : null}
      </div>
    </>
  );
}
