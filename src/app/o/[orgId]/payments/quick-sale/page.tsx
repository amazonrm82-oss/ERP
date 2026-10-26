import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getDocumentsAccess } from "@/features/documents/queries";
import { paymentsPath } from "@/features/payments/paths";
import { getPaymentsAccess } from "@/features/payments/queries";
import { QuickSaleForm } from "@/features/quick-sale/components/quick-sale-form";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { zoneDate } from "@/lib/format";

export const metadata: Metadata = { title: "מכירה מהירה" };

type Props = { params: Promise<{ orgId: string }> };

/**
 * GAP-08: a sale at the counter without a quote or an order: customer, items, payment method, done. It records a won deal
 * with the items, the payment and, optionally, a document issued elsewhere (work mode 6.2 (א): nothing is issued here).
 * Open to whoever records payments while the plan holds payments and products; recording the document also needs the
 * documents key and the right to record documents.
 */
export default async function QuickSalePage({ params }: Props) {
  const { orgId } = await params;
  const [context, payments, documents, products, terms] = await Promise.all([
    getOrgContext(orgId),
    getPaymentsAccess(orgId),
    getDocumentsAccess(orgId),
    orgHasFeature(orgId, "products"),
    getOrgTerms(orgId),
  ]);
  const back = { href: paymentsPath(orgId), label: "לכל התשלומים" };
  const blocked = !payments.inPlan || !products
    ? "מכירה מהירה דורשת רישום תשלומים וקטלוג מוצרים בחבילה של העסק."
    : !payments.canRecord
      ? "מכירה מהירה פתוחה למי שרושם תשלומים: בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים."
      : null;
  return (
    <>
      <PageHeader title="מכירה מהירה" description="מכירה בדלפק, בלי הצעה ובלי הזמנה: לקוח, פריטים, אמצעי תשלום, סיום." back={back} />
      {blocked ? (
        <Card>
          <CardBody>
            <p>{blocked}</p>
          </CardBody>
        </Card>
      ) : (
        <div className="max-w-2xl">
          <QuickSaleForm
            orgId={orgId}
            today={zoneDate(new Date(), context.org.timeZone)}
            customerLabel={terms.contact.singular}
            dealCardLabel={`לכרטיס ${terms.deal.theSingular}`}
            contactCardLabel={`לכרטיס ${terms.contact.theSingular}`}
            canDocument={documents.canRecord}
          />
        </div>
      )}
    </>
  );
}
