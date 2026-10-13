import type { Metadata } from "next";

import { Detail, DetailList } from "@/components/detail-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { TaxStatusForm } from "@/features/tax/components/tax-status-form";
import { getTaxSettings } from "@/features/tax/queries";
import { chargesVat, LEGAL_FORM_OPTIONS, vatStatusLabel } from "@/features/tax/status";

export const metadata: Metadata = { title: "מע\"מ ופרטים למסמכים" };

type Props = { params: Promise<{ orgId: string }> };

function chargesText(value: boolean | null): string {
  if (value === null) return "עוד לא נקבע";
  return value ? "כן" : "לא";
}

// TAX-01: the business's VAT status, apart from its legal form.
export default async function DocumentSettingsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const tax = await getTaxSettings(orgId);

  if (isAdminRole(role) && canWrite) {
    return (
      <div className="space-y-5">
        <TaxStatusForm orgId={orgId} settings={tax} />
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
          <p className="mt-4 text-sm text-ink-soft">
            {isAdminRole(role) ? "העסק במצב קריאה בלבד, ולכן אי אפשר לשנות כרגע." : "רק בעלים ומנהלי מערכת יכולים לשנות את הפרטים."}
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
