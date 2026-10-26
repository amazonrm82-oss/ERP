"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, Input, Label, SelectField, TextField } from "@/components/ui/field";
import { TrashIcon } from "@/components/ui/icons";
import type { SearchPickerChoice } from "@/components/ui/search-picker";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { ContactPicker } from "@/features/contacts/components/contact-picker";
import { searchDealProductsAction, type ProductHit } from "@/features/deal-lines/actions";
import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";
import { PAYMENT_INSTALLMENTS_MAX, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_REFERENCE_MAX } from "@/features/payments/schema";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";
import { paths } from "@/lib/paths";

import { previewQuickSaleAction, quickSaleAction, quickSaleHoldsAction, type QuickSaleDone, type QuickSalePreview } from "../actions";
import { QUICK_SALE_DOC_TYPES, QUICK_SALE_MAX_ITEMS } from "../sale";
import { ChequeRows } from "./cheque-rows";

type Item = { productId: string; name: string; quantity: number };

type Props = {
  orgId: string;
  today: string;
  // the business's words (FLD-10): a contact, and the links to the new deal's and contact's cards
  customerLabel: string;
  dealCardLabel: string;
  contactCardLabel: string;
  // documents in the plan and the right to record them (DOC-01)
  canDocument: boolean;
};

/**
 * GAP-08: "מכירה מהירה": customer, items, payment method, done. The prices and the total come from the server
 * (previewQuickSaleAction, the deal-lines rule), and the sale sends the total it showed, so a price that changed meanwhile
 * is refused instead of charged.
 */
export function QuickSaleForm(props: Props) {
  // a new sale starts from a clean form (a fresh key)
  const [round, setRound] = useState(0);
  return <SaleForm key={round} {...props} onAgain={() => setRound((n) => n + 1)} />;
}

function SaleForm({ orgId, today, customerLabel, dealCardLabel, contactCardLabel, canDocument, onAgain }: Props & { onAgain: () => void }) {
  const [state, formAction] = useActionState<FormState<QuickSaleDone>, FormData>(quickSaleAction.bind(null, orgId), null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [contact, setContact] = useState<SearchPickerChoice>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [method, setMethod] = useState("");
  const [withDocument, setWithDocument] = useState(false);
  const [preview, setPreview] = useState<{ key: string; result: QuickSalePreview | null; error: string | null } | null>(null);
  const [, startPreview] = useTransition();
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  const contactId = mode === "existing" ? (contact?.id ?? null) : null;
  const previewKey = JSON.stringify([contactId, items.map((i) => [i.productId, i.quantity])]);
  useEffect(() => {
    if (items.length === 0) return;
    const timer = setTimeout(() => {
      startPreview(async () => {
        const answer = await previewQuickSaleAction(
          orgId,
          contactId,
          items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        );
        setPreview({ key: previewKey, result: answer.ok ? (answer.data ?? null) : null, error: answer.ok ? null : answer.message });
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [orgId, contactId, items, previewKey]);
  const current = items.length > 0 && preview?.key === previewKey ? preview : null;

  // COL-05: a held customer is warned about, never refused
  const [holds, setHolds] = useState<{ contactId: string; texts: string[] } | null>(null);
  useEffect(() => {
    if (!contactId) return;
    let live = true;
    quickSaleHoldsAction(orgId, contactId).then((texts) => {
      if (live) setHolds({ contactId, texts });
    });
    return () => {
      live = false;
    };
  }, [orgId, contactId]);
  const holdTexts = contactId && holds?.contactId === contactId ? holds.texts : [];

  if (state?.ok && state.data) {
    const done = state.data;
    return (
      <Card>
        <CardBody className="space-y-4">
          <p role="status" className="text-lg font-semibold">
            המכירה נרשמה: {formatMoney(done.totalAgorot)}
          </p>
          <p className="text-ink-soft">{done.documentId ? "נרשמו התשלום והמסמך." : "נרשם התשלום."}</p>
          <div className="flex flex-wrap gap-2">
            <Link href={paths.deal(orgId, done.dealId)} className="inline-flex min-h-11 items-center rounded-md border border-line px-4 hover:bg-canvas">
              {dealCardLabel}
            </Link>
            <Link href={paths.contact(orgId, done.contactId)} className="inline-flex min-h-11 items-center rounded-md border border-line px-4 hover:bg-canvas">
              {contactCardLabel}
            </Link>
            <Button onClick={onAgain}>מכירה חדשה</Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />

      <Card>
        <CardBody className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="mb-2 font-semibold">{customerLabel}</legend>
            <input type="hidden" name="customer_mode" value={mode} />
            <div className="flex flex-wrap gap-2" role="group" aria-label="בחירת לקוח">
              <Button variant={mode === "existing" ? "primary" : "secondary"} size="sm" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>
                קיים
              </Button>
              <Button variant={mode === "new" ? "primary" : "secondary"} size="sm" aria-pressed={mode === "new"} onClick={() => setMode("new")}>
                חדש
              </Button>
            </div>
            {mode === "existing" ? (
              <>
                <ContactPicker orgId={orgId} label={`חיפוש ${customerLabel}`} name="contact_id" initial={contact} onChange={setContact} required error={errors.contact_id} />
                {holdTexts.length > 0 ? (
                  <div role="status" className="space-y-1 rounded-md bg-warning-soft px-3 py-2.5 text-sm break-words text-warning">
                    {holdTexts.map((text) => (
                      <p key={text}>{text}</p>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField label="שם פרטי" name="first_name" required maxLength={100} defaultValue={failure?.values?.first_name ?? ""} error={errors.first_name} />
                <TextField label="שם משפחה" name="last_name" maxLength={100} defaultValue={failure?.values?.last_name ?? ""} error={errors.last_name} />
                <TextField label="טלפון" name="phone" type="tel" dir="ltr" defaultValue={failure?.values?.phone ?? ""} error={errors.phone} />
                {errors.duplicate ? (
                  // DQL-02: the phone belongs to a record the user sees; sell to that contact, or make the new one anyway
                  <div role="alert" className="space-y-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning sm:col-span-3">
                    <p>
                      {errors.duplicate}{" "}
                      {errors.duplicate_href ? (
                        <Link href={errors.duplicate_href} className="underline underline-offset-4">
                          פתיחה
                        </Link>
                      ) : null}
                    </p>
                    {errors.duplicate_id ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setContact({ id: errors.duplicate_id, label: errors.duplicate_name ?? "" });
                          setMode("existing");
                        }}
                      >
                        מכירה ל{customerLabel} הקיים
                      </Button>
                    ) : null}
                    <Checkbox name="allow_duplicate" label="ליצור בכל זאת חדש" />
                  </div>
                ) : null}
              </div>
            )}
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <h2 className="font-semibold">פריטים</h2>
          <input type="hidden" name="items" value={JSON.stringify(items.map((i) => ({ productId: i.productId, quantity: i.quantity })))} />
          {items.length > 0 ? (
            <ul className="divide-y divide-line rounded-md border border-line">
              {items.map((item, index) => {
                const line = current?.result?.lines[index];
                return (
                  <li key={`${item.productId}-${index}`} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <bdi className="font-medium">{item.name}</bdi>
                      {line ? (
                        <span className="block text-sm text-ink-soft">
                          {formatMoney(line.unitPriceAgorot)} ליחידה{line.fromList ? " (מחירון הלקוח)" : ""}
                        </span>
                      ) : null}
                    </span>
                    <QuantityInput
                      value={item.quantity}
                      label={`כמות של ${item.name}`}
                      onChange={(quantity) => setItems((all) => all.map((it, i) => (i === index ? { ...it, quantity } : it)))}
                    />
                    <Button variant="ghost" size="sm" aria-label={`הסרת ${item.name}`} onClick={() => setItems((all) => all.filter((_, i) => i !== index))}>
                      <TrashIcon className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {errors.items ? <p className="text-sm text-danger">{errors.items}</p> : null}
          {items.length < QUICK_SALE_MAX_ITEMS ? (
            <ProductSearch orgId={orgId} onPick={(hit) => setItems((all) => [...all, { productId: hit.id, name: hit.name, quantity: 1 }])} />
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <h2 className="font-semibold">תשלום</h2>
          <SelectField label="אמצעי תשלום" name="method" required value={method} onChange={(event) => setMethod(event.target.value)} error={errors.method}>
            <option value="">בחירה</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </SelectField>
          {method === "credit" ? (
            <TextField
              label="מספר תשלומים"
              name="installments"
              dir="ltr"
              inputMode="numeric"
              defaultValue={failure?.values?.installments ?? "1"}
              hint={`1 עד ${PAYMENT_INSTALLMENTS_MAX}.`}
              error={errors.installments}
            />
          ) : null}
          {method === "cheque" ? <ChequeRows today={today} totalAgorot={current?.result?.totalAgorot ?? null} error={errors.cheques} /> : null}
          {method === "cash" ? <p className="text-sm text-ink-soft">תשלום במזומן נרשם כמאושר.</p> : null}
          <TextField
            label="אסמכתא"
            name="reference"
            dir="ltr"
            maxLength={PAYMENT_REFERENCE_MAX}
            defaultValue={failure?.values?.reference ?? ""}
            hint="לא חובה. מספר אישור או מספר העברה."
            error={errors.reference}
          />
          {canDocument ? (
            <>
              <Checkbox
                name="record_document"
                label="רישום מסמך שהופק"
                hint="חשבונית או קבלה שהופקה בתוכנה אחרת. נרשם באותו סכום."
                checked={withDocument}
                onChange={(event) => setWithDocument(event.target.checked)}
              />
              {withDocument ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField label="סוג המסמך" name="doc_type" required defaultValue={failure?.values?.doc_type ?? "tax_invoice_receipt"} error={errors.doc_type}>
                    {QUICK_SALE_DOC_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {DOCUMENT_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </SelectField>
                  <TextField label="מספר המסמך" name="doc_number" required dir="ltr" maxLength={40} defaultValue={failure?.values?.doc_number ?? ""} error={errors.doc_number} />
                </div>
              ) : null}
            </>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <input type="hidden" name="expected_total" value={current?.result ? String(current.result.totalAgorot) : ""} />
          <div aria-live="polite">
            {items.length === 0 ? (
              <p className="text-ink-soft">הוסיפו פריט כדי לראות את הסכום.</p>
            ) : current?.error ? (
              <p className="text-danger">{current.error}</p>
            ) : current?.result ? (
              <dl className="space-y-1">
                <div className="flex justify-between gap-3 text-ink-soft">
                  <dt>לפני מע&quot;מ</dt>
                  <dd>{formatMoney(current.result.netAgorot)}</dd>
                </div>
                <div className="flex justify-between gap-3 text-ink-soft">
                  <dt>מע&quot;מ</dt>
                  <dd>{formatMoney(current.result.vatAgorot)}</dd>
                </div>
                <div className="flex justify-between gap-3 text-lg font-semibold">
                  <dt>לתשלום</dt>
                  <dd>{formatMoney(current.result.totalAgorot)}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-ink-soft">מחשבים…</p>
            )}
          </div>
          <SubmitButton pendingText="רושמים…" disabled={!current?.result}>
            סיום
          </SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}

function QuantityInput({ value, label, onChange }: { value: number; label: string; onChange: (quantity: number) => void }) {
  const [text, setText] = useState(String(value));
  return (
    <Input
      aria-label={label}
      className="w-20"
      dir="ltr"
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const n = Number(event.target.value);
        if (Number.isFinite(n) && n > 0 && n <= 1_000_000 && Math.round(n * 1000) === n * 1000) onChange(n);
      }}
    />
  );
}

/** Offerable one-time products by name, SKU or barcode (a recurring product is sold through a deal). */
function ProductSearch({ orgId, onPick }: { orgId: string; onPick: (hit: ProductHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [answered, setAnswered] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();

  useEffect(() => {
    const q = query.trim();
    const timer = setTimeout(
      () => {
        startTransition(async () => {
          const found = await searchDealProductsAction(orgId, q, null);
          setHits(found.filter((hit) => hit.billing === "one_time"));
          setAnswered(q);
        });
      },
      q === "" ? 0 : 200,
    );
    return () => clearTimeout(timer);
  }, [query, orgId]);

  const q = query.trim();
  return (
    <div>
      <Label htmlFor={inputId}>הוספת פריט</Label>
      <Input
        id={inputId}
        type="search"
        value={query}
        autoComplete="off"
        placeholder='חיפוש לפי שם, מק"ט או ברקוד'
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <p aria-live="polite" className="text-sm text-ink-soft empty:hidden">
        {!pending && answered === q && hits.length === 0 ? (q === "" ? "אין עדיין מוצרים פעילים בקטלוג." : "לא נמצא מוצר מתאים.") : ""}
      </p>
      {hits.length > 0 ? (
        <ul aria-label="מוצרים שנמצאו" className="mt-1 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-canvas"
                onClick={() => {
                  onPick(hit);
                  setQuery("");
                }}
              >
                <bdi className="min-w-0 font-medium text-accent-strong">{hit.name}</bdi>
                <span className="shrink-0 text-sm text-ink-soft">{formatMoney(hit.priceAgorot)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
