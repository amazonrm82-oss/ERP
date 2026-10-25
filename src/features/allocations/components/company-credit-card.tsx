import { Card, CardBody, CardHeader } from "@/components/ui/card";

import { creditLine } from "../credit";
import { getAllocationAccess, getCustomerCredit } from "../queries";

/**
 * PAY-03: a company's credit balance: the parts of its contacts' and deals' recorded or confirmed payments not allocated to a
 * document yet (PAY-02's "same customer"). Shown while the plan has both money keys and there is credit the user may see.
 */
export async function CompanyCreditCard({ orgId, companyId }: { orgId: string; companyId: string }) {
  const access = await getAllocationAccess(orgId);
  if (!access.inPlan) return null;
  const text = creditLine(await getCustomerCredit(orgId, { deal: null, contact: null, company: companyId }));
  if (!text) return null;
  const titleId = `company-credit-${companyId}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader id={titleId} title="יתרת זכות" />
      <CardBody>
        <p className="text-sm">{text}</p>
        <p className="mt-1 text-sm text-ink-soft">היתרה מקוזזת כשרושמים חשבונית מס או חשבון עסקה לאיש קשר או לעסקה של החברה.</p>
      </CardBody>
    </Card>
  );
}
