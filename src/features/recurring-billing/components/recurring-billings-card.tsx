import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextLink } from "@/components/ui/text-link";
import { zoneDate } from "@/lib/format";

import { recurringBillingPath } from "../paths";
import { getRecurringAccess, listBillings } from "../queries";
import { BILLING_STATUS_LABELS, BILLING_STATUS_TONE } from "../schema";
import { billingAmountText, nextCycleText } from "../texts";
import { NewBillingButton } from "./billing-forms";

/**
 * SUB-01: the customer's recurring billings on a contact's or company's card. Shown to whoever reads the customer while
 * the plan has the key, or while the customer has a billing (one made before a downgrade keeps showing). Whoever records
 * payments makes a new one.
 */
export async function RecurringBillingsCard({
  orgId,
  customer,
  timeZone,
}: {
  orgId: string;
  customer: { kind: "contact" | "company"; id: string };
  timeZone: string;
}) {
  const access = await getRecurringAccess(orgId);
  const billings = await listBillings(orgId, customer.kind === "contact" ? { contactId: customer.id } : { companyId: customer.id });
  if (!access.inPlan && billings.length === 0) return null;
  const titleId = `recurring-billings-${customer.id}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title={billings.length > 0 ? `חיובים חוזרים (${billings.length})` : "חיובים חוזרים"}
        action={access.canManage ? <NewBillingButton orgId={orgId} customer={customer} today={zoneDate(new Date(), timeZone)} /> : null}
      />
      <CardBody>
        {billings.length === 0 ? (
          <p className="text-sm text-ink-soft">אין חיובים חוזרים ללקוח.</p>
        ) : (
          <ul className="divide-y divide-line">
            {billings.map((billing) => (
              <li key={billing.id} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <span className="min-w-0 space-y-1">
                  <TextLink href={recurringBillingPath(orgId, billing.id)} className="block font-medium break-words">
                    {billing.name}
                  </TextLink>
                  <span className="block text-sm text-ink-soft">{billingAmountText(billing.amountAgorot, billing.cycle)}</span>
                  <span className="block text-sm text-ink-soft">{nextCycleText(billing.status, billing.nextCycleOn, billing.endDate)}</span>
                </span>
                <Badge tone={BILLING_STATUS_TONE[billing.status]}>{BILLING_STATUS_LABELS[billing.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
