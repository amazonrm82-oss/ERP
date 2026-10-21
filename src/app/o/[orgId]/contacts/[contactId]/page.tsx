import { getOrgTerms } from "@/features/terminology/queries";
import { byGender } from "@/features/terminology/terms";
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
import { PrintButton } from "@/features/print/components/print-button";
import { PersonExportLink } from "@/features/privacy-export/components/person-export-link";
import { PersonEraseButton } from "@/features/privacy-erase/components/person-erase-button";
import { PrintHeader } from "@/features/print/components/print-header";
import { Timeline } from "@/features/activities/components/timeline";
import { RecordTasks } from "@/features/tasks/components/record-tasks";
import { RecordMeetings } from "@/features/meetings/components/record-meetings";
import { RecordSummaryCard } from "@/features/record-summary/components/record-summary-card";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { listCompanyOptions } from "@/features/companies/queries";
import { getOrgModules } from "@/features/modules/queries";
import { ContactCompaniesCard } from "@/features/contact-companies/components/contact-companies-card";
import { listContactCompanies } from "@/features/contact-companies/queries";
import { ContactRelationsCard } from "@/features/contact-relations/components/contact-relations-card";
import { listContactRelations, listRelationTypes } from "@/features/contact-relations/queries";
import { relationChoices } from "@/features/contact-relations/types";
import { trashContactAction } from "@/features/contacts/actions";
import { getCardLayout } from "@/features/card-layout/queries";
import { ContactDetailsCard } from "@/features/contacts/components/contact-details-card";
import { contactDisplayName } from "@/features/contacts/display";
import { preferredContactChannel } from "@/features/contacts/preferences";
import { getContact } from "@/features/contacts/queries";
import { DomainLinkNote } from "@/features/company-domain/components/domain-link-note";
import { getDomainLinkInfo } from "@/features/company-domain/queries";
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
import { RecordQuotesCard } from "@/features/quotes/components/record-quotes-card";
import { RecordOrdersCard } from "@/features/orders/components/record-orders-card";
import { RecordDocumentsCard } from "@/features/documents/components/record-documents-card";
import { RecordPaymentsCard } from "@/features/payments/components/record-payments-card";
import { CustomerHoldCard } from "@/features/customer-holds/components/customer-hold-card";
import { orgHasFeature } from "@/features/settings/queries";

// FLD-10: the tab title in the business's word
export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const { orgId } = await params;
  return { title: (await getOrgTerms(orgId)).contact.singular };
}

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

  const [contact, mainDeals, dealRoles, fields, follow, billing, cardLayout, terms] = await Promise.all([
    getContact(orgId, contactId),
    listRelatedDeals(orgId, { contactId }),
    listContactDealRoles(orgId, contactId),
    listFieldDefinitions(orgId, "contact"),
    getFollowState(orgId, { kind: "contact", id: contactId }, context.user.id),
    // CON-08
    getRecordBilling(orgId, "contact", contactId),
    // FLD-08: the business's card layout (null = the default)
    getCardLayout(orgId, "contact"),
    // FLD-10: the business's words for contacts and deals
    getOrgTerms(orgId),
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
  // LEAD-08: with companies switched off, the company field, the companies card and the domain note are left out
  const modules = await getOrgModules(orgId);
  const [companyOptions, types, domainLink, companyLinks, relationTypes, hasQuotes] = await Promise.all([
    canEdit && modules.companies ? listCompanyOptions(orgId) : [],
    canEdit ? listRecordTypes(orgId, "contact") : [],
    // CON-09: a company linked by the email domain, or the companies to pick from
    modules.companies ? getDomainLinkInfo(orgId, contact) : null,
    // CON-05: every company of the contact, with the role there
    modules.companies ? listContactCompanies(orgId, contact.id) : [],
    // CON-06: the business's relation types (the other person is searched in the form)
    listRelationTypes(orgId),
    // QUO-01
    orgHasFeature(orgId, "quotes"),
  ]);
  const companies = modules.companies ? companyOptions : null;
  const relations = await listContactRelations(orgId, contact.id, relationTypes);
  const name = contactDisplayName({ fullName: contact.full_name, email: contact.email, phone: contact.phone });

  return (
    <>
      {/* GAP-11: the card on paper (business name, printed at; the screen tools are left out) */}
      <PrintHeader orgName={context.org.name} timeZone={context.org.timeZone} />
      <PageHeader
        title={name}
        description={[contact.job_title, contact.companyName].filter(Boolean).join(", ") || undefined}
        back={{ href: paths.contacts(orgId), label: terms.contact.plural }}
        actions={
          <>
            <PrintButton />
            <FollowButton orgId={orgId} subject={{ kind: "contact", id: contact.id }} state={follow} />
          </>
        }
      />
      {channels === "failed" ? (
        <FormError
          className="mb-4"
          message={`${terms.contact.theSingular} ${byGender(terms.contact, "נוצר", "נוצרה")}, אבל לא כל הטלפונים והאימיילים הנוספים נשמרו. אפשר להוסיף אותם בעריכה.`}
        />
      ) : null}
      {domainLink ? (
        <div className="mb-4 print:hidden">
          <DomainLinkNote orgId={orgId} contactId={contact.id} info={domainLink} canEdit={canEdit} />
        </div>
      ) : null}
      <div className="mb-5 print:hidden">
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
          preferred={preferredContactChannel(contact.preferred_channel)}
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
          {/* GAP-11: the files list prints (names, dates, uploaders); the card hides itself on paper when empty */}
          <RecordFiles orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} userId={context.user.id} isAdmin={isAdminRole(context.role)} />
          <div className="space-y-5 print:hidden empty:hidden">
            <DuplicatesCard orgId={orgId} type="contact" id={contact.id} canMerge={context.canDelete} />
            <RecordHistory orgId={orgId} entityType="contacts" entityId={contact.id} />
          </div>
        </div>

        <div className="order-1 space-y-5 lg:order-2">

          <RecordSummaryCard orgId={orgId} type="contact" id={contact.id} currency={context.org.currency} timeZone={context.org.timeZone} />
          <RecordTasks orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} />
          <RecordMeetings orgId={orgId} subject={{ kind: "contact", id: contact.id }} canWrite={context.canWrite} timeZone={context.org.timeZone} userId={context.user.id} />
          <div className="print:hidden empty:hidden">
            <CompletenessCard orgId={orgId} type="contact" id={contact.id} editBase={canEdit ? paths.contact(orgId, contact.id) : null} />
          </div>
          <ContactDetailsCard
            layout={cardLayout}
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
              custom: { definitions: fields, values: asCustomValues(contact.custom_fields), builtins: { "builtin:type": contact.type_id } },
            }}
            terms={terms}
          />

          {companies ? <ContactCompaniesCard orgId={orgId} contactId={contact.id} canEdit={canEdit} items={companyLinks} options={companies} /> : null}

          <ContactRelationsCard
            orgId={orgId}
            contactId={contact.id}
            canEdit={canEdit}
            items={relations}
            choices={relationChoices(relationTypes)}
          />

          {billing ? <BillingCard orgId={orgId} recordId={contact.id} billing={billing} canEdit={canEdit} today={zoneDate(new Date(), context.org.timeZone)} /> : null}

          <TagPicker orgId={orgId} kind="contact" recordId={contact.id} allTags={tags} selectedIds={contact.tag_ids} canEdit={canEdit} />

          <div className="print:hidden">
            <RecordConsents
              orgId={orgId}
              subject={{ kind: "contact", id: contact.id }}
              canEdit={canEdit}
              hasPhone={Boolean(contact.phone_e164)}
              hasEmail={Boolean(contact.email?.trim())}
              canLift={isAdminRole(context.role)}
            />
          </div>

          {/* QUO-01: the contact's quotes, and a new one for whoever may edit the contact */}
          <RecordQuotesCard orgId={orgId} subject={{ kind: "contact", id: contact.id }} canCreate={hasQuotes && canEdit} />
          {/* ORD-01: the contact's orders while the orders module is on */}
          <RecordOrdersCard orgId={orgId} subject={{ kind: "contact", id: contact.id }} canCreate={canEdit} />
          {/* DOC-01: documents issued outside the system and recorded here */}
          <RecordDocumentsCard orgId={orgId} subject={{ kind: "contact", id: contact.id }} />
          {/* PAY-01: payments received and recorded here */}
          <RecordPaymentsCard orgId={orgId} subject={{ kind: "contact", id: contact.id }} />
          {/* COL-05: "לא למכור עד הסדרת חוב" */}
          <CustomerHoldCard orgId={orgId} subject={{ kind: "contact", id: contact.id }} />

          <RelatedDealsCard
            orgId={orgId}
            deals={deals}
            newDealQuery={context.canWrite ? `?contact=${contact.id}` : null}
            emptyText={`עוד אין ${terms.deal.plural} עם ${terms.contact.theSingular} ${byGender(terms.contact, "הזה", "הזאת")}.`}
            terms={terms}
          />

        </div>
      </div>
      {/* FXU-03: out of the way of the daily work, at the very end */}
      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-5 empty:hidden print:hidden">
        {context.canDelete ? (
          <TrashRecordButton noun={terms.contact.theSingular} action={trashContactAction.bind(null, orgId, contact.id)} />
        ) : null}
        {/* PRV-02 */}
        {isAdminRole(context.role) ? (
          <>
            <PersonExportLink orgId={orgId} kind="contact" id={contact.id} />
            {/* PRV-03 */}
            {context.canWrite ? <PersonEraseButton orgId={orgId} kind="contact" id={contact.id} listHref={paths.contacts(orgId)} /> : null}
          </>
        ) : null}
      </div>
    </>
  );
}
