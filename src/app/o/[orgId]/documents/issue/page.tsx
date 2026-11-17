import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { IssueForm } from "@/features/invoicing/components/issue-form";
import { customerProblemsText, isIssueSourceKind } from "@/features/invoicing/issue";
import { getInvoicingAccess, getInvoicingSettings } from "@/features/invoicing/queries";
import { getIssueSource } from "@/features/invoicing/source-server";
import { getOrgContext } from "@/features/shell/queries";
import { documentVatRateBp } from "@/features/tax/calc";
import { getTaxSettings, getVatRates } from "@/features/tax/queries";
import { documentVat } from "@/features/tax/rates";
import { chargesVat } from "@/features/tax/status";
import { zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "הפקת מסמך" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * DOC-07: issuing a tax invoice, a tax invoice-receipt, a receipt or a proforma through the business's invoice provider, from
 * a deal, a contact, an accepted quote or a numbered order. Hidden (not found) unless this deployment offers a provider, the
 * business is connected and the person may issue (DOC-17).
 */
export default async function IssueDocumentPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const kind = query.from;
  const id = query.id;
  if (!isIssueSourceKind(kind) || typeof id !== "string" || !isUuid(id)) notFound();
  const access = await getInvoicingAccess(orgId);
  if (!access.canIssue) notFound();
  const [source, settings, context, tax, rates] = await Promise.all([
    getIssueSource(orgId, kind, id),
    getInvoicingSettings(orgId),
    getOrgContext(orgId),
    getTaxSettings(orgId),
    getVatRates(),
  ]);
  if (!source) notFound();
  const today = zoneDate(new Date(), context.org.timeZone);
  const charges = chargesVat(tax.vatStatus, tax.otherChargesVat);
  const rateBp = documentVatRateBp(documentVat(charges, rates, today));
  const problems = customerProblemsText(source.customer.problems);
  return (
    <div className="space-y-5">
      <PageHeader title="הפקת מסמך" description={source.title} back={{ href: source.backHref, label: "חזרה" }} />
      <Card aria-labelledby="issue-customer">
        <CardHeader id="issue-customer" title="הלקוח במסמך" />
        <CardBody className="space-y-2 text-sm">
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="font-medium">שם</dt>
            <dd className="break-words">{source.customer.name ?? "חסר"}</dd>
            <dt className="font-medium">מספר עוסק / ח.פ.</dt>
            <dd dir="ltr" className="text-start">{source.customer.taxId ?? "—"}</dd>
            <dt className="font-medium">כתובת</dt>
            <dd className="break-words">{source.customer.address ?? "—"}</dd>
            <dt className="font-medium">אימייל</dt>
            <dd dir="ltr" className="text-start break-all">{source.customer.email ?? "—"}</dd>
          </dl>
          {problems.length > 0 ? (
            <div role="alert" className="space-y-1 rounded-md bg-danger-soft px-3 py-2.5 text-danger">
              <p className="font-medium">אי אפשר להפיק עד שמשלימים:</p>
              <ul className="list-disc ps-5">
                {problems.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {settings.sendEmail ? <p className="text-ink-soft">הספק ישלח את המסמך ללקוח באימייל{source.customer.email ? "" : " (ללקוח אין אימייל, לכן לא יישלח)"}.</p> : null}
        </CardBody>
      </Card>
      <Card aria-labelledby="issue-document">
        <CardHeader id="issue-document" title="המסמך" />
        <CardBody>
          <IssueForm
            orgId={orgId}
            source={{ kind, id }}
            idempotencyKey={randomUUID()}
            initialLines={source.lines}
            defaultType={settings.defaultDocType}
            today={today}
            timeZone={context.org.timeZone}
            rateBp={rateBp}
            pricesIncludeVat={source.pricesIncludeVat}
            blocked={problems.length > 0}
            chargesVat={charges}
          />
        </CardBody>
      </Card>
    </div>
  );
}
