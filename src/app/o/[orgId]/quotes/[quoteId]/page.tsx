import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { cancelQuoteAction, duplicateQuoteAction, newQuoteAddendumAction, newQuoteVersionAction } from "@/features/quotes/actions";
import { copyNoticeText, readCopyNotice } from "@/features/quotes/duplicate";
import { offersDealMove } from "@/features/quotes/accept-deal";
import { QuoteDealMoveCard } from "@/features/quotes/components/quote-deal-move-card";
import { orderFromQuoteAction } from "@/features/orders/actions";
import { getOrdersAccess } from "@/features/orders/access";
import { OrdersOffer } from "@/features/orders/components/orders-offer";
import { orderPath } from "@/features/orders/paths";
import { getQuoteOrder } from "@/features/orders/queries";
import { CancelAcceptedQuote } from "@/features/quotes/components/cancel-accepted-quote";
import { CopySkippedLines } from "@/features/quotes/components/copy-skipped-lines";
import { getCalendarSettings } from "@/features/calendar-days/queries";
import { closeWindowSetup } from "@/features/deals/close-window";
import { listMembers } from "@/features/settings/queries";
import { PageHeader } from "@/components/ui/page-header";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { QuoteEditor } from "@/features/quotes/components/quote-editor";
import { QuoteTemplateTools } from "@/features/quotes/components/quote-template-tools";
import { detachedQuotesPath, quoteDocumentPath, quotePath } from "@/features/quotes/paths";
import { listQuoteTemplates } from "@/features/quotes/template-server";
import { appliedText } from "@/features/quotes/templates";
import { isAdminRole } from "@/features/settings/permissions";
import { getDealOpen, getQuote, getQuoteAcceptDeal, getQuoteAddenda, getQuoteCustomerNow, getQuoteDecision, getQuoteLinkStatus, getQuoteParties, getQuoteVersions, getQuoteViews, getQuotePricing, listArchivedLineProducts, listCopySkippedLines, listQuoteLines, listQuoteSchedule } from "@/features/quotes/queries";
import { quoteViewsCount } from "@/features/quotes/views";
import { QuoteScheduleCard } from "@/features/quotes/components/quote-schedule-card";
import { QuoteLinkCard } from "@/features/quotes/components/quote-link-card";
import { QuoteDecisionCard } from "@/features/quotes/components/quote-decision-card";
import { SendQuoteFlow } from "@/features/quotes/components/send-quote-flow";
import { currentNameIfChanged } from "@/features/quotes/share";
import { QUOTE_STATUS_LABELS, VERSIONABLE_STATUSES } from "@/features/quotes/schema";
import { orgHasFeature } from "@/features/settings/queries";
import { canEditRecordHint, getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "הצעת מחיר" };

type Props = {
  params: Promise<{ orgId: string; quoteId: string }>;
  // QUO-04: the outcome of starting from a template (createQuoteAction)
  // QUO-15: the outcome of a copy (duplicateQuoteAction)
  searchParams: Promise<{
    template?: string;
    added?: string;
    skipped?: string;
    copy?: string;
    copy_left?: string | string[];
    copy_more?: string;
    copy_discount?: string;
    copy_from?: string;
    copy_line?: string | string[];
  }>;
};

function count(value: string | undefined): number {
  return value && /^\d{1,3}$/.test(value) ? Number(value) : 0;
}

const linkClass = "text-accent-strong underline-offset-4 hover:underline";

/**
 * QUO-01, QUO-02: one quote and its editor. Whoever reads the quote's deal (else its contact) reads it;
 * whoever may edit that deal or contact edits it while it is a draft (RLS decides again on every write).
 */
export default async function QuotePage({ params, searchParams }: Props) {
  const [{ orgId, quoteId }, started] = await Promise.all([params, searchParams]);
  if (!isUuid(quoteId)) notFound();
  const context = await getOrgContext(orgId);
  const quote = await getQuote(orgId, quoteId);
  if (!quote) notFound();
  const supabase = await createClient();
  const [lines, pricing, parties, hasProducts, hasDiscounts, hasQuotes, templates, parent, schedule, customerNow, versions, views, addenda] = await Promise.all([
    listQuoteLines(orgId, quote.id),
    getQuotePricing(orgId, quote),
    getQuoteParties(orgId, quote),
    orgHasFeature(orgId, "products"),
    orgHasFeature(orgId, "discounts"),
    orgHasFeature(orgId, "quotes"),
    // QUO-04
    listQuoteTemplates(orgId),
    quote.dealId
      ? supabase.from("deals").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", quote.dealId).maybeSingle()
      : quote.contactId
        ? supabase.from("contacts").select("owner_id, deleted_at").eq("organization_id", orgId).eq("id", quote.contactId).maybeSingle()
        : // QUO-07: a sent quote whose deal and contact were purged
          null,
    // GAP-09
    listQuoteSchedule(orgId, quote.id),
    // QUO-08: who the link goes to; QUO-07: the customer's name today, beside the printed one
    getQuoteCustomerNow(orgId, quote),
    // QUO-12
    getQuoteVersions(orgId, quote),
    // QUO-10
    getQuoteViews(orgId, quote.id),
    // GAP-10
    getQuoteAddenda(orgId, quote),
  ]);
  const parentRow = parent ? must(parent, "quote parent") : null;
  // QUO-12 (owner, 19 October 2026): lines whose product left the catalog stay as they are, marked on this screen only
  const archivedProducts = await listArchivedLineProducts(orgId, lines);
  const canEdit = quote.status === "draft" && parentRow !== null && parentRow.deleted_at === null && canEditRecordHint(context, parentRow.owner_id);
  // QUO-08: the customer's link of a sent quote, for those who may edit its deal or contact (the database decides)
  const linkStatus =
    quote.status !== "draft" && parentRow !== null && parentRow.deleted_at === null && canEditRecordHint(context, parentRow.owner_id)
      ? await getQuoteLinkStatus(orgId, quote.id)
      : null;
  const back = quote.dealId
    ? { href: paths.deal(orgId, quote.dealId), label: parties.deal ?? "עסקה" }
    : quote.contactId
      ? { href: paths.contact(orgId, quote.contactId), label: parties.contact ?? "איש קשר" }
      : // QUO-07: a quote whose customer was deleted belongs to the list of such quotes
        { href: detachedQuotesPath(orgId), label: "הצעות של לקוחות שנמחקו" };
  // QUO-12 (owner, 18 October 2026): a sent, undecided quote is changed by a new version, made by whoever may edit its record;
  // (owner, 19 October 2026) also a declined or expired one, never an accepted or cancelled one
  const canVersion =
    hasQuotes &&
    VERSIONABLE_STATUSES.includes(quote.status) &&
    versions.newer === null &&
    parentRow !== null &&
    parentRow.deleted_at === null &&
    canEditRecordHint(context, parentRow.owner_id);
  // QUO-09: the customer's answer with its evidence, owners/admins only (RLS decides again)
  const decision =
    (quote.status === "accepted" || quote.status === "rejected") && isAdminRole(context.role) ? await getQuoteDecision(orgId, quote.id) : null;
  // QUO-11: a sent, viewed or expired quote may be cancelled by whoever may edit its record; never an accepted one (open question)
  const canCancel =
    hasQuotes &&
    (quote.status === "sent" || quote.status === "viewed" || quote.status === "expired") &&
    parentRow !== null &&
    parentRow.deleted_at === null &&
    canEditRecordHint(context, parentRow.owner_id);
  // QUO-11 (owner, 19 October 2026): owners and admins cancel an accepted quote, with a reason
  const canCancelAccepted = hasQuotes && quote.status === "accepted" && isAdminRole(context.role) && context.canWrite;
  // GAP-10: an accepted original (never an addendum) takes addenda, made by whoever may edit its record
  const canAddendum =
    hasQuotes &&
    quote.status === "accepted" &&
    quote.addendumOf === null &&
    parentRow !== null &&
    parentRow.deleted_at === null &&
    canEditRecordHint(context, parentRow.owner_id);
  // QUO-15: any quote, whatever its status, is copied into a new draft by whoever may edit its record
  const canDuplicate = hasQuotes && parentRow !== null && parentRow.deleted_at === null && canEditRecordHint(context, parentRow.owner_id);
  // QUO-13: the customer accepted and the deal is still open: offer the move (the "ask" setting, or an automatic step that failed)
  const mayMove = hasQuotes && quote.status === "accepted" && quote.dealId !== null && parentRow !== null && canEditRecordHint(context, parentRow.owner_id);
  const [dealOpen, acceptMode] = mayMove ? await Promise.all([getDealOpen(orgId, quote.dealId), getQuoteAcceptDeal(orgId)]) : [false, "none" as const];
  const offerMove = offersDealMove({
    status: quote.status,
    hasDeal: quote.dealId !== null,
    isAddendum: quote.addendumOf !== null,
    dealOpen,
    mode: acceptMode,
    canEdit: mayMove,
  });
  const moveSetup = offerMove
    ? await Promise.all([listMembers(orgId), getCalendarSettings(orgId)]).then(([members, calendar]) =>
        closeWindowSetup(
          members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
          context.org.timeZone,
          calendar,
          context.user.id,
        ),
      )
    : null;
  // ORD-01 (owner, 19 October 2026): an accepted quote makes one order, numbered at once; while the module is off, owners and
  // admins are offered once to switch it on
  const ordersAccess = quote.status === "accepted" ? await getOrdersAccess(orgId) : null;
  const quoteOrder = ordersAccess?.on ? await getQuoteOrder(orgId, quote.id) : null;
  const canOrder =
    ordersAccess?.on === true && quoteOrder === null && parentRow !== null && parentRow.deleted_at === null && canEditRecordHint(context, parentRow.owner_id);
  const offerOrders =
    ordersAccess !== null && ordersAccess.inPlan && !ordersAccess.on && !ordersAccess.offerClosed && isAdminRole(context.role) && context.canWrite;
  const copied = readCopyNotice(started);
  const copiedText = copied ? copyNoticeText(copied) : null;
  // QUO-15 (owner, 19 October 2026): the left-out lines, offered as free lines while this draft may be edited
  const skippedLines =
    copied?.from && canEdit
      ? (await listCopySkippedLines(orgId, copied.from, copied.lineIds)).map((line) => ({
          id: line.id,
          name: line.name,
          quantity: line.quantity,
          unitPriceAgorot: line.unitPriceAgorot,
          added: lines.some(
            (own) => own.kind === "item" && own.productId === null && own.name === line.name && own.quantity === line.quantity && own.unitPriceAgorot === line.unitPriceAgorot,
          ),
        }))
      : [];
  const recipient = {
    name: customerNow.contactName,
    email: customerNow.email,
    phoneE164: customerNow.phoneE164,
    // CON-10: the contact's preferred channel comes first; WA-01's {שם הנציג} is the person sending
    preferredChannel: customerNow.preferredChannel,
    senderName: context.user.displayName,
  };
  // QUO-07 point 9 (owner, 18 October 2026): a sent document keeps the name it was sent with; the card shows today's beside it
  const renamed = quote.status !== "draft" && !quote.customerDeletedAt ? currentNameIfChanged(quote.customerName, customerNow.name) : null;

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={quote.title}
        back={back}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* QUO-05: the quote as its customer sees it, to print or save as PDF */}
            <ButtonLink href={quoteDocumentPath(orgId, quote.id)} variant="secondary" size="sm">
              תצוגה והדפסה
            </ButtonLink>
            {/* QUO-07: the draft gets its number and is locked; QUO-08: its link and the WhatsApp and email buttons with it.
                Mounted for every quote so the window survives the refresh that turns the draft into a sent quote. */}
            <SendQuoteFlow orgId={orgId} quoteId={quote.id} canSend={canEdit} businessName={context.org.name} recipient={recipient} />
            {canVersion ? (
              <ConfirmButton
                variant="secondary"
                size="sm"
                title="ליצור גרסה חדשה של ההצעה?"
                description="תיווצר טיוטה חדשה, עותק של ההצעה עם השורות ולוח התשלומים, ובה עושים את השינויים. ההצעה הזאת נשארת כפי שנשלחה. עד שהגרסה החדשה תישלח, הלקוח רואה בקישור הישן את ההצעה הזאת עם הודעה שגרסה מעודכנת בהכנה. כשהגרסה החדשה תישלח היא תקבל מספר חדש, והקישור הישן יציג אותה מרגע שיהיה לה קישור משלה."
                confirmLabel="יצירת גרסה חדשה"
                action={newQuoteVersionAction.bind(null, orgId, quote.id)}
              >
                עריכה בגרסה חדשה
              </ConfirmButton>
            ) : null}
            {canAddendum ? (
              <ConfirmButton
                variant="secondary"
                size="sm"
                title="ליצור תוספת להצעה?"
                description="תיווצר הצעה חדשה וריקה על אותה עסקה ואותו איש קשר, מקושרת להצעה הזאת. מוסיפים בה את העבודה הנוספת, שולחים אותה והלקוח מאשר וחותם עליה כמו על כל הצעה. ההצעה המאושרת נשארת כפי שהיא."
                confirmLabel="יצירת תוספת"
                action={newQuoteAddendumAction.bind(null, orgId, quote.id)}
              >
                תוספת להצעה
              </ConfirmButton>
            ) : null}
            {canDuplicate ? (
              <ConfirmButton
                variant="secondary"
                size="sm"
                title="לשכפל את ההצעה?"
                description="תיווצר טיוטה חדשה על אותה עסקה ואותו איש קשר, עם השורות, לוח התשלומים והתנאים של ההצעה הזאת. ההצעה הזאת לא משתנה. שורה של מוצר שכבר לא מוצע לא תועתק, ונראה לכם אילו שורות נשארו בחוץ."
                confirmLabel="שכפול"
                action={duplicateQuoteAction.bind(null, orgId, quote.id)}
              >
                שכפול
              </ConfirmButton>
            ) : null}
            {quoteOrder ? (
              <ButtonLink href={orderPath(orgId, quoteOrder.id)} variant="secondary" size="sm">
                {quoteOrder.numberDisplay ? (
                  <>
                    הזמנה{" "}
                    <span dir="ltr" className="tabular-nums">
                      {quoteOrder.numberDisplay}
                    </span>
                  </>
                ) : (
                  "ההזמנה"
                )}
              </ButtonLink>
            ) : null}
            {canOrder ? (
              <ConfirmButton
                variant="primary"
                size="sm"
                title="ליצור הזמנה מההצעה?"
                description="תיווצר הזמנה ממוספרת עם השורות והמחירים שהלקוח אישר. בהזמנה אפשר לשנות מועד אספקה, כתובת משלוח, הערות ואיש קשר לאספקה; שינוי מחיר עובר דרך תוספת להצעה."
                confirmLabel="יצירת הזמנה"
                action={orderFromQuoteAction.bind(null, orgId, quote.id)}
              >
                יצירת הזמנה
              </ConfirmButton>
            ) : null}
            {canCancelAccepted ? <CancelAcceptedQuote orgId={orgId} quoteId={quote.id} /> : null}
            {canCancel ? (
              <ConfirmButton
                variant="danger-ghost"
                size="sm"
                title="לבטל את ההצעה?"
                description="ההצעה תסומן כמבוטלת, הקישור של הלקוח יפסיק לעבוד, וברשומה יירשם מי ביטל. אי אפשר להחזיר הצעה מבוטלת."
                confirmLabel="ביטול ההצעה"
                action={cancelQuoteAction.bind(null, orgId, quote.id)}
              >
                ביטול ההצעה
              </ConfirmButton>
            ) : null}
          </div>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-soft">
        <Badge>{QUOTE_STATUS_LABELS[quote.status]}</Badge>
        {quote.cancelledFrom === "accepted" ? <span>בוטלה אחרי שהלקוח אישר{quote.cancelReason ? <> · סיבה: <bdi>{quote.cancelReason}</bdi></> : null}</span> : null}
        {quote.numberDisplay ? (
          <span>
            מספר{" "}
            <span dir="ltr" className="font-medium text-ink tabular-nums">
              {quote.numberDisplay}
            </span>
          </span>
        ) : null}
        {quote.sentAt ? <span>נשלחה {formatDate(quote.sentAt)}</span> : null}
        {views ? (
          // QUO-10: the customer's views (first, count, last)
          <span>
            נפתחה לראשונה {formatDateTime(views.firstViewedAt)} · {quoteViewsCount(views)}
            {views.count > 1 ? <> · אחרונה {formatDateTime(views.lastViewedAt)}</> : null}
          </span>
        ) : null}
        {quote.status !== "draft" && quote.customerName && !quote.customerDeletedAt ? (
          <span>
            לקוח במסמך: <bdi className="text-ink">{quote.customerName}</bdi>
            {renamed ? (
              <>
                {" "}
                (השם הנוכחי: <bdi>{renamed}</bdi>)
              </>
            ) : null}
          </span>
        ) : null}
        {/* QUO-12: the version chain */}
        {versions.newer ? (
          versions.newer.status === "draft" ? (
            <Link href={quotePath(orgId, versions.newer.id)} className={linkClass}>
              יש להצעה גרסה חדשה בטיוטה
            </Link>
          ) : (
            <Badge tone="warning">
              <Link href={quotePath(orgId, versions.newer.id)} className="underline-offset-4 hover:underline">
                הוחלפה בגרסה{" "}
                <span dir="ltr" className="tabular-nums">
                  {versions.newer.numberDisplay}
                </span>
              </Link>
            </Badge>
          )
        ) : null}
        {versions.previous ? (
          <span>
            גרסה חדשה של{" "}
            <Link href={quotePath(orgId, versions.previous.id)} className={linkClass}>
              הצעה{" "}
              <span dir="ltr" className="tabular-nums">
                {versions.previous.numberDisplay}
              </span>
            </Link>
          </span>
        ) : null}
        {/* GAP-10 */}
        {addenda.original ? (
          <span>
            תוספת להצעה{" "}
            <Link href={quotePath(orgId, addenda.original.id)} className={linkClass}>
              <span dir="ltr" className="tabular-nums">
                {addenda.original.numberDisplay}
              </span>
            </Link>
          </span>
        ) : null}
        {quote.customerDeletedAt ? (
          <Badge tone="warning">
            הלקוח נמחק{quote.customerName ? `: ${quote.customerName}` : ""}
          </Badge>
        ) : null}
        <span>{formatDate(quote.quoteDate)}</span>
        {quote.dealId && parties.deal ? (
          <span>
            עסקה:{" "}
            <Link href={paths.deal(orgId, quote.dealId)} className={linkClass}>
              <bdi>{parties.deal}</bdi>
            </Link>
          </span>
        ) : null}
        {quote.contactId && parties.contact ? (
          <span>
            איש קשר:{" "}
            <Link href={paths.contact(orgId, quote.contactId)} className={linkClass}>
              <bdi>{parties.contact}</bdi>
            </Link>
          </span>
        ) : null}
        {quote.companyId && parties.company ? (
          <span>
            חברה:{" "}
            <Link href={paths.company(orgId, quote.companyId)} className={linkClass}>
              <bdi>{parties.company}</bdi>
            </Link>
          </span>
        ) : null}
      </div>
      {decision ? <QuoteDecisionCard decision={decision} /> : null}
      {mayMove ? <QuoteDealMoveCard orgId={orgId} quoteId={quote.id} offer={offerMove} setup={moveSetup} /> : null}
      {offerOrders ? (
        <div className="mb-5">
          <OrdersOffer orgId={orgId} />
        </div>
      ) : null}
      {/* GAP-10: the addenda of this quote */}
      {addenda.addenda.length > 0 ? (
        <section aria-labelledby="quote-addenda-title" className="mb-5 rounded-lg border border-line bg-surface p-4 sm:p-5">
          <h2 id="quote-addenda-title" className="mb-3 text-base font-semibold">
            תוספות להצעה
          </h2>
          <ul className="divide-y divide-line text-sm">
            {addenda.addenda.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                <Link href={quotePath(orgId, a.id)} className={linkClass}>
                  {a.numberDisplay ? (
                    <span dir="ltr" className="tabular-nums">
                      {a.numberDisplay}
                    </span>
                  ) : null}{" "}
                  <bdi>{a.title}</bdi>
                </Link>
                <span className="flex items-center gap-3">
                  <Badge>{QUOTE_STATUS_LABELS[a.status]}</Badge>
                  <span className="tabular-nums text-ink">{formatMoney(a.totalAgorot)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {linkStatus ? (
        <QuoteLinkCard
          orgId={orgId}
          quoteId={quote.id}
          numberDisplay={quote.numberDisplay}
          active={linkStatus.active}
          createdText={linkStatus.createdAt ? formatDate(linkStatus.createdAt) : ""}
          businessName={context.org.name}
          recipient={recipient}
        />
      ) : null}
      {copiedText ? (
        <div className="mb-5 space-y-2">
          <FormNotice message={copiedText.done} />
          {copiedText.left ? <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">{copiedText.left}</p> : null}
          {copiedText.discount ? <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">{copiedText.discount}</p> : null}
          {skippedLines.length > 0 && copied?.from ? <CopySkippedLines orgId={orgId} draftId={quote.id} sourceId={copied.from} items={skippedLines} /> : null}
        </div>
      ) : null}
      {started.template === "ok" ? (
        <FormNotice className="mb-5" message={appliedText(count(started.added), count(started.skipped))} />
      ) : started.template === "failed" ? (
        <FormError className="mb-5" message="ההצעה נוצרה, אבל השורות מהתבנית לא נוספו. אפשר לנסות שוב בכפתור &quot;מתבנית&quot;." />
      ) : null}
      {quote.status === "draft" ? (
        <p className="mb-5 rounded-md bg-accent-soft px-3 py-2.5 text-sm text-accent-strong">
          טיוטה: כל שינוי נשמר בהצעה, והלקוח עוד לא רואה אותה. המספר הרץ ניתן כשההצעה נשלחת.
        </p>
      ) : null}
      <div className="mb-5">
        <QuoteTemplateTools
          orgId={orgId}
          quoteId={quote.id}
          quoteTitle={quote.title}
          templates={templates.map((t) => ({ id: t.id, name: t.name }))}
          canApply={canEdit}
          canSave={hasQuotes && context.canWrite && isAdminRole(context.role)}
        />
      </div>
      <QuoteEditor
        orgId={orgId}
        quote={quote}
        lines={lines}
        archivedProducts={archivedProducts}
        pricing={pricing}
        chargesVat={pricing.businessRateBp !== null && pricing.businessRateBp > 0}
        canEdit={canEdit}
        features={{ products: hasProducts, discounts: hasDiscounts }}
      />
      {/* GAP-09: the payment schedule, shown on the document and the customer's page too */}
      <div className="mt-5">
        <QuoteScheduleCard orgId={orgId} quoteId={quote.id} steps={schedule} totalAgorot={quote.totalAgorot} canEdit={canEdit} />
      </div>
    </div>
  );
}
