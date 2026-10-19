import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate, formatMoney } from "@/lib/format";

import { quotePath } from "../paths";
import { countDealLines, listRecordQuotes } from "../queries";
import { listQuoteTemplates } from "../template-server";
import { QUOTE_STATUS_LABELS } from "../schema";
import { NewQuoteButton } from "./new-quote-button";

type Props = {
  orgId: string;
  // QUO-16: a company shows the quotes that name it; a quote is made from a deal or a contact
  subject: { kind: "deal" | "contact" | "company"; id: string };
  // the plan holds quotes and the person may edit the record (RLS decides again)
  canCreate: boolean;
};

/** QUO-01: the quotes of a deal or a contact, with "הצעה חדשה". Hidden when there is nothing to show or do. */
export async function RecordQuotesCard({ orgId, subject, canCreate }: Props) {
  const source = subject.kind === "company" ? null : { kind: subject.kind, id: subject.id };
  const creates = canCreate && source !== null;
  const [quotes, templates, dealLines] = await Promise.all([
    listRecordQuotes(orgId, subject),
    creates ? listQuoteTemplates(orgId) : [],
    // DLI-05: a deal's quote may start from its lines
    creates && subject.kind === "deal" ? countDealLines(orgId, subject.id) : 0,
  ]);
  if (quotes.length === 0 && !creates) return null;
  return (
    <Card aria-labelledby={`quotes-${subject.id}`} className="print:hidden">
      <CardHeader id={`quotes-${subject.id}`} title="הצעות מחיר" action={
          creates && source ? (
            <NewQuoteButton orgId={orgId} source={source} templates={templates.map((t) => ({ id: t.id, name: t.name }))} dealLines={dealLines} />
          ) : null
        } />
      <CardBody>
        {quotes.length === 0 ? (
          <p className="text-sm text-ink-soft">{subject.kind === "deal" ? "עוד אין הצעות מחיר לעסקה." : subject.kind === "contact" ? "עוד אין הצעות מחיר לאיש הקשר." : "עוד אין הצעות מחיר לחברה."}</p>
        ) : (
          <ul className="divide-y divide-line">
            {quotes.map((quote) => (
              <li key={quote.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <Link href={quotePath(orgId, quote.id)} className="min-w-0 flex-1 font-medium break-words text-accent-strong underline-offset-4 hover:underline">
                  {quote.numberDisplay ? (
                    <span dir="ltr" className="me-1 tabular-nums">
                      {quote.numberDisplay}
                    </span>
                  ) : null}
                  <bdi>{quote.title}</bdi>
                </Link>
                <span className="flex items-center gap-2 text-sm text-ink-soft">
                  <Badge>{QUOTE_STATUS_LABELS[quote.status]}</Badge>
                  <span className="tabular-nums">{formatMoney(quote.totalAgorot)}</span>
                  <span>{formatDate(quote.quoteDate)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
