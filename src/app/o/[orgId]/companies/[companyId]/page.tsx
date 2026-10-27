import { FollowButton } from "@/features/followers/components/follow-button";
import { createdLineText } from "@/features/imports/history";
import { ManualAutomationsButton } from "@/features/automations/components/manual-automations-button";
import { getFollowState } from "@/features/followers/queries";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { recordTemplateValues } from "@/features/whatsapp/templates";
import { QuickNote } from "@/features/activities/components/quick-note";
import { TrashRecordButton } from "@/components/trash-record-button";
import { PageHeader } from "@/components/ui/page-header";
import { PrintButton } from "@/features/print/components/print-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { Timeline } from "@/features/activities/components/timeline";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { RecordSummaryCard } from "@/features/record-summary/components/record-summary-card";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { withFieldRefs } from "@/features/custom-fields/refs";
import { asCustomValues } from "@/features/custom-fields/types";
import { trashCompanyAction } from "@/features/companies/actions";
import { getCardLayout } from "@/features/card-layout/queries";
import { CompanyDetailsCard } from "@/features/companies/components/company-details-card";
import { getCompany, getCompanyFamily } from "@/features/companies/queries";
import { CompanyPeopleCard } from "@/features/contact-companies/components/company-people-card";
import { listCompanyPeople } from "@/features/contact-companies/queries";
import { ContactDomainNote } from "@/features/company-domain/components/contact-domain-note";
import { getContactDomainInfo } from "@/features/company-domain/queries";
import { ChildCompaniesCard } from "@/features/companies/components/child-companies-card";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { RelatedDealsCard } from "@/features/deals/components/related-deals-card";
import { RecordQuotesCard } from "@/features/quotes/components/record-quotes-card";
import { RecordOrdersCard } from "@/features/orders/components/record-orders-card";
import { CompanyCreditCard } from "@/features/allocations/components/company-credit-card";
import { CompanyOpeningCard } from "@/features/documents/components/company-opening-card";
import { CustomerHoldCard } from "@/features/customer-holds/components/customer-hold-card";
import { LedgerCard } from "@/features/balances/components/ledger-card";
import { listRelatedDeals } from "@/features/deals/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDate, formatDateTime, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";
import { RecordFiles } from "@/features/files/components/record-files";
import { DuplicatesCard } from "@/features/merge/components/duplicates-card";
import { isAdminRole } from "@/features/settings/permissions";
import { editFocusParam } from "@/features/data-quality/completeness";
import { CompletenessCard } from "@/features/data-quality/components/completeness-card";
import { BillingCard } from "@/features/billing/components/billing-card";
import { getRecordBilling } from "@/features/billing/queries";

export const metadata: Metadata = { title: "חברה" };

type Props = {
  params: Promise<{ orgId: string; companyId: string }>;
  // REC-06: tl = the timeline filter
  // BAL-01: lf, lt = the ledger's period
  searchParams: Promise<{ tl?: string | string[]; edit?: string | string[]; lf?: string | string[]; lt?: string | string[] }>;
};

export default async function CompanyPage({ params, searchParams }: Props) {
  const [{ orgId, companyId }, { tl, edit, lf, lt }] = await Promise.all([params, searchParams]);
  // DQL-01: open the details for editing at this input
  const focus = editFocusParam(edit);
  const context = await getOrgContext(orgId);
  if (!isUuid(companyId)) {
    notFound();
  }

  const [company, contacts, deals, fieldDefs, tags, types, follow, billing, cardLayout] = await Promise.all([
    getCompany(orgId, companyId),
    // CON-05: the people linked to the company, with their role there
    listCompanyPeople(orgId, companyId),
    listRelatedDeals(orgId, { companyId }),
    listFieldDefinitions(orgId, "company"),
    listTags(orgId),
    listRecordTypes(orgId, "company"),
    getFollowState(orgId, { kind: "company", id: companyId }, context.user.id),
    // CON-08
    getRecordBilling(orgId, "company", companyId),
    // FLD-08: the business's card layout (null = the default)
    getCardLayout(orgId, "company"),
  ]);
  if (!company) {
    notFound();
  }
  // FLD-06 part B: the names of the record links and files this record holds, as this viewer may read them
  const fields = await withFieldRefs(orgId, fieldDefs, [company.custom_fields]);
  // CON-07: the parent and the child companies the user may read
  // CON-09: the domain the company gets from its contacts' emails, when it has none of its own
  const [family, contactDomain] = await Promise.all([
    getCompanyFamily(orgId, company.id, company.parent_company_id),
    getContactDomainInfo(orgId, company),
  ]);

  return (
    <>
      {/* GAP-11: the card on paper (business name, printed at; the screen tools are left out) */}
      <PrintHeader orgName={context.org.name} timeZone={context.org.timeZone} />
      <PageHeader
        title={company.name}
        back={{ href: paths.companies(orgId), label: "חברות" }}
        actions={
          <>
            <PrintButton />
            <FollowButton orgId={orgId} subject={{ kind: "company", id: company.id }} state={follow} />
            {context.canWrite ? <ManualAutomationsButton orgId={orgId} entity="company" recordId={company.id} /> : null}
          </>
        }
      />
      <div className="mb-5 print:hidden">
        <ContactActions
          phone={company.phone}
          phoneE164={company.phone_e164}
          email={company.email}
          // TASK-02: dialling offers to log the call, as on the lead and contact pages
          callLog={context.canWrite ? { orgId, subject: { kind: "company", id: company.id }, name: company.name } : undefined}
          // a company has no first name: {שם פרטי} stays for the person to complete
          whatsappLog={
            context.canWrite
              ? { orgId, subject: { kind: "company", id: company.id }, name: company.name, values: { ...recordTemplateValues({ fullName: company.name }, context), firstName: null } }
              : undefined
          }
        />
        {context.canWrite ? <QuickNote orgId={orgId} subject={{ kind: "company", id: company.id }} className="mt-4 lg:hidden" /> : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} filter={tl} />
          {/* GAP-11: the files list prints (names, dates, uploaders); the card hides itself on paper when empty */}
          <RecordFiles orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <div className="space-y-5 print:hidden empty:hidden">
            <DuplicatesCard orgId={orgId} type="company" id={company.id} canMerge={context.canDelete} />
            <RecordHistory orgId={orgId} entityType="companies" entityId={company.id} />
          </div>
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordSummaryCard orgId={orgId} type="company" id={company.id} currency={context.org.currency} timeZone={context.org.timeZone} />
          <RecordTasks orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} />
          <RecordMeetings orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} timeZone={context.org.timeZone} userId={context.user.id} />
          <div className="print:hidden empty:hidden">
            <CompletenessCard orgId={orgId} type="company" id={company.id} editBase={canEditRecordHint(context, company.owner_id) ? paths.company(orgId, company.id) : null} />
          </div>
          <CompanyDetailsCard
            layout={cardLayout}
            key={focus ?? "view"}
            focus={focus}
            orgId={orgId}
            canEdit={canEditRecordHint(context, company.owner_id)}
            types={types}
            company={{
              ...company,
              // GAP-12: an imported record shows its original creation day first
              createdAtText: createdLineText(formatDateTime(company.created_at), company.original_created_on ? formatDate(company.original_created_on) : null),
              parent: family.parent,
              custom: { definitions: fields, values: asCustomValues(company.custom_fields), builtins: { "builtin:type": company.type_id } },
            }}
          />
          {contactDomain ? (
            <ContactDomainNote
              orgId={orgId}
              companyId={company.id}
              domain={contactDomain.domain}
              off={contactDomain.off}
              canEdit={canEditRecordHint(context, company.owner_id)}
            />
          ) : null}

          {billing ? (
            <BillingCard
              orgId={orgId}
              recordId={company.id}
              billing={billing}
              canEdit={canEditRecordHint(context, company.owner_id)}
              today={zoneDate(new Date(), context.org.timeZone)}
              companyIsIsraeli={company.country === "IL"}
            />
          ) : null}

          <TagPicker
            orgId={orgId}
            kind="company"
            recordId={company.id}
            allTags={tags}
            selectedIds={company.tag_ids}
            canEdit={canEditRecordHint(context, company.owner_id)}
          />

          <CompanyPeopleCard orgId={orgId} people={contacts} />

          <ChildCompaniesCard orgId={orgId} items={family.children} total={family.childCount} />

          <RelatedDealsCard
            orgId={orgId}
            deals={deals}
            newDealQuery={context.canWrite ? `?company=${company.id}` : null}
            emptyText="עוד אין עסקאות עם החברה הזו."
          />
          {/* QUO-16: the quotes that name the company (made from its deals and people) */}
          <RecordQuotesCard orgId={orgId} subject={{ kind: "company", id: company.id }} canCreate={false} />
          {/* ORD-01: the company's orders while the orders module is on */}
          <RecordOrdersCard orgId={orgId} subject={{ kind: "company", id: company.id }} canCreate={canEditRecordHint(context, company.owner_id)} />
          {/* COL-05: "לא למכור עד הסדרת חוב" */}
          <CustomerHoldCard orgId={orgId} subject={{ kind: "company", id: company.id }} />
          {/* PAY-03: the company's credit balance */}
          <CompanyCreditCard orgId={orgId} companyId={company.id} />
          {/* GAP-12: the company's opening balance */}
          <CompanyOpeningCard orgId={orgId} companyId={company.id} />
          {/* BAL-01: the company's ledger (its contacts' and deals' documents and payments) */}
          <LedgerCard
            orgId={orgId}
            where={{ contact: null, company: company.id }}
            from={(Array.isArray(lf) ? lf[0] : lf)}
            to={(Array.isArray(lt) ? lt[0] : lt)}
            keep={{ tl: (Array.isArray(tl) ? tl[0] : tl) }}
          />

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 border-t border-line pt-5 empty:hidden print:hidden">
        {context.canDelete ? (
          <TrashRecordButton noun="החברה" action={trashCompanyAction.bind(null, orgId, company.id)} />
        ) : null}
      </div>
    </>
  );
}
