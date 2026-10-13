import { RecordConsents } from "@/features/consents/components/record-consents";
import { FollowButton } from "@/features/followers/components/follow-button";
import { getFollowState } from "@/features/followers/queries";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContactActions } from "@/components/contact-actions";
import { recordTemplateValues } from "@/features/whatsapp/templates";
import { ShareSummary } from "@/features/share/components/share-summary";
import { recordSummary } from "@/features/share/summary";
import { QuickNote } from "@/features/activities/components/quick-note";
import { TrashRecordButton } from "@/components/trash-record-button";
import { FormError } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/features/activities/components/timeline";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { RecordSummaryCard } from "@/features/record-summary/components/record-summary-card";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { listCompanyOptions } from "@/features/companies/queries";
import { trashContactAction } from "@/features/contacts/actions";
import { ContactDetailsCard } from "@/features/contacts/components/contact-details-card";
import { contactDisplayName } from "@/features/contacts/display";
import { getContact } from "@/features/contacts/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { contactDealsWithRoles } from "@/features/deal-contacts/contact-deals";
import { listContactDealRoles } from "@/features/deal-contacts/queries";
import { RelatedDealsCard } from "@/features/deals/components/related-deals-card";
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

export const metadata: Metadata = { title: "איש קשר" };

type Props = {
  params: Promise<{ orgId: string; contactId: string }>;
  // REC-06: tl = the timeline filter
  // CON-01: channels=failed after a create whose further phones or emails were not saved
  searchParams: Promise<{ tl?: string | string[]; channels?: string | string[]; edit?: string | string[] }>;
};

export default async function ContactPage({ params, searchParams }: Props) {
  const [{ orgId, contactId }, { tl, channels, edit }] = await Promise.all([params, searchParams]);
  // DQL-01: open the details for editing at this input
  const focus = editFocusParam(edit);
  const context = await getOrgContext(orgId);
  if (!isUuid(contactId)) {
    notFound();
  }

  const [contact, mainDeals, dealRoles, fields, follow, billing] = await Promise.all([
    getContact(orgId, contactId),
    listRelatedDeals(orgId, { contactId }),
    listContactDealRoles(orgId, contactId),
    listFieldDefinitions(orgId, "contact"),
    getFollowState(orgId, { kind: "contact", id: contactId }, context.user.id),
    // CON-08
    getRecordBilling(orgId, "contact", contactId),
  ]);
  const [tags, takingPart] = await Promise.all([
    listTags(orgId),
    listRelatedDeals(orgId, { dealIds: dealRoles.map((entry) => entry.dealId) }),
  ]);
  const deals = contactDealsWithRoles(mainDeals, takingPart, dealRoles);
  if (!contact) {
    notFound();
  }
  const canEdit = canEditRecordHint(context, contact.owner_id);
  const [companies, types] = canEdit ? await Promise.all([listCompanyOptions(orgId), listRecordTypes(orgId, "contact")]) : [[], []];
  const name = contactDisplayName({ fullName: contact.full_name, email: contact.email, phone: contact.phone });

  return (
    <>
      <PageHeader
        title={name}
        description={[contact.job_title, contact.companyName].filter(Boolean).join(", ") || undefined}
        back={{ href: paths.contacts(orgId), label: "אנשי קשר" }}
        actions={<FollowButton orgId={orgId} subject={{ kind: "contact", id: contact.id }} state={follow} />}
      />
      {channels === "failed" ? (
        <FormError className="mb-4" message="איש הקשר נוצר, אבל לא כל הטלפונים והאימיילים הנוספים נשמרו. אפשר להוסיף אותם בעריכה." />
      ) : null}
      <div className="mb-5">
        <ContactActions phone={contact.phone} phoneE164={contact.phone_e164} email={contact.email} saveHref={paths.vcard(orgId, "contact", contact.id)}
          callLog={context.canWrite ? { orgId, subject: { kind: "contact", id: contact.id }, name } : undefined}
          whatsappLog={
            context.canWrite
              ? {
                  orgId,
                  subject: { kind: "contact", id: contact.id },
                  name,
                  values: recordTemplateValues({ firstName: contact.first_name, fullName: contact.full_name }, context),
                }
              : undefined
          }
        />
        <div className="mt-2">
          <ShareSummary
            text={recordSummary(name, [
              ["טלפון", contact.phone],
              ["אימייל", contact.email],
              ["חברה", contact.companyName],
              ["תפקיד", contact.job_title],
            ])}
          />
        </div>
        {context.canWrite ? <QuickNote orgId={orgId} subject={{ kind: "contact", id: contact.id }} className="mt-4 lg:hidden" /> : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* On phones the record's own details come before its history. */}
        <div className="order-2 space-y-5 lg:order-1">
          <Timeline orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} filter={tl} />
          <RecordFiles orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <DuplicatesCard orgId={orgId} type="contact" id={contact.id} canMerge={context.canDelete} />
          <RecordHistory orgId={orgId} entityType="contacts" entityId={contact.id} />
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordSummaryCard orgId={orgId} type="contact" id={contact.id} currency={context.org.currency} timeZone={context.org.timeZone} />
          <RecordTasks orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} />
          <RecordMeetings orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} timeZone={context.org.timeZone} userId={context.user.id} />
          <CompletenessCard orgId={orgId} type="contact" id={contact.id} editBase={canEdit ? paths.contact(orgId, contact.id) : null} />
          <ContactDetailsCard
            key={focus ?? "view"}
            focus={focus}
            orgId={orgId}
            canEdit={canEdit}
            companies={companies}
            types={types}
            contact={{
              ...contact,
              createdAtText: formatDateTime(contact.created_at),
              birthDateText: contact.birth_date ? formatDate(contact.birth_date) : null,
              custom: { definitions: fields, values: asCustomValues(contact.custom_fields) },
            }}
          />

          {billing ? <BillingCard orgId={orgId} recordId={contact.id} billing={billing} canEdit={canEdit} today={zoneDate(new Date(), context.org.timeZone)} /> : null}

          <TagPicker orgId={orgId} kind="contact" recordId={contact.id} allTags={tags} selectedIds={contact.tag_ids} canEdit={canEdit} />

          <RecordConsents
            orgId={orgId}
            subject={{ kind: "contact", id: contact.id }}
            canEdit={canEdit}
            hasPhone={Boolean(contact.phone_e164)}
            hasEmail={Boolean(contact.email?.trim())}
            canLift={isAdminRole(context.role)}
          />

          <RelatedDealsCard
            orgId={orgId}
            deals={deals}
            newDealQuery={context.canWrite ? `?contact=${contact.id}` : null}
            emptyText="עוד אין עסקאות עם איש הקשר הזה."
          />

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 border-t border-line pt-5 empty:hidden">
        {context.canDelete ? (
          <TrashRecordButton noun="איש הקשר" action={trashContactAction.bind(null, orgId, contact.id)} />
        ) : null}
      </div>
    </>
  );
}
