import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";

import {
  getContractRenewalDays,
  listEndingSoonDocuments,
  listRecentlyExpiredDocuments,
  type EndingSoonDocument,
} from "../queries";
import {
  CONTRACT_RENEWAL_DEFAULT,
  contractRenewalLabel,
  EXPIRED_LIST_DAYS,
  validityLine,
} from "../validity";
import { ContractRenewalForm } from "./contract-renewal-form";

type Props = { orgId: string; timeZone: string; editable: boolean };

function recordHref(
  orgId: string,
  kind: "lead" | "contact" | "company" | "deal",
  id: string,
): string {
  if (kind === "lead") return paths.lead(orgId, id);
  if (kind === "contact") return paths.contact(orgId, id);
  if (kind === "company") return paths.company(orgId, id);
  return paths.deal(orgId, id);
}

function DocumentList({
  orgId,
  docs,
  expired = false,
}: {
  orgId: string;
  docs: EndingSoonDocument[];
  expired?: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {docs.map((doc) => (
        <li
          key={doc.id}
          className="flex flex-wrap items-center justify-between gap-2 py-2"
        >
          <span className="min-w-0">
            <span className="block font-medium text-ink">
              <bdi>{doc.title}</bdi>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              <span>{validityLine(doc.validUntil, doc.renewalOn)}</span>
              {expired ? <Badge tone="danger">פג תוקף החוזה</Badge> : null}
            </span>
          </span>
          <Link
            href={recordHref(orgId, doc.kind, doc.recordId)}
            className="text-sm font-medium text-accent-strong underline-offset-4 hover:underline"
          >
            לרשומה
            <span className="sr-only">: {doc.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * SGN-04: "חוזים לחידוש": the alert's lead time (owners and admins) and the signed documents ending soon that the person reads
 * (RLS decides), soonest first.
 */
export async function EndingSoonCard({ orgId, timeZone, editable }: Props) {
  const days = await getContractRenewalDays(orgId);
  const today = zoneDate(new Date(), timeZone);
  const [docs, expired] = await Promise.all([
    listEndingSoonDocuments(orgId, today, days),
    listRecentlyExpiredDocuments(orgId, today),
  ]);
  return (
    <Card aria-labelledby="contract-renewal-title">
      <CardHeader id="contract-renewal-title" title="חוזים לחידוש" />
      <CardBody className="space-y-3">
        <p className="text-md text-ink-soft">
          במסמך חתום אפשר לקבוע עד מתי הוא בתוקף ומתי לחדש אותו, בכרטיס
          &quot;מסמכים לחתימה&quot; של הרשומה. תבנית עם תוקף קבוע ממלאת את
          התאריך לבד כשהלקוח חותם.
        </p>
        {editable ? (
          <ContractRenewalForm orgId={orgId} days={days} />
        ) : (
          <p className="text-sm text-ink-soft">{`התראה לפני חידוש: ${contractRenewalLabel(days)}. בעלים ומנהלי מערכת משנים את ההגדרה.`}</p>
        )}
        <h3 className="text-md font-semibold text-ink">מסתיימים בקרוב</h3>
        {docs.length > 0 ? (
          <DocumentList orgId={orgId} docs={docs} />
        ) : (
          <p className="text-sm text-ink-soft">{`אין מסמכים חתומים שהתוקף שלהם מסתיים ב-${days > 0 ? days : CONTRACT_RENEWAL_DEFAULT} הימים הקרובים.`}</p>
        )}
        {expired.length > 0 ? (
          <>
            <h3 className="text-md font-semibold text-ink">{`פג תוקף החוזה (ב-${EXPIRED_LIST_DAYS} הימים האחרונים)`}</h3>
            <DocumentList orgId={orgId} docs={expired} expired />
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
