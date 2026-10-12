import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { QuickNote } from "@/features/activities/components/quick-note";
import { TrashRecordButton } from "@/components/trash-record-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { RecordSummaryCard } from "@/features/record-summary/components/record-summary-card";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { trashCompanyAction } from "@/features/companies/actions";
import { CompanyDetailsCard } from "@/features/companies/components/company-details-card";
import { getCompany, listContactsOfCompany } from "@/features/companies/queries";
import { RelatedDealsCard } from "@/features/deals/components/related-deals-card";
import { listRelatedDeals } from "@/features/deals/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDateTime } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";
import { RecordFiles } from "@/features/files/components/record-files";
import { DuplicatesCard } from "@/features/merge/components/duplicates-card";
import { isAdminRole } from "@/features/settings/permissions";

export const metadata: Metadata = { title: "חברה" };

type Props = {
  params: Promise<{ orgId: string; companyId: string }>;
  // REC-06: tl = the timeline filter
  searchParams: Promise<{ tl?: string | string[] }>;
};

export default async function CompanyPage({ params, searchParams }: Props) {
  const [{ orgId, companyId }, { tl }] = await Promise.all([params, searchParams]);
  const context = await getOrgContext(orgId);
  if (!isUuid(companyId)) {
    notFound();
  }

  const [company, contacts, deals, fields, tags] = await Promise.all([
    getCompany(orgId, companyId),
    listContactsOfCompany(orgId, companyId),
    listRelatedDeals(orgId, { companyId }),
    listFieldDefinitions(orgId, "company"),
    listTags(orgId),
  ]);
  if (!company) {
    notFound();
  }

  return (
    <>
      <PageHeader title={company.name} back={{ href: paths.companies(orgId), label: "חברות" }} />
      <div className="mb-5">
        <ContactActions phone={company.phone} phoneE164={company.phone_e164} email={company.email} />
        {context.canWrite ? <QuickNote orgId={orgId} subject={{ kind: "company", id: company.id }} className="mt-4 lg:hidden" /> : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} filter={tl} />
          <RecordFiles orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          {context.canDelete ? <DuplicatesCard orgId={orgId} type="company" id={company.id} /> : null}
          <RecordHistory orgId={orgId} entityType="companies" entityId={company.id} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordSummaryCard orgId={orgId} type="company" id={company.id} currency={context.org.currency} timeZone={context.org.timeZone} />
          <RecordTasks orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} />
          <RecordMeetings orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} timeZone={context.org.timeZone} userId={context.user.id} />
          <CompanyDetailsCard
            orgId={orgId}
            canEdit={canEditRecordHint(context, company.owner_id)}
            company={{
              ...company,
              createdAtText: formatDateTime(company.created_at),
              custom: { definitions: fields, values: asCustomValues(company.custom_fields) },
            }}
          />

          <TagPicker
            orgId={orgId}
            kind="company"
            recordId={company.id}
            allTags={tags}
            selectedIds={company.tag_ids}
            canEdit={canEditRecordHint(context, company.owner_id)}
          />

          <Card aria-labelledby="company-contacts-title">
            <CardHeader id="company-contacts-title" title={`אנשי קשר (${contacts.length})`} />
            <CardBody>
              {contacts.length === 0 ? (
                <p className="text-md text-ink-soft">עוד אין אנשי קשר בחברה. משייכים איש קשר לחברה בכרטיס שלו.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {contacts.map((contact) => (
                    <li key={contact.id} className="py-2.5 first:pt-0 last:pb-0">
                      <Link href={paths.contact(orgId, contact.id)} className="font-medium underline-offset-4 hover:underline">
                        {contact.name}
                      </Link>
                      {contact.jobTitle ? <span className="block text-sm text-ink-soft">{contact.jobTitle}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <RelatedDealsCard
            orgId={orgId}
            deals={deals}
            newDealQuery={context.canWrite ? `?company=${company.id}` : null}
            emptyText="עוד אין עסקאות עם החברה הזו."
          />

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 border-t border-line pt-5 empty:hidden">
        {context.canDelete ? (
          <TrashRecordButton noun="החברה" action={trashCompanyAction.bind(null, orgId, company.id)} />
        ) : null}
      </div>
    </>
  );
}
