import { activeHolds, customerOf, getHoldsAccess } from "../queries";
import { holdWarningText } from "../schema";

/**
 * COL-05: the warning before selling to a held customer (answer 3 (א): a warning only, nothing is refused). Pass the record
 * the quote or order is made from, or the customer's own ids. Never on a customer's page (answer 5).
 */
export async function CustomerHoldWarning({
  orgId,
  subject,
  customer,
}: {
  orgId: string;
  subject?: { kind: "deal" | "contact" | "company"; id: string };
  customer?: { contactId: string | null; companyId: string | null };
}) {
  const access = await getHoldsAccess(orgId);
  if (!access.inPlan) return null;
  const base = customer ?? (subject ? await customerOf(orgId, subject) : null);
  if (!base) return null;
  // a contact's own company counts too (answer 2 (א))
  const who = base.contactId && !base.companyId ? await customerOf(orgId, { kind: "contact", id: base.contactId }) : base;
  const holds = await activeHolds(orgId, who);
  if (holds.length === 0) return null;
  return (
    <div role="status" className="space-y-1 rounded-md bg-warning-soft px-3 py-2.5 text-sm break-words text-warning print:hidden">
      {holds.map((hold) => (
        <p key={hold.id}>{holdWarningText(hold)}</p>
      ))}
    </div>
  );
}
