import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CreditOffsetRows } from "@/features/allocations/components/credit-offset-rows";
import { getAllocationAccess, getMoneyState, listCreditOffsets } from "@/features/allocations/queries";
import { documentStateChip } from "@/features/allocations/state";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate, formatMoney, zoneDate } from "@/lib/format";

import { getDocumentsAccess, listCompanyOpeningBalances } from "../queries";
import { documentTitle } from "../schema";
import { CancelCompanyOpeningButton, CompanyOpeningButton } from "./company-opening-forms";

/**
 * GAP-12 (owner, 26 October 2026, answers (1) א, (3) ב): a company's opening balance from the previous system. One is active
 * at a time; recording a new one replaces it. Owners and admins record, replace and cancel it; whoever reads the company
 * sees it. Shown while the plan has the `documents` key, and only when there is one or the user may record one.
 */
export async function CompanyOpeningCard({ orgId, companyId }: { orgId: string; companyId: string }) {
  const access = await getDocumentsAccess(orgId);
  if (!access.inPlan) return null;
  const [{ documents, names }, context, allocation] = await Promise.all([
    listCompanyOpeningBalances(orgId, companyId),
    getOrgContext(orgId),
    getAllocationAccess(orgId),
  ]);
  if (documents.length === 0 && !access.canOpening) return null;
  const ids = documents.map((d) => d.id);
  const [money, offsets] = allocation.inPlan ? await Promise.all([getMoneyState(orgId, ids, []), listCreditOffsets(orgId, ids)]) : [null, []];
  const today = zoneDate(new Date(), context.org.timeZone);
  const active = documents.some((d) => !d.cancelled);
  const titleId = `opening-${companyId}`;
  return (
    <Card aria-labelledby={titleId} className="print:hidden">
      <CardHeader
        id={titleId}
        title="יתרת פתיחה"
        action={access.canOpening ? <CompanyOpeningButton orgId={orgId} companyId={companyId} today={today} replaces={active} /> : null}
      />
      <CardBody className="p-0">
        {documents.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-soft">אין יתרת פתיחה. כאן רושמים את יתרת החברה מהמערכת הקודמת: חוב, או זכות במינוס.</p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((doc) => {
              const label = documentTitle(doc);
              const state = money?.documents.get(doc.id);
              const chip = state ? documentStateChip(state) : null;
              const overdue = !doc.cancelled && doc.dueDate !== null && doc.dueDate < today && state !== undefined && state.balance > 0;
              return (
                <li key={doc.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">
                      {label}
                      {doc.cancelled ? (
                        <>
                          {" "}
                          <Badge tone="warning">בוטל</Badge>
                        </>
                      ) : chip ? (
                        <>
                          {" "}
                          <Badge tone={chip.tone}>{chip.label}</Badge>
                        </>
                      ) : null}
                      {overdue ? (
                        <>
                          {" "}
                          <Badge tone="danger">באיחור</Badge>
                        </>
                      ) : null}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {doc.amountAgorot < 0 ? "זכות של הלקוח" : "חוב של הלקוח"}
                      {doc.amountAgorot < 0 && !doc.cancelled && state ? ` · נותרו לקיזוז ${formatMoney(state.credit ?? 0)}` : ""}
                      {doc.dueDate ? ` · לתשלום עד ${formatDate(`${doc.dueDate}T12:00:00Z`)}` : ""}
                      {doc.createdBy && names.get(doc.createdBy) ? ` · נרשם על ידי ${names.get(doc.createdBy)}` : ""}
                    </p>
                    <CreditOffsetRows documentId={doc.id} offsets={offsets} />
                    {doc.cancelled ? (
                      <p className="text-sm break-words text-ink-soft">
                        בוטל{doc.cancelledAt ? ` ב-${formatDate(doc.cancelledAt)}` : ""}
                        {doc.cancelReason ? (
                          <>
                            : <bdi>{doc.cancelReason}</bdi>
                          </>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <span className="flex shrink-0 flex-wrap items-center gap-1">
                    <span className={`font-medium whitespace-nowrap tabular-nums ${doc.cancelled ? "text-ink-soft line-through" : ""}`}>
                      <bdi dir="ltr">{formatMoney(doc.amountAgorot)}</bdi>
                    </span>
                    {access.canOpening && !doc.cancelled ? <CancelCompanyOpeningButton orgId={orgId} companyId={companyId} documentId={doc.id} label={label} /> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
