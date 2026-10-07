import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { TrashRecordButton } from "@/components/trash-record-button";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { listCompanyOptions } from "@/features/companies/queries";
import { trashContactAction } from "@/features/contacts/actions";
import { ContactDetailsCard } from "@/features/contacts/components/contact-details-card";
import { contactDisplayName } from "@/features/contacts/display";
import { getContact } from "@/features/contacts/queries";
import { RelatedDealsCard } from "@/features/deals/components/related-deals-card";
import { listRelatedDeals } from "@/features/deals/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { TagPicker } from "@/features/tags/components/tag-picker";
import { listTags } from "@/features/tags/queries";
import { formatDate, formatDateTime } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { RecordHistory } from "@/features/audit/components/record-history";

export const metadata: Metadata = { title: "איש קשר" };

type Props = { params: Promise<{ orgId: string; contactId: string }> };

export default async function ContactPage({ params }: Props) {
  const { orgId, contactId } = await params;
  const context = await getOrgContext(orgId);
  if (!isUuid(contactId)) {
    notFound();
  }

  const [contact, deals, fields] = await Promise.all([
    getContact(orgId, contactId),
    listRelatedDeals(orgId, { contactId }),
    listFieldDefinitions(orgId, "contact"),
  ]);
  const tags = await listTags(orgId);
  if (!contact) {
    notFound();
  }
  const canEdit = canEditRecordHint(context, contact.owner_id);
  const companies = canEdit ? await listCompanyOptions(orgId) : [];
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
          <Timeline orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} />
          <RecordHistory orgId={orgId} entityType="contacts" entityId={contact.id} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">
          <ContactDetailsCard
            orgId={orgId}
            canEdit={canEdit}
            companies={companies}
            contact={{
              ...contact,
              createdAtText: formatDateTime(contact.created_at),
              birthDateText: contact.birth_date ? formatDate(contact.birth_date) : null,
              custom: { definitions: fields, values: asCustomValues(contact.custom_fields) },
            }}
          />

          <TagPicker orgId={orgId} kind="contact" recordId={contact.id} allTags={tags} selectedIds={contact.tag_ids} canEdit={canEdit} />

          <RelatedDealsCard
            orgId={orgId}
            deals={deals}
            newDealQuery={context.canWrite ? `?contact=${contact.id}` : null}
            emptyText="עוד אין עסקאות עם איש הקשר הזה."
          />

          {context.canDelete ? (
            <TrashRecordButton noun="איש הקשר" action={trashContactAction.bind(null, orgId, contact.id)} />
          ) : null}
        </div>
      </div>
    </>
  );
}
