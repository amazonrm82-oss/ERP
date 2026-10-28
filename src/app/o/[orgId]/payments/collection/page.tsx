import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Checkbox, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { AGING_BUCKETS } from "@/features/balances/debt";
import {
  collectionFilters,
  collectionHref,
  collectionTexts,
  lateText,
  type CollectionFilters,
  type CollectionRow,
} from "@/features/collection/collection";
import { PromiseButton } from "@/features/collection/components/promise-button";
import { PromiseLine } from "@/features/collection/components/promise-line";
import {
  getCollection,
  getCollectionAccess,
  getCustomerPromise,
} from "@/features/collection/queries";
import {
  DOCUMENT_TYPE_LABELS,
  documentTitle,
} from "@/features/documents/schema";
import { collectionPath, paymentsPath } from "@/features/payments/paths";
import { listMembers } from "@/features/settings/queries";
import { getUserNames } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { formatDate, formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "גבייה" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Where a document lives: its deal's card, else its contact's, else its customer company's (a company's opening balance). */
function documentHome(orgId: string, row: CollectionRow): string | null {
  if (row.deal_id) return paths.deal(orgId, row.deal_id);
  if (row.contact_id) return paths.contact(orgId, row.contact_id);
  if (row.company_id) return paths.company(orgId, row.company_id);
  return null;
}

const BUCKET_TONES = {
  current: "neutral",
  d1_30: "warning",
  d31_60: "warning",
  d61_90: "danger",
  d91_plus: "danger",
} as const;

/**
 * COL-01: the collection screen. The open debt documents of the business (BAL-02's debt: tax invoices, proformas and positive
 * opening balances with a balance), by days late in the business's zone (BAL-03's buckets), with their customer and rep (the
 * owner of the document's deal, else its contact, else its company), the total debt and its overdue part. Filters: rep,
 * overdue only, age bucket and one customer. Read with the user's session through public.collection_documents (invoker). Who:
 * BAL-01's rule (owners, admins, managers, or the record_payments key); when any document or payment of the business is hidden
 * from the user, no amount is shown (BAL-03's partial rule). Nothing is changed here: payments, allocations and due dates are
 * worked on the document's card. COL-03: each row shows its payment promise, and whoever may record one sets it here too.
 */
export default async function CollectionPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const [access, terms] = await Promise.all([
    getCollectionAccess(orgId),
    getOrgTerms(orgId),
  ]);
  const back = { href: paymentsPath(orgId), label: "לכל התשלומים" };
  const texts = collectionTexts(terms);
  const notice = (text: string) => (
    <>
      <PageHeader title="גבייה" back={back} />
      <Card>
        <CardBody>
          <p>{text}</p>
        </CardBody>
      </Card>
    </>
  );
  if (!access.inPlan) return notice("מסך הגבייה לא כלול בחבילה של העסק.");
  if (!access.canOpen)
    return notice(
      "מסך הגבייה פתוח לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת רישום תשלומים.",
    );

  const filters = collectionFilters(await searchParams);
  const [data, members] = await Promise.all([
    getCollection(orgId, filters),
    listMembers(orgId),
  ]);
  if (!data.allowed)
    return notice(
      "מסך הגבייה פתוח לבעלים, למנהלי מערכת, למנהלי צוות ולמי שקיבל הרשאת רישום תשלומים.",
    );

  const base = collectionPath(orgId);
  const href = (change: Partial<CollectionFilters>) =>
    collectionHref(base, { ...filters, ...change });
  const names = await getUserNames(data.documents.map((d) => d.owner_id));
  const filtered = Boolean(
    filters.owner || filters.overdue || filters.bucket || filters.customer,
  );
  const customerName = filters.customer
    ? (data.documents.find(
        (d) =>
          d.customer_kind === filters.customer?.kind &&
          d.customer_id === filters.customer?.id,
      )?.customer_name ?? null)
    : null;
  const day = (value: string) => formatDate(`${value}T12:00:00Z`);
  const activeMembers = members.filter((m) => m.status === "active");
  // COL-03 (1) ג: the promise on the whole customer, offered while the list is narrowed to a contact or a company
  const promiseCustomer =
    filters.customer && filters.customer.kind !== "deal"
      ? { kind: filters.customer.kind, id: filters.customer.id }
      : null;
  const customerPromise = promiseCustomer
    ? await getCustomerPromise(orgId, promiseCustomer)
    : null;

  return (
    <>
      <PageHeader title="גבייה" description={texts.description} back={back} />

      {/* COL-01 (3) ב: a user who does not read every document and payment sees the documents they read, with no totals */}
      {data.partial ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm"
        >
          <Badge tone="warning">רשימה חלקית</Badge> מוצגים רק המסמכים שאתם
          רואים, ולכן אין כאן סכום כולל. מסך הגבייה המלא זמין לבעלים ולמנהלי
          מערכת.
        </p>
      ) : (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-x-8 gap-y-2">
              <p>
                <span className="block text-sm text-ink-soft">חוב פתוח</span>
                <span className="text-xl font-semibold tabular-nums">
                  {formatMoney(data.totals.total)}
                </span>
                <span className="block text-sm text-ink-soft">
                  {data.totals.documents === 1
                    ? "מסמך אחד"
                    : `${data.totals.documents.toLocaleString("he-IL")} מסמכים`}
                </span>
              </p>
              <p>
                <span className="block text-sm text-ink-soft">
                  מתוכו באיחור
                </span>
                <span
                  className={`text-xl font-semibold tabular-nums ${data.totals.overdue > 0 ? "text-danger" : ""}`}
                >
                  {formatMoney(data.totals.overdue)}
                </span>
                <span className="block text-sm text-ink-soft">
                  {data.totals.overdue_documents === 1
                    ? "מסמך אחד"
                    : `${data.totals.overdue_documents.toLocaleString("he-IL")} מסמכים`}
                </span>
              </p>
            </div>
            {/* BAL-03's buckets; each one is a filter */}
            <ul className="flex flex-wrap gap-2" aria-label="החוב לפי גיל">
              {AGING_BUCKETS.map((b) => {
                const active = filters.bucket === b.key;
                return (
                  <li key={b.key}>
                    <Link
                      href={href({ bucket: active ? null : b.key })}
                      aria-current={active ? "true" : undefined}
                      className={`inline-flex flex-col rounded-lg border px-3 py-1.5 text-sm ${active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-canvas"}`}
                    >
                      <span className="text-ink-soft">{b.label}</span>
                      <span className="font-medium tabular-nums">
                        {formatMoney(data.totals[b.key])}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}

      <form
        method="get"
        action={base}
        className="mb-4 flex flex-wrap items-end gap-3"
        aria-label="סינון הגבייה"
      >
        {filters.customer ? (
          <>
            <input type="hidden" name="ck" value={filters.customer.kind} />
            <input type="hidden" name="cid" value={filters.customer.id} />
          </>
        ) : null}
        <label>
          <span className="mb-1.5 block text-sm font-medium">נציג</span>
          <Select
            name="owner"
            defaultValue={filters.owner ?? ""}
            className="w-44"
          >
            <option value="">כל הנציגים</option>
            {activeMembers.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span className="mb-1.5 block text-sm font-medium">גיל החוב</span>
          <Select
            name="bucket"
            defaultValue={filters.bucket ?? ""}
            className="w-48"
          >
            <option value="">הכול</option>
            {AGING_BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </Select>
        </label>
        <Checkbox
          name="overdue"
          value="1"
          defaultChecked={filters.overdue}
          label="רק באיחור"
        />
        <button type="submit" className={buttonClasses("secondary", "md")}>
          הצגה
        </button>
        {filtered ? (
          <Link href={base} className={buttonClasses("ghost", "md")}>
            ניקוי הסינון
          </Link>
        ) : null}
      </form>

      {filters.customer ? (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span>
            {texts.kind[filters.customer.kind]}:{" "}
            <bdi className="font-medium">{customerName ?? "הלקוח שנבחר"}</bdi>
          </span>
          <Link
            href={href({ customer: null })}
            className="text-accent-strong underline-offset-4 hover:underline"
          >
            לכל הלקוחות
          </Link>
          {promiseCustomer && access.canPromise ? (
            <PromiseButton
              orgId={orgId}
              target={promiseCustomer}
              label={customerName ?? "הלקוח שנבחר"}
              back={{ kind: "collection" }}
              current={customerPromise}
              today={data.today}
            />
          ) : null}
        </p>
      ) : null}
      {customerPromise ? (
        <div className="mb-4">
          <PromiseLine
            date={customerPromise.date}
            note={customerPromise.note}
            today={data.today}
            customer
          />
        </div>
      ) : null}

      {filtered && data.shown ? (
        <p className="mb-4 text-sm text-ink-soft">
          לפי הסינון:{" "}
          <span className="font-medium text-ink tabular-nums">
            {formatMoney(data.shown.total)}
          </span>{" "}
          ב-
          {data.shown.documents === 1
            ? "מסמך אחד"
            : `${data.shown.documents.toLocaleString("he-IL")} מסמכים`}
        </p>
      ) : null}

      {data.documents.length === 0 ? (
        <Card>
          <EmptyState
            title={
              filtered ? "אין מסמכים פתוחים לפי הסינון" : "אין חובות פתוחים"
            }
            description={
              filtered
                ? "נסו סינון אחר, או נקו אותו."
                : "חשבונית מס, חשבון עסקה או יתרת פתיחה עם יתרה לתשלום יופיעו כאן עד שישולמו."
            }
          />
        </Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-line">
              {data.documents.map((row) => {
                const home = documentHome(orgId, row);
                const title = documentTitle({
                  docType: row.doc_type,
                  number: row.number,
                  docDate: row.doc_date,
                });
                const owner = row.owner_id ? names.get(row.owner_id) : null;
                const late = row.days_late !== null && row.days_late >= 1;
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium break-words">
                        <Link
                          href={href({
                            customer: {
                              kind: row.customer_kind,
                              id: row.customer_id,
                            },
                          })}
                          className="text-accent-strong underline-offset-4 hover:underline"
                          aria-label={`${row.customer_name ?? "לקוח"}: רק המסמכים של הלקוח הזה`}
                        >
                          <bdi>{row.customer_name ?? "לקוח"}</bdi>
                        </Link>{" "}
                        <span className="text-sm font-normal text-ink-soft">
                          ({texts.kind[row.customer_kind]})
                        </span>
                        {row.held ? (
                          <>
                            {" "}
                            <Badge tone="danger">לא למכור עד הסדרת חוב</Badge>
                          </>
                        ) : null}
                      </p>
                      <p className="text-sm break-words">
                        {home ? (
                          <Link
                            href={home}
                            className="underline-offset-4 hover:underline"
                            aria-label={`${title}: לכרטיס`}
                          >
                            {row.doc_type === "opening_balance" ? (
                              title
                            ) : (
                              <>
                                {DOCUMENT_TYPE_LABELS[row.doc_type]}{" "}
                                <bdi dir="ltr" className="tabular-nums">
                                  {row.number}
                                </bdi>
                              </>
                            )}
                          </Link>
                        ) : (
                          title
                        )}
                        <span className="text-ink-soft">
                          {" · "}
                          {row.due_date
                            ? `לתשלום עד ${day(row.due_date)}`
                            : "בלי מועד תשלום"}
                          {` · נציג: ${owner ?? "אין"}`}
                        </span>
                      </p>
                      {/* COL-03 */}
                      {row.promised_date ? (
                        <PromiseLine
                          date={row.promised_date}
                          note={row.promise_note}
                          today={data.today}
                          customer={row.promise_kind === "customer"}
                        />
                      ) : null}
                    </div>
                    <span className="text-end">
                      <span className="block font-medium whitespace-nowrap tabular-nums">
                        {formatMoney(row.balance)}
                      </span>
                      {row.balance !== row.amount ? (
                        <span className="block text-sm text-ink-soft tabular-nums">
                          מתוך {formatMoney(row.amount)}
                        </span>
                      ) : null}
                      <span className="mt-1 flex flex-wrap items-center justify-end gap-1">
                        <Badge
                          tone={late ? BUCKET_TONES[row.bucket] : "neutral"}
                        >
                          {lateText(row.days_late)}
                        </Badge>
                        {access.canPromise ? (
                          <PromiseButton
                            orgId={orgId}
                            target={{ kind: "document", id: row.id }}
                            label={title}
                            back={{ kind: "collection" }}
                            current={
                              row.promised_date &&
                              row.promise_kind === "document"
                                ? {
                                    date: row.promised_date,
                                    note: row.promise_note,
                                  }
                                : null
                            }
                            today={data.today}
                          />
                        ) : null}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}
      {data.more ? (
        <p className="mt-3 text-sm text-ink-soft">
          {data.partial
            ? "מוצגים 500 המסמכים הוותיקים ביותר באיחור. צמצמו בסינון כדי לראות את השאר."
            : "מוצגים 500 המסמכים הוותיקים ביותר באיחור; הסכומים כוללים את כולם. צמצמו בסינון כדי לראות את השאר."}
        </p>
      ) : null}
    </>
  );
}
