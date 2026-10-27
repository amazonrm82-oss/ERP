import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { documentsPath } from "@/features/documents/paths";
import { cleanupReasons, type CleanupDeal } from "@/features/pipeline-cleanup/rules";
import { quotePath, quotesPath } from "@/features/quotes/paths";
import { QUOTE_STATUS_LABELS } from "@/features/quotes/schema";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { dealGroup, groupVatMark, MONEY_PART_LABELS, shownGroups, vatMark, type MoneyGroup, type MoneyGroupKey } from "../groups";
import type { MoneyDebt, MoneyLead, MoneyQuote, MoneyRenewal, MoneyWaiting } from "../queries";

// rows shown per group; the rest are on the full lists (the cleanup, the waiting leads)
export const ROWS_SHOWN = 50;

type Props = {
  orgId: string;
  money: MoneyWaiting;
  // the tab the screen is on; the link to the cleanup keeps it
  owner: "me" | "all";
  // MNY-02: the one action of a row (null: nothing the user can do there)
  dealAction?: (deal: CleanupDeal) => ReactNode;
  leadAction?: (lead: MoneyLead) => ReactNode;
  // the action of a quote, debt or renewal row, on the record it belongs to
  recordAction?: (row: MoneyRecordRow) => ReactNode;
};

/** The record a quote, debt or renewal row acts on: the quote's deal (else contact), the debt's deal (else contact, else company), the renewal's deal. */
export type MoneyRecordRow = {
  group: "quotes" | "debts" | "renewals";
  kind: "deal" | "contact" | "company";
  id: string;
  name: string;
  ownerId: string | null;
  // the contact WhatsApp goes to
  contactId: string | null;
};

/**
 * The record page a debt belongs to, in the order the report takes its owner: the deal, else the contact, else the
 * company (an opening balance sits on a contact or a company).
 */
export function debtRecord(debt: MoneyDebt): { kind: "deal" | "contact" | "company"; id: string } | null {
  if (debt.dealId) return { kind: "deal", id: debt.dealId };
  if (debt.contactId) return { kind: "contact", id: debt.contactId };
  if (debt.companyId) return { kind: "company", id: debt.companyId };
  return null;
}

/** The contact a debt's reminder goes to: the document's own, else its deal's (read with the user's session, so an unreadable one gives no number). */
export function debtContact(debt: MoneyDebt): string | null {
  return debt.contactId ?? debt.dealContactId;
}

function recordHref(orgId: string, record: { kind: "deal" | "contact" | "company"; id: string }): string {
  return record.kind === "deal" ? paths.deal(orgId, record.id) : record.kind === "contact" ? paths.contact(orgId, record.id) : paths.company(orgId, record.id);
}

/** MNY-01: the main number, its parts, and one card per group that exists today. */
export function MoneyView({ orgId, money, owner, dealAction, leadAction, recordAction }: Props) {
  const { summary } = money;
  const dealsOf = (key: MoneyGroupKey) => money.deals.filter((deal) => dealGroup(deal) === key);

  return (
    <>
      <section aria-labelledby="money-total-title" className="mb-5 rounded-lg border border-line bg-surface p-4 sm:p-5">
        <h2 id="money-total-title" className="text-md text-ink-soft">
          כמה כסף מחכה לכם
        </h2>
        {summary.total === null ? (
          // VAT status not set: the debts (with VAT) and the rest (before VAT) side by side, never added up
          <>
            <ul className="mt-1 grid gap-3 sm:grid-cols-2">
              {summary.parts.map((part) => (
                <li key={part.part}>
                  <p className="text-sm text-ink-soft">{MONEY_PART_LABELS[part.part]}</p>
                  <p className="text-xl font-semibold tabular-nums">{formatMoney(part.amount)}</p>
                  {part.mark ? <p className="text-sm text-ink-soft">{part.mark}</p> : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-ink-soft">{vatMark(summary.vat)}</p>
          </>
        ) : (
          <>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(summary.total)}</p>
            {vatMark(summary.vat) ? <p className="text-sm text-ink-soft">{vatMark(summary.vat)}</p> : null}
            <ul className="mt-2 space-y-0.5 text-sm text-ink-soft">
              {summary.parts.map((part) => (
                <li key={part.part}>
                  {MONEY_PART_LABELS[part.part]}: <span className="tabular-nums">{formatMoney(part.amount)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-3 border-t border-line pt-3 text-sm">
          <span className="font-medium">{MONEY_PART_LABELS.estimate}, לא נכללת בסכום: </span>
          {summary.estimate.leads === 0 ? (
            "אין לידים שמחכים למענה."
          ) : summary.estimate.amount === null ? (
            `${formatNumber(summary.estimate.leads)} לידים שלא טופלו. כדי להעריך את שווים צריך לפחות ${formatNumber(summary.estimate.minDeals)} עסקאות שנסגרו בהצלחה ב-${formatNumber(summary.estimate.days)} הימים האחרונים.`
          ) : (
            <>
              <span className="tabular-nums">{formatMoney(summary.estimate.amount)}</span> ב-{formatNumber(summary.estimate.leads)} לידים שלא טופלו, לפי ערך ממוצע של
              העסקאות שזכיתם בהן ב-{formatNumber(summary.estimate.days)} הימים האחרונים ואתם רואים (<span className="tabular-nums">{formatMoney(summary.estimate.average)}</span>{" "}
              לעסקה).
            </>
          )}
        </p>
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {shownGroups(summary).map((shownGroup) => {
          const group = { ...shownGroup, mark: groupVatMark(shownGroup.key, summary.vat) };
          const line = summary.groups[group.key] ?? { count: 0, amount: 0 };
          switch (group.key) {
            case "unhandled_leads":
              return <LeadsCard key={group.key} orgId={orgId} group={group} leads={money.leads} count={line.count} average={summary.estimate.average} action={leadAction} />;
            case "quotes":
              return <QuotesCard key={group.key} orgId={orgId} group={group} quotes={money.quotes ?? []} count={line.count} amount={line.amount ?? 0} action={recordAction} />;
            case "debts":
              return <DebtsCard key={group.key} orgId={orgId} group={group} debts={money.debts ?? []} count={line.count} amount={line.amount ?? 0} action={recordAction} />;
            case "renewals":
              return <RenewalsCard key={group.key} orgId={orgId} group={group} renewals={money.renewals} count={line.count} amount={line.amount ?? 0} action={recordAction} />;
            default:
              return <DealsCard key={group.key} orgId={orgId} owner={owner} group={group} deals={dealsOf(group.key)} count={line.count} amount={line.amount ?? 0} action={dealAction} />;
          }
        })}
      </div>
    </>
  );
}

function GroupHeader({ group, count, amount }: { group: MoneyGroup; count: number; amount: string | null }) {
  return (
    <div className="border-b border-line px-4 pb-3 sm:px-5">
      <p className="text-sm text-ink-soft">{group.description}</p>
      <p className="mt-1 text-md">
        <span className="font-semibold tabular-nums">{formatNumber(count)}</span>
        {amount ? (
          <>
            {" · "}
            <span className="font-semibold tabular-nums">{amount}</span>
            {group.mark ? <span className="text-sm text-ink-soft"> ({group.mark})</span> : null}
          </>
        ) : null}
      </p>
    </div>
  );
}

function DealsCard({
  orgId,
  owner,
  group,
  deals,
  count,
  amount,
  action,
}: {
  orgId: string;
  owner: "me" | "all";
  group: MoneyGroup;
  deals: CleanupDeal[];
  count: number;
  amount: number;
  action?: (deal: CleanupDeal) => ReactNode;
}) {
  const shown = deals.slice(0, ROWS_SHOWN);
  return (
    <Card aria-labelledby={`money-${group.key}-title`}>
      <CardHeader id={`money-${group.key}-title`} title={group.title} />
      <GroupHeader group={group} count={count} amount={formatMoney(amount)} />
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-md text-ink-soft sm:px-5">אין עסקאות כאלה כרגע.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((deal) => (
            <li key={deal.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link href={paths.deal(orgId, deal.id)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                  {deal.name || "עסקה ללא שם"}
                </Link>
                <span className="text-sm font-medium tabular-nums">{formatMoney(deal.amount)}</span>
              </div>
              <p className="mt-0.5 text-sm text-ink-soft">
                {deal.ownerName ? <bdi>{deal.ownerName}</bdi> : "בלי אחראי"}
                {deal.stageName ? ` · ${deal.stageName}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">{cleanupReasons(deal, formatNumber).join(" · ")}</p>
              {action ? action(deal) : null}
            </li>
          ))}
        </ul>
      )}
      {count > shown.length ? (
        <p className="border-t border-line px-4 py-2.5 text-sm sm:px-5">
          <Link href={paths.dealsCleanup(orgId, owner)} className="text-accent-strong underline underline-offset-4">
            לכל {formatNumber(count)} העסקאות בניקוי השבועי
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

function LeadsCard({
  orgId,
  group,
  leads,
  count,
  average,
  action,
}: {
  orgId: string;
  group: MoneyGroup;
  leads: MoneyLead[];
  count: number;
  average: number | null;
  action?: (lead: MoneyLead) => ReactNode;
}) {
  const shown = leads.slice(0, ROWS_SHOWN);
  return (
    <Card aria-labelledby={`money-${group.key}-title`}>
      <CardHeader id={`money-${group.key}-title`} title={group.title} action={<Badge>{MONEY_PART_LABELS.estimate}</Badge>} />
      <GroupHeader group={group} count={count} amount={average === null ? null : `${formatMoney(average * count)} (הערכה)`} />
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-md text-ink-soft sm:px-5">כל הלידים קיבלו מענה.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((lead) => (
            <li key={lead.id} className="px-4 py-3 sm:px-5">
              <Link href={paths.lead(orgId, lead.id)} className="block min-w-0 break-words font-medium underline-offset-4 hover:underline">
                {lead.name}
              </Link>
              <p className="mt-0.5 text-sm text-ink-soft">
                {lead.ownerName ? <bdi>{lead.ownerName}</bdi> : "בלי אחראי"} · נוצר ב-<time dateTime={lead.createdAt}>{formatDate(lead.createdAt)}</time>
              </p>
              {action ? action(lead) : null}
            </li>
          ))}
        </ul>
      )}
      {count > shown.length ? (
        <p className="border-t border-line px-4 py-2.5 text-sm sm:px-5">
          <Link href={paths.leadsWaiting(orgId)} className="text-accent-strong underline underline-offset-4">
            לכל הלידים שעוד לא קיבלו מענה
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

function RowsCard({
  group,
  count,
  amount,
  shownCount,
  empty,
  more,
  children,
}: {
  group: MoneyGroup;
  count: number;
  amount: number;
  shownCount: number;
  empty: string;
  // where the full list is; null: none, the card says how many it shows
  more: { href: string; label: string } | null;
  children: ReactNode;
}) {
  return (
    <Card aria-labelledby={`money-${group.key}-title`}>
      <CardHeader id={`money-${group.key}-title`} title={group.title} />
      <GroupHeader group={group} count={count} amount={formatMoney(amount)} />
      {shownCount === 0 ? <p className="px-4 py-4 text-md text-ink-soft sm:px-5">{empty}</p> : <ul className="divide-y divide-line">{children}</ul>}
      {count > shownCount ? (
        <p className="border-t border-line px-4 py-2.5 text-sm sm:px-5">
          {more ? (
            <Link href={more.href} className="text-accent-strong underline underline-offset-4">
              {more.label}
            </Link>
          ) : (
            `מוצגות ${formatNumber(shownCount)} מתוך ${formatNumber(count)}.`
          )}
        </p>
      ) : null}
    </Card>
  );
}

function QuotesCard({
  orgId,
  group,
  quotes,
  count,
  amount,
  action,
}: {
  orgId: string;
  group: MoneyGroup;
  quotes: MoneyQuote[];
  count: number;
  amount: number;
  action?: (row: MoneyRecordRow) => ReactNode;
}) {
  const shown = quotes.slice(0, ROWS_SHOWN);
  return (
    <RowsCard
      group={group}
      count={count}
      amount={amount}
      shownCount={shown.length}
      empty="אין הצעות שמחכות לתשובה."
      more={{ href: quotesPath(orgId), label: "לכל הצעות המחיר" }}
    >
      {shown.map((quote) => {
        const label = `הצעה${quote.number ? ` ${quote.number}` : ""}${quote.title ? `: ${quote.title}` : ""}`;
        return (
          <li key={quote.id} className="px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <Link href={quotePath(orgId, quote.id)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                <bdi>{label}</bdi>
              </Link>
              <span className="text-sm font-medium tabular-nums">{formatMoney(quote.amount)}</span>
            </div>
            <p className="mt-0.5 text-sm text-ink-soft">
              {quote.customerName ? (
                <>
                  <bdi>{quote.customerName}</bdi>
                  {" · "}
                </>
              ) : null}
              {quote.ownerName ? <bdi>{quote.ownerName}</bdi> : "בלי אחראי"}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">
              {QUOTE_STATUS_LABELS[quote.status]} · נשלחה ב-
              <time dateTime={quote.sentAt}>{formatDate(quote.sentAt)}</time>
              {quote.validUntil ? (
                <>
                  {" · "}בתוקף עד <time dateTime={quote.validUntil}>{formatDate(quote.validUntil)}</time>
                </>
              ) : null}
              {quote.netAmount !== quote.amount ? (
                <>
                  {" · "}
                  <span className="tabular-nums">{formatMoney(quote.netAmount)}</span> לפני מע&quot;מ
                </>
              ) : null}
            </p>
            {action && quote.dealId
              ? action({
                  group: "quotes",
                  kind: "deal",
                  id: quote.dealId,
                  name: label,
                  ownerId: quote.ownerId,
                  contactId: quote.contactId,
                })
              : action && quote.contactId
                ? action({
                    group: "quotes",
                    kind: "contact",
                    id: quote.contactId,
                    name: label,
                    ownerId: quote.ownerId,
                    contactId: quote.contactId,
                  })
                : null}
          </li>
        );
      })}
    </RowsCard>
  );
}

function DebtsCard({
  orgId,
  group,
  debts,
  count,
  amount,
  action,
}: {
  orgId: string;
  group: MoneyGroup;
  debts: MoneyDebt[];
  count: number;
  amount: number;
  action?: (row: MoneyRecordRow) => ReactNode;
}) {
  const shown = debts.slice(0, ROWS_SHOWN);
  return (
    <RowsCard
      group={group}
      count={count}
      amount={amount}
      shownCount={shown.length}
      empty="אין חובות באיחור."
      more={{ href: documentsPath(orgId), label: "לכל המסמכים החשבונאיים" }}
    >
      {shown.map((debt) => {
        const record = debtRecord(debt);
        const name = debt.customerName || "לקוח ללא שם";
        const doc = `${DOCUMENT_TYPE_LABELS[debt.docType]}${debt.number ? ` ${debt.number}` : ""}`;
        return (
          <li key={debt.id} className="px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              {record ? (
                <Link href={recordHref(orgId, record)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                  <bdi>{name}</bdi>
                </Link>
              ) : (
                <span className="min-w-0 break-words font-medium">
                  <bdi>{name}</bdi>
                </span>
              )}
              <span className="text-sm font-medium tabular-nums">{formatMoney(debt.balance)}</span>
            </div>
            <p className="mt-0.5 text-sm text-ink-soft">
              <bdi>{doc}</bdi>
              {debt.balance !== debt.amount ? (
                <>
                  {" · "}מתוך <span className="tabular-nums">{formatMoney(debt.amount)}</span>
                </>
              ) : null}
              {" · "}
              {debt.ownerName ? <bdi>{debt.ownerName}</bdi> : "בלי אחראי"}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">
              לתשלום עד <time dateTime={debt.dueDate}>{formatDate(debt.dueDate)}</time> · באיחור של{" "}
              {debt.daysOverdue === 1 ? "יום אחד" : `${formatNumber(debt.daysOverdue)} ימים`}
            </p>
            {action && record
              ? action({
                  group: "debts",
                  kind: record.kind,
                  id: record.id,
                  name,
                  ownerId: debt.ownerId,
                  contactId: debtContact(debt),
                })
              : null}
          </li>
        );
      })}
    </RowsCard>
  );
}

function RenewalsCard({
  orgId,
  group,
  renewals,
  count,
  amount,
  action,
}: {
  orgId: string;
  group: MoneyGroup;
  renewals: MoneyRenewal[];
  count: number;
  amount: number;
  action?: (row: MoneyRecordRow) => ReactNode;
}) {
  const shown = renewals.slice(0, ROWS_SHOWN);
  return (
    <RowsCard group={group} count={count} amount={amount} shownCount={shown.length} empty="אין חידושים ב-30 הימים הקרובים." more={null}>
      {shown.map((renewal) => {
        const name = renewal.name || "עסקה ללא שם";
        return (
          <li key={renewal.id} className="px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <Link href={paths.deal(orgId, renewal.id)} className="min-w-0 break-words font-medium underline-offset-4 hover:underline">
                <bdi>{name}</bdi>
              </Link>
              <span className="text-sm font-medium tabular-nums">
                {formatMoney(renewal.amount)} {renewal.billingKind === "monthly" ? "לחודש" : "לשנה"}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-ink-soft">
              {renewal.ownerName ? <bdi>{renewal.ownerName}</bdi> : "בלי אחראי"}
              {renewal.status === "open" ? " · עסקה פתוחה" : ""}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">
              מתחדשת ב-
              <time dateTime={renewal.renewalDate}>{formatDate(renewal.renewalDate)}</time>
            </p>
            {action
              ? action({
                  group: "renewals",
                  kind: "deal",
                  id: renewal.id,
                  name,
                  ownerId: renewal.ownerId,
                  contactId: renewal.contactId,
                })
              : null}
          </li>
        );
      })}
    </RowsCard>
  );
}
