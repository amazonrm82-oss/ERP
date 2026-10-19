"use client";

import { useActionState, useState, useTransition, type DragEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { PlusIcon } from "@/components/ui/icons";
import { ReorderButtons } from "@/components/ui/reorder-buttons";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { NamedPriceList } from "@/features/deal-lines/pricing";
import { DISCOUNT_KIND_LABELS, DISCOUNT_KINDS, type DiscountKind } from "@/features/deal-lines/schema";
import { agorotInput } from "@/features/deals/recurring";
import { BILLING_LABELS } from "@/features/products/schema";
import { documentVatError, vatRateLabel, type DocumentVat } from "@/features/tax/rates";
import type { FormState } from "@/lib/action-result";
import { formatDate, formatMoney, formatNumber, parseMoneyToAgorot } from "@/lib/format";

import { deleteQuoteAction, deleteQuoteLineAction, reorderQuoteLinesAction, saveQuoteGroupAction, setQuoteVatModeAction, updateQuoteAction } from "../actions";
import type { Quote, QuoteLine } from "../queries";
import { NO_VAT_NOTE_MAX, NO_VAT_REASON_LABELS, NO_VAT_REASONS, noVatText, QUOTE_LINE_NAME_MAX, QUOTE_LINES_MAX, QUOTE_NOTES_MAX, QUOTE_TERMS_MAX, QUOTE_TITLE_MAX, type NoVatReason } from "../schema";
import { groupSubtotals, isCounted, moveBefore, quoteTotals } from "../totals";
import { QuoteLineForm } from "./quote-line-form";

/** What the prices of the lines depend on (readQuotePricing), as the page passes it. */
export type EditorPricing = {
  day: string;
  vat: DocumentVat;
  businessRateBp: number | null;
  rateBp: number;
  includesVat: boolean;
  list: Omit<NamedPriceList, "lines"> | null;
};

type Props = {
  orgId: string;
  quote: Quote;
  lines: QuoteLine[];
  // QUO-12: products on these lines that left the catalog (marked, never dropped)
  archivedProducts?: string[];
  pricing: EditorPricing;
  // the business charges VAT (the no-VAT choice is offered only then)
  chargesVat: boolean;
  canEdit: boolean;
  features: { products: boolean; discounts: boolean };
};

function percentInput(bp: number | null): string {
  if (bp === null) return "";
  return bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, "");
}

function lineDiscountText(line: QuoteLine): string | null {
  if (line.discountBp) return `הנחה ${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return `הנחה ${formatMoney(line.discountAgorot)}`;
  return null;
}

/**
 * QUO-02: the quote editor. The quote's details and its lines (from the catalog or free), groups with a
 * heading and their own sum, optional lines, order by dragging or by the move buttons, and the summary
 * worked out live by the one totals rule while the discount or the VAT choice is being changed. Every
 * change is saved to the draft; nothing is sent to the customer here.
 */
export function QuoteEditor({ orgId, quote, lines: savedLines, archivedProducts = [], pricing, chargesVat, canEdit, features }: Props) {
  // the order shown while a move is saved; the server's lines replace it when the page refreshes
  const [lines, setLines] = useState(savedLines);
  const [shown, setShown] = useState(savedLines);
  if (shown !== savedLines) {
    setShown(savedLines);
    setLines(savedLines);
  }
  const [editing, setEditing] = useState<QuoteLine | "new" | null>(null);
  const [group, setGroup] = useState<QuoteLine | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dragged, setDragged] = useState<string | null>(null);

  // the header's live values, so the summary follows them before they are saved
  const startKind: DiscountKind | "" = quote.discountBp ? "percent" : quote.discountAgorot ? "amount" : "";
  const [discountKind, setDiscountKind] = useState<DiscountKind | "">(startKind);
  const [discount, setDiscount] = useState(quote.discountBp ? percentInput(quote.discountBp) : quote.discountAgorot ? agorotInput(quote.discountAgorot) : "");
  const [noVat, setNoVat] = useState(quote.noVatReason !== null);
  const [reason, setReason] = useState<NoVatReason | "">(quote.noVatReason ?? "");

  const [state, formAction] = useActionState<FormState, FormData>(updateQuoteAction.bind(null, orgId, quote.id), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  const docDiscountBp = discountKind === "percent" ? Math.round(Number(discount.replace(/%/g, "")) * 100) : null;
  const docDiscountAgorot = discountKind === "amount" ? parseMoneyToAgorot(discount) : null;
  const totals = quoteTotals({
    lines,
    rateBp: pricing.businessRateBp,
    noVat,
    pricesIncludeVat: quote.pricesIncludeVat,
    discountBp: docDiscountBp !== null && Number.isFinite(docDiscountBp) && docDiscountBp > 0 ? docDiscountBp : null,
    discountAgorot: docDiscountAgorot !== null && docDiscountAgorot > 0 ? docDiscountAgorot : null,
  });
  const sums = groupSubtotals(lines);
  const itemCount = lines.filter((line) => line.kind === "item").length;
  const optionalOut = lines.filter((line) => line.kind === "item" && line.isOptional && !isCounted(line)).length;
  const vatMissing = noVat ? null : documentVatError(pricing.vat);
  const vatWord = quote.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ';
  const full = lines.length >= QUOTE_LINES_MAX;

  function saveOrder(ids: string[]) {
    const before = lines;
    const byId = new Map(lines.map((line) => [line.id, line]));
    setLines(ids.map((id) => byId.get(id)).filter((line): line is QuoteLine => line !== undefined));
    setError(null);
    startTransition(async () => {
      const outcome = await reorderQuoteLinesAction(orgId, quote.id, ids);
      if (!outcome.ok) {
        setLines(before);
        setError(outcome.message);
      }
    });
  }

  function move(line: QuoteLine, direction: -1 | 1) {
    const ids = lines.map((l) => l.id);
    const index = ids.indexOf(line.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    saveOrder(ids);
  }

  function onDrop(event: DragEvent, targetId: string | null) {
    event.preventDefault();
    if (!dragged) return;
    const ids = moveBefore(
      lines.map((l) => l.id),
      dragged,
      targetId,
    );
    setDragged(null);
    if (ids.join() !== lines.map((l) => l.id).join()) saveOrder(ids);
  }

  function setMode(includesVat: boolean) {
    setError(null);
    startTransition(async () => {
      const outcome = await setQuoteVatModeAction(orgId, quote.id, includesVat);
      if (!outcome.ok) setError(outcome.message);
    });
  }

  return (
    <div className="space-y-5">
      <Card aria-labelledby="quote-lines-title">
        <CardHeader
          id="quote-lines-title"
          title="שורות"
          action={
            canEdit && !full ? (
              <span className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => setGroup("new")}>
                  קבוצה
                </Button>
                <Button size="sm" onClick={() => setEditing("new")}>
                  <PlusIcon className="size-4" />
                  שורה
                </Button>
              </span>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          <FormError message={error} />
          {canEdit && itemCount === 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-soft">המחירים בהצעה:</span>
              <Button size="sm" variant={quote.pricesIncludeVat ? "ghost" : "secondary"} aria-pressed={!quote.pricesIncludeVat} disabled={pending} onClick={() => setMode(false)}>
                לפני מע&quot;מ
              </Button>
              <Button
                size="sm"
                variant={quote.pricesIncludeVat ? "secondary" : "ghost"}
                aria-pressed={quote.pricesIncludeVat}
                disabled={pending || quote.noVatReason !== null || pricing.vat.kind === "none"}
                onClick={() => setMode(true)}
              >
                כולל מע&quot;מ
              </Button>
            </div>
          ) : null}
          {lines.length === 0 ? (
            <p className="text-md text-ink-soft">{canEdit ? "עוד אין שורות. מוסיפים מוצר מהקטלוג, שורה חופשית, או כותרת לקבוצת שורות." : "עוד אין שורות בהצעה."}</p>
          ) : (
            <ol aria-label="שורות ההצעה" className="space-y-2" onDragOver={(event) => dragged && event.preventDefault()} onDrop={(event) => onDrop(event, null)}>
              {lines.map((line, index) => {
                const handlers = canEdit
                  ? {
                      draggable: true,
                      onDragStart: (event: DragEvent) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDragged(line.id);
                      },
                      onDragOver: (event: DragEvent) => {
                        if (dragged) event.preventDefault();
                      },
                      onDrop: (event: DragEvent) => {
                        event.stopPropagation();
                        onDrop(event, line.id);
                      },
                      onDragEnd: () => setDragged(null),
                    }
                  : {};
                const tools = canEdit ? (
                  <span className="flex flex-wrap items-center">
                    <ReorderButtons name={line.name} first={index === 0} last={index === lines.length - 1} disabled={pending} onMove={(d) => move(line, d)} />
                    <Button variant="ghost" size="sm" onClick={() => (line.kind === "group" ? setGroup(line) : setEditing(line))} aria-label={`עריכה: ${line.name}`}>
                      עריכה
                    </Button>
                    <ConfirmButton
                      title={`למחוק את "${line.name}"?`}
                      description={line.kind === "group" ? "רק הכותרת נמחקת. השורות שמתחתיה נשארות." : undefined}
                      confirmLabel="מחיקה"
                      action={() => deleteQuoteLineAction(orgId, quote.id, line.id)}
                    >
                      מחיקה
                    </ConfirmButton>
                  </span>
                ) : null;
                if (line.kind === "group") {
                  return (
                    <li
                      key={line.id}
                      {...handlers}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-md border-b-2 border-line-strong pt-3 pb-1 ${dragged === line.id ? "opacity-60" : ""}`}
                    >
                      <h3 className="min-w-0 flex-1 text-base font-semibold break-words">
                        <bdi>{line.name}</bdi>
                      </h3>
                      <span className="text-sm tabular-nums text-ink-soft">{formatMoney(sums.get(line.id) ?? 0)}</span>
                      {tools}
                    </li>
                  );
                }
                const discountText = lineDiscountText(line);
                return (
                  <li
                    key={line.id}
                    {...handlers}
                    className={`flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-md border border-line bg-surface p-3 ${dragged === line.id ? "opacity-60" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium break-words">
                        <bdi>{line.name}</bdi>
                        {line.productId !== null && archivedProducts.includes(line.productId) ? (
                          <Badge className="ms-2" tone="warning">
                            המוצר בארכיון
                          </Badge>
                        ) : null}
                        {line.isOptional ? (
                          <Badge className="ms-2" tone={line.optionalSelected ? "success" : undefined}>
                            {line.optionalSelected ? "רשות, מסומנת" : "רשות"}
                          </Badge>
                        ) : null}
                      </p>
                      {line.description ? <p className="text-sm whitespace-pre-line text-ink-soft break-words">{line.description}</p> : null}
                      <p className="text-sm text-ink-soft">
                        <span dir="ltr" className="tabular-nums">
                          {formatNumber(line.quantity)}
                        </span>
                        {line.unitName ? ` ${line.unitName}` : ""}
                        {" × "}
                        <span className="tabular-nums">{formatMoney(line.unitPriceAgorot)}</span>
                        {discountText ? `, ${discountText}` : ""}
                        {line.vatExempt && pricing.vat.kind === "rate" ? ', פטור ממע"מ' : ""}
                        {line.billing !== "one_time" ? `, ${BILLING_LABELS[line.billing]}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <span className={`me-1 font-semibold tabular-nums ${isCounted(line) ? "" : "text-ink-soft line-through"}`}>{formatMoney(line.totalAgorot)}</span>
                      {tools}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {canEdit && lines.length > 1 ? <p className="text-sm text-ink-soft">אפשר לגרור שורה למקום אחר, או להזיז אותה בחיצים.</p> : null}
          {canEdit && full ? <p className="text-sm text-ink-soft">{`בהצעה יש ${QUOTE_LINES_MAX} שורות, המספר המרבי.`}</p> : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="quote-summary-title">
        <CardHeader id="quote-summary-title" title="סיכום" />
        <CardBody className="space-y-2">
          {totals.ok ? (
            <dl className="space-y-1 text-md">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-soft">סכום השורות ({vatWord})</dt>
                <dd className="tabular-nums">{formatMoney(totals.totals.subtotalAgorot)}</dd>
              </div>
              {totals.totals.documentDiscountAgorot > 0 ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">הנחה על ההצעה</dt>
                  <dd className="tabular-nums">−{formatMoney(totals.totals.documentDiscountAgorot)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-soft">לפני מע&quot;מ</dt>
                <dd className="tabular-nums">{formatMoney(totals.totals.netTotalAgorot)}</dd>
              </div>
              {noVat || pricing.vat.kind !== "rate" ? null : (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">מע&quot;מ {vatRateLabel(pricing.vat.rateBp)}</dt>
                  <dd className="tabular-nums">{formatMoney(totals.totals.vatAgorot)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
                <dt>סה&quot;כ לתשלום</dt>
                <dd className="tabular-nums">{formatMoney(totals.totals.totalAgorot)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-danger">ההנחה על ההצעה גדולה מסכום השורות. הקטינו אותה כדי לראות סיכום.</p>
          )}
          {noVat && reason !== "" ? <p className="text-sm text-ink-soft">{noVatText(reason, quote.noVatNote)}</p> : null}
          {optionalOut > 0 ? <p className="text-sm text-ink-soft">{optionalOut === 1 ? "שורת רשות אחת לא נספרת בסיכום." : `${optionalOut} שורות רשות לא נספרות בסיכום.`}</p> : null}
          {vatMissing ? <p className="text-sm text-ink-soft">{vatMissing}</p> : null}
        </CardBody>
      </Card>

      <Card aria-labelledby="quote-details-title">
        <CardHeader id="quote-details-title" title="פרטי ההצעה" />
        <CardBody>
          {canEdit ? (
            <form action={formAction} className="space-y-4" noValidate>
              <FormGuard state={state} />
              <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
              {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
              <TextField label="כותרת" name="title" required maxLength={QUOTE_TITLE_MAX} defaultValue={failure?.values?.title ?? quote.title} error={errors.title} />
              <DateField
                label="בתוקף עד"
                name="valid_until"
                defaultValue={failure?.values?.valid_until ?? quote.validUntil ?? ""}
                min={quote.quoteDate}
                hint={`תאריך ההצעה: ${formatDate(quote.quoteDate)}`}
                error={errors.valid_until}
                className="sm:max-w-xs"
              />
              {features.discounts || startKind !== "" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField label="הנחה על ההצעה" name="discount_kind" value={discountKind} onChange={(event) => setDiscountKind(event.target.value as DiscountKind | "")}>
                    <option value="">{DISCOUNT_KIND_LABELS[""]}</option>
                    {DISCOUNT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {DISCOUNT_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </SelectField>
                  {discountKind !== "" ? (
                    <TextField
                      label={discountKind === "percent" ? "אחוז הנחה" : `סכום הנחה (₪, ${vatWord})`}
                      name="discount"
                      required
                      dir="ltr"
                      inputMode="decimal"
                      autoComplete="off"
                      value={discount}
                      onChange={(event) => setDiscount(event.target.value)}
                      error={errors.discount}
                    />
                  ) : null}
                </div>
              ) : (
                <input type="hidden" name="discount_kind" value="" />
              )}
              {chargesVat ? (
                <fieldset className="space-y-3">
                  <input type="hidden" name="no_vat_shown" value="1" />
                  <Checkbox
                    label='הצעה זו בלי מע"מ'
                    hint={quote.pricesIncludeVat && itemCount > 0 ? 'אפשר רק בהצעה שהמחירים בה לפני מע"מ.' : 'למשל לקוח באילת או בחו"ל. הסיבה מופיעה בהצעה.'}
                    checked={noVat}
                    disabled={quote.pricesIncludeVat && itemCount > 0}
                    onChange={(event) => setNoVat(event.target.checked)}
                  />
                  {noVat ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <SelectField label="סיבה" name="no_vat_reason" required value={reason} onChange={(event) => setReason(event.target.value as NoVatReason | "")} error={errors.no_vat_reason}>
                        <option value="">בחירה</option>
                        {NO_VAT_REASONS.map((value) => (
                          <option key={value} value={value}>
                            {NO_VAT_REASON_LABELS[value]}
                          </option>
                        ))}
                      </SelectField>
                      {reason === "other" ? (
                        <TextField label="הסיבה" name="no_vat_note" required maxLength={NO_VAT_NOTE_MAX} defaultValue={quote.noVatNote ?? ""} error={errors.no_vat_note} />
                      ) : null}
                    </div>
                  ) : (
                    <input type="hidden" name="no_vat_reason" value="" />
                  )}
                </fieldset>
              ) : null}
              <TextareaField label="הערות ללקוח" name="notes" rows={3} maxLength={QUOTE_NOTES_MAX} defaultValue={quote.notes ?? ""} error={errors.notes} />
              <TextareaField label="תנאים" name="terms" rows={4} maxLength={QUOTE_TERMS_MAX} defaultValue={quote.terms ?? ""} hint="תנאי תשלום ותנאים כלליים." error={errors.terms} />
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton pendingText="שומרים…">שמירת טיוטה</SubmitButton>
                <ConfirmButton
                  title="למחוק את הטיוטה?"
                  description="ההצעה והשורות שלה יימחקו. אי אפשר לשחזר."
                  confirmLabel="מחיקה"
                  action={() => deleteQuoteAction(orgId, quote.id)}
                >
                  מחיקת הטיוטה
                </ConfirmButton>
              </div>
            </form>
          ) : (
            <dl className="space-y-2 text-md">
              <div>
                <dt className="text-sm text-ink-soft">בתוקף עד</dt>
                <dd>{quote.validUntil ? formatDate(quote.validUntil) : "לא נקבע"}</dd>
              </div>
              {quote.notes ? (
                <div>
                  <dt className="text-sm text-ink-soft">הערות ללקוח</dt>
                  <dd className="whitespace-pre-line">{quote.notes}</dd>
                </div>
              ) : null}
              {quote.terms ? (
                <div>
                  <dt className="text-sm text-ink-soft">תנאים</dt>
                  <dd className="whitespace-pre-line">{quote.terms}</dd>
                </div>
              ) : null}
            </dl>
          )}
        </CardBody>
      </Card>

      {canEdit ? (
        <>
          <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "שורה חדשה" : "עריכת שורה"} variant="sheet"
            description={pricing.list && editing === "new" ? `מחירון הלקוח: ${pricing.list.name}` : undefined}>
            {editing !== null ? (
              <QuoteLineForm
                key={editing === "new" ? "new" : editing.id}
                orgId={orgId}
                quoteId={quote.id}
                pricing={pricing}
                line={editing === "new" ? null : editing}
                features={features}
                onDone={() => setEditing(null)}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </Dialog>
          <Dialog open={group !== null} onClose={() => setGroup(null)} title={group === "new" ? "קבוצה חדשה" : "עריכת כותרת"}>
            {group !== null ? <GroupForm key={group === "new" ? "new" : group.id} orgId={orgId} quoteId={quote.id} line={group === "new" ? null : group} onDone={() => setGroup(null)} /> : null}
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

function GroupForm({ orgId, quoteId, line, onDone }: { orgId: string; quoteId: string; line: QuoteLine | null; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveQuoteGroupAction(orgId, quoteId, line?.id ?? null, prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField
        label="כותרת הקבוצה"
        name="name"
        required
        maxLength={QUOTE_LINE_NAME_MAX}
        defaultValue={failure?.values?.name ?? line?.name ?? ""}
        hint={line ? undefined : "הכותרת נוספת בסוף ההצעה. השורות שאחריה שייכות לקבוצה, ואפשר לגרור אותה למקום אחר."}
        error={failure?.fieldErrors?.name}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">{line ? "שמירה" : "הוספת הקבוצה"}</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
