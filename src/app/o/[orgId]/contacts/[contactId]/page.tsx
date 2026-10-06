import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { Detail, DetailList } from "@/components/detail-list";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { contactDisplayName } from "@/features/contacts/display";
import { getContact } from "@/features/contacts/queries";
import { listDealsOfContact } from "@/features/deals/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDateTime, formatMoney } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";

export const metadata: Metadata = { title: "איש קשר" };

type Props = { params: Promise<{ orgId: string; contactId: string }> };

const DEAL_STATUS = {
  open: { label: "פתוחה", tone: "accent" },
  won: { label: "נסגרה בהצלחה", tone: "success" },
  lost: { label: "אבודה", tone: "neutral" },
} as const;

export default async function ContactPage({ params }: Props) {
  const { orgId, contactId } = await params;
  const { canWrite } = await getOrgContext(orgId);
  if (!isUuid(contactId)) {
    notFound();
  }

  const [contact, deals] = await Promise.all([getContact(orgId, contactId), listDealsOfContact(orgId, contactId)]);
  if (!contact) {
    notFound();
  }

  const name = contactDisplayName({ fullName: contact.full_name, email: contact.email, phone: contact.phone });

  return (
    <>
      <PageHeader
        title={name}
        description={[contact.job_title, contact.companyName].filter(Boolean).join(", ") || undefined}
        back={{ href: paths.contacts(orgId), label: "אנשי קשר" }}
      />
      <div className="mb-5">
        <ContactActions phone={contact.phone} phoneE164={contact.phone_e164} email={contact.email} />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={canWrite} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <Card aria-labelledby="contact-details-title">
            <CardHeader id="contact-details-title" title="פרטי איש הקשר" />
            <CardBody>
              <DetailList>
                <Detail label="שם מלא" value={contact.full_name} />
                <Detail label="טלפון" value={contact.phone} ltr />
                <Detail label="אימייל" value={contact.email} ltr />
                <Detail label="תפקיד" value={contact.job_title} />
                <Detail label="חברה" value={contact.companyName} />
                <Detail label="מקור" value={contact.sourceName} />
                <Detail label="בעלים" value={contact.ownerName} />
                <Detail label="נוצר" value={formatDateTime(contact.created_at)} />
              </DetailList>
            </CardBody>
          </Card>

          <Card aria-labelledby="contact-deals-title">
            <CardHeader
              id="contact-deals-title"
              title="עסקאות"
              action={
                canWrite ? (
                  <ButtonLink href={`${paths.dealNew(orgId)}?contact=${contact.id}`} variant="ghost" size="sm">
                    עסקה חדשה
                  </ButtonLink>
                ) : null
              }
            />
            <CardBody>
              {deals.length === 0 ? (
                <p className="text-[0.9375rem] text-ink-soft">עוד אין עסקאות עם איש הקשר הזה.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {deals.map((deal) => (
                    <li key={deal.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="min-w-0">
                        <span className="block break-words font-medium">{deal.name}</span>
                        <span className="block text-sm text-ink-soft">
                          {formatMoney(deal.amountAgorot)}
                          {deal.stageName ? `, ${deal.stageName}` : ""}
                        </span>
                      </span>
                      <Badge tone={DEAL_STATUS[deal.status].tone}>{DEAL_STATUS[deal.status].label}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
