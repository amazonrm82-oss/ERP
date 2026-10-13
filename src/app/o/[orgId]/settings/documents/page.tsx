import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { getOrgBranding } from "@/features/branding/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { BankDetailsForm } from "@/features/tax/components/bank-details-form";
import { DocumentDetailsForm } from "@/features/tax/components/document-details-form";
import { TaxStatusForm } from "@/features/tax/components/tax-status-form";
import { VatRatesCard } from "@/features/tax/components/vat-rates-card";
import { getBankDetails, getDocumentDetails, getTaxSettings, getVatRates } from "@/features/tax/queries";
import { bankTransferText, documentAddress } from "@/features/tax/settings";
import { chargesVat, LEGAL_FORM_OPTIONS, vatStatusLabel } from "@/features/tax/status";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: 'מע"מ ופרטים למסמכים' };

type Props = { params: Promise<{ orgId: string }> };

function chargesText(value: boolean | null): string {
  if (value === null) return "עוד לא נקבע";
  return value ? "כן" : "לא";
}

// TAX-01: the business's VAT status, apart from its legal form.
// TAX-02: the business details printed on quotes and payment requests.
// Bank details: owners and admins only (owner, 13 October 2026); others get one line.
// TAX-03: the VAT rate of today and its history (read only; the platform sets it).
export default async function DocumentSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite, org } = await getOrgContext(orgId);
  const [tax, details, branding, rates] = await Promise.all([getTaxSettings(orgId), getDocumentDetails(orgId), getOrgBranding(orgId), getVatRates()]);
  const ratesCard = <VatRatesCard rates={rates} today={zoneDate(new Date(), org.timeZone)} charges={chargesVat(tax.vatStatus, tax.otherChargesVat)} />;
  const editable = isAdminRole(role) && canWrite;
  // the database gives the bank row to owners and admins only; nobody else is even asked
  const bank = isAdminRole(role) ? await getBankDetails(orgId) : null;

  // the logo on documents is the business logo (FLD-04); it is changed with the branding
  const logoCard = (
    <Card aria-labelledby="doc-logo-title">
      <CardHeader id="doc-logo-title" title="לוגו במסמכים" />
      <CardBody className="space-y-3">
        {branding.logoUrl ? (
          <OrgLogo url={branding.logoUrl} alt={`הלוגו של ${org.name}`} className="h-16 max-w-48" />
        ) : (
          <p className="text-sm text-ink-soft">לעסק אין לוגו. המסמכים יוצגו בלי לוגו.</p>
        )}
        {isAdminRole(role) ? (
          <p className="text-sm">
            הלוגו הוא הלוגו של העסק. <TextLink href={paths.settingsBusiness(orgId)}>החלפת הלוגו בפרטי העסק</TextLink>
          </p>
        ) : null}
      </CardBody>
    </Card>
  );

  if (editable) {
    return (
      <div className="space-y-5">
        <TaxStatusForm orgId={orgId} settings={tax} />
        {ratesCard}
        <DocumentDetailsForm orgId={orgId} details={details} />
        {bank ? <BankDetailsForm orgId={orgId} details={bank} /> : null}
        {logoCard}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card aria-labelledby="tax-status-title">
        <CardHeader id="tax-status-title" title='מעמד במע"מ' />
        <CardBody>
          <DetailList>
            <Detail label="המעמד" value={vatStatusLabel(tax.vatStatus, tax.vatStatusOther)} />
            <Detail label='גובה מע"מ' value={chargesText(chargesVat(tax.vatStatus, tax.otherChargesVat))} />
            <Detail label="צורת ההתאגדות" value={LEGAL_FORM_OPTIONS.find((option) => option.value === tax.legalForm)?.label} />
          </DetailList>
        </CardBody>
      </Card>
      {ratesCard}
      <Card aria-labelledby="doc-details-title">
        <CardHeader id="doc-details-title" title="פרטי העסק במסמכים" />
        <CardBody>
          <DetailList>
            <Detail label="שם רשמי" value={details.legalName} />
            <Detail label="מספר עוסק או ח.פ." value={details.taxId} ltr />
            <Detail label="כתובת" value={documentAddress(details)} />
            <Detail label="טלפון" value={details.phone} ltr />
            <Detail label="אימייל" value={details.email} ltr />
            {bank ? <Detail label="העברה בנקאית" value={bankTransferText(bank)} /> : null}
          </DetailList>
          {bank ? null : <p className="mt-4 text-sm text-ink-soft">פרטי הבנק מוצגים לבעלים ולמנהלי מערכת</p>}
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את הפרטים."}
          </p>
        </CardBody>
      </Card>
      {logoCard}
    </div>
  );
}
