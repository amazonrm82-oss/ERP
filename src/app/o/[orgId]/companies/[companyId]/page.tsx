import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { TrashRecordButton } from "@/components/trash-record-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { trashCompanyAction } from "@/features/companies/actions";
import { CompanyDetailsCard } from "@/features/companies/components/company-details-card";
import { getCompany, listContactsOfCompany } from "@/features/companies/queries";
import { RelatedDealsCard } from "@/features/deals/components/related-deals-card";
import { listRelatedDeals } from "@/features/deals/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { formatDateTime } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "חברה" };

type Props = { params: Promise<{ orgId: string; companyId: string }> };

export default async function CompanyPage({ params }: Props) {
  const { orgId, companyId } = await params;
  const context = await getOrgContext(orgId);
  if (!isUuid(companyId)) {
    notFound();
  }

  const [company, contacts, deals] = await Promise.all([
    getCompany(orgId, companyId),
    listContactsOfCompany(orgId, companyId),
    listRelatedDeals(orgId, { companyId }),
  ]);
  if (!company) {
    notFound();
  }

  return (
    <>
      <PageHeader title={company.name} back={{ href: paths.companies(orgId), label: "חברות" }} />
      <div className="mb-5">
        <ContactActions phone={company.phone} phoneE164={company.phone_e164} email={company.email} />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "company", id: company.id }} canWrite={context.canWrite} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <CompanyDetailsCard
            orgId={orgId}
            canEdit={canEditRecordHint(context, company.owner_id)}
            company={{ ...company, createdAtText: formatDateTime(company.created_at) }}
          />

          <Card aria-labelledby="company-contacts-title">
            <CardHeader id="company-contacts-title" title={`אנשי קשר (${contacts.length})`} />
            <CardBody>
              {contacts.length === 0 ? (
                <p className="text-[0.9375rem] text-ink-soft">עוד אין אנשי קשר בחברה. משייכים איש קשר לחברה בכרטיס שלו.</p>
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

          {context.canDelete ? (
            <TrashRecordButton noun="החברה" action={trashCompanyAction.bind(null, orgId, company.id)} />
          ) : null}
        </div>
      </div>
    </>
  );
}
