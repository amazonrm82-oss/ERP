import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";

import type { QuoteDecision } from "../queries";

type Props = { decision: QuoteDecision };

/**
 * QUO-09: the customer's answer and the evidence kept with it, for owners and admins only (the table's RLS; owner,
 * 18 October 2026). After a privacy erasure only the answer, its time and the fingerprint of the signed version remain.
 */
export function QuoteDecisionCard({ decision }: Props) {
  const accepted = decision.decision === "accepted";
  const rows: { label: string; value: string | null; ltr?: boolean }[] = [
    { label: "מועד", value: formatDateTime(decision.decidedAt) },
    { label: "שם החותם", value: decision.signerName },
    { label: "תעודת זהות", value: decision.signerIdNumber, ltr: true },
    { label: "סוג החתימה", value: decision.signatureKind === "drawn" ? "ציור" : decision.signatureKind === "typed" ? "שם מוקלד" : null },
    { label: "נוסח האישור", value: decision.wordingVersion, ltr: true },
    { label: "סיבת הדחייה", value: decision.declineReason },
    { label: "כתובת IP", value: decision.ip, ltr: true },
    { label: "דפדפן", value: decision.userAgent, ltr: true },
    { label: "טביעת הגרסה שנחתמה", value: decision.contentSha256, ltr: true },
  ];

  return (
    <Card className="mb-5" aria-labelledby="quote-decision-title">
      <CardHeader id="quote-decision-title" title={accepted ? "אישור הלקוח" : "דחיית הלקוח"} />
      <CardBody className="space-y-3 text-sm">
        {decision.erasedAt ? <p className="text-ink-soft">פרטי החותם נמחקו בבקשת פרטיות.</p> : null}
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
          {rows
            .filter((row) => row.value)
            .map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-ink-soft">{row.label}</dt>
                <dd className="min-w-0 break-all text-ink" dir={row.ltr ? "ltr" : undefined}>
                  {row.ltr ? row.value : <bdi>{row.value}</bdi>}
                </dd>
              </div>
            ))}
        </dl>
        {decision.signatureImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- a stored PNG data URL, not a file to optimize
          <img
            src={decision.signatureImage}
            alt={`החתימה של ${decision.signerName ?? "הלקוח"}`}
            className="h-24 w-auto max-w-full rounded-md border border-line bg-paper p-1"
          />
        ) : null}
        <p className="text-ink-soft">הפרטים האלה גלויים רק לבעלים ולמנהלי המערכת.</p>
      </CardBody>
    </Card>
  );
}
