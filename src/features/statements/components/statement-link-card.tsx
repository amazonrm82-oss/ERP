import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { getDebtSummary, seesBalances } from "@/features/balances/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import type { StatementCustomer } from "../link-actions";
import { STATEMENT_PDF_PARTIAL, staffStatementPdfPath } from "../pdf-server";
import { getStatementLinkStatus } from "../queries";
import { StatementLinkPanel } from "./statement-link-panel";

type Props = {
  orgId: string;
  customer: StatementCustomer;
  // a contact of a company: the statement is the company's (BAL-02's customer)
  company?: { id: string; name: string | null } | null;
  recipient: { name: string | null; phoneE164: string | null; email: string | null };
  // the ledger's period from the page's address (lf, lt), so the PDF covers what the "כספים" card shows
  period?: { from?: string | null; to?: string | null };
};

/**
 * BAL-04: "דף חשבון ללקוח" on the contact and company cards: a secret link the customer opens to see their open debts (the
 * PDF of the ledger is made on each download, never stored). For whoever opens the customer's ledger (BAL-01's rule and keys); the database decides the
 * rest (the partial rule, the customer).
 */
export async function StatementLinkCard({ orgId, customer, company, recipient, period = {} }: Props) {
  if (!(await seesBalances(orgId))) return null;
  const titleId = `statement-${customer.id}`;
  if (customer.kind === "contact" && company) {
    return (
      <Card aria-labelledby={titleId}>
        <CardHeader id={titleId} title="דף חשבון ללקוח" />
        <CardBody>
          <p className="text-sm">
            דף החשבון של איש קשר בחברה הוא של החברה.{" "}
            <Link href={paths.company(orgId, company.id)} className="font-medium text-accent-strong underline-offset-4 hover:underline">
              לכרטיס {company.name ? <bdi>{company.name}</bdi> : "החברה"}
            </Link>
          </p>
        </CardBody>
      </Card>
    );
  }
  const [status, context, debt] = await Promise.all([
    getStatementLinkStatus(orgId, customer),
    getOrgContext(orgId),
    getDebtSummary(orgId, customer.kind === "contact" ? customer.id : null, customer.kind === "company" ? customer.id : null),
  ]);
  if (!status) return null;
  return (
    <Card aria-labelledby={titleId}>
      <CardHeader id={titleId} title="דף חשבון ללקוח" />
      <CardBody>
        <StatementLinkPanel
          orgId={orgId}
          customer={customer}
          active={status.active}
          createdText={status.createdAt ? formatDate(status.createdAt) : ""}
          businessName={context.org.name}
          recipient={recipient}
        />
        {debt.allowed ? (
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            {debt.partial ? (
              <p className="text-sm text-ink-soft" role="note">
                {STATEMENT_PDF_PARTIAL}
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-soft">PDF של דף החשבון לתקופה שמוצגת בכספים, להדפסה או לשליחה ללקוח.</p>
                <a href={staffStatementPdfPath(orgId, customer, period)} className={buttonClasses("secondary", "sm")}>
                  הורדת PDF
                </a>
              </>
            )}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
