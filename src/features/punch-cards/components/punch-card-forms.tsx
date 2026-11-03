"use client";

import { useActionState, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField } from "@/components/ui/field";
import type { SearchPickerChoice } from "@/components/ui/search-picker";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { ContactPicker } from "@/features/contacts/components/contact-picker";
import { RefundForm } from "@/features/payments/components/refund-forms";
import type { PaymentMethod } from "@/features/payments/schema";
import type { FormState } from "@/lib/action-result";

import {
  activatePunchCardAction,
  cancelPunchCardAction,
  openPunchCardAction,
  returnPunchUseAction,
  transferPunchCardAction,
} from "../actions";
import { moneyInput, PUNCH_REASON_MAX } from "../balance";

type Choice = { id: string; label: string };
type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Failure = Extract<Exclude<FormState, null>, { ok: false }>;

/** A button that opens a sheet with one form; the sheet closes when the action succeeds. */
function DialogForm({
  label,
  title,
  action,
  submit,
  pending,
  variant = "secondary",
  children,
}: {
  label: string;
  title: string;
  action: Action;
  submit: string;
  pending: string;
  variant?: "secondary" | "ghost";
  children: (failure: Failure | null) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} variant="sheet">
        {open ? <Inner action={action} submit={submit} pending={pending} onDone={() => setOpen(false)} onCancel={() => setOpen(false)}>{children}</Inner> : null}
      </Dialog>
    </>
  );
}

function Inner({
  action,
  submit,
  pending,
  onDone,
  onCancel,
  children,
}: {
  action: Action;
  submit: string;
  pending: string;
  onDone: () => void;
  onCancel: () => void;
  children: (failure: Failure | null) => ReactNode;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      {children(failure)}
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText={pending}>{submit}</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

function ReasonField({ failure, label = "נימוק" }: { failure: Failure | null; label?: string }) {
  return (
    <TextareaField
      label={label}
      name="reason"
      required
      rows={3}
      maxLength={PUNCH_REASON_MAX}
      defaultValue={failure?.values?.reason ?? ""}
      error={failure?.fieldErrors?.reason}
    />
  );
}

/** PKG-01: "פתיחת כרטיסייה" for the contact. */
export function OpenPunchCardButton({
  orgId,
  contactId,
  products,
  payments,
  isAdmin,
}: {
  orgId: string;
  contactId: string;
  products: Choice[];
  payments: Choice[];
  isAdmin: boolean;
}) {
  const [payment, setPayment] = useState("");
  return (
    <DialogForm label="פתיחת כרטיסייה" title="פתיחת כרטיסייה" action={openPunchCardAction.bind(null, orgId, contactId)} submit="פתיחה" pending="פותחים…">
      {(failure) => (
        <>
          <p className="text-md">
            כרטיסייה נפתחת כשנרשם עליה תשלום. בלי תשלום היא ממתינה, ואפשר לקשר אליה תשלום אחר כך.
          </p>
          <SelectField label="כרטיסייה" name="product_id" required defaultValue={failure?.values?.product_id ?? ""} error={failure?.fieldErrors?.product_id}>
            <option value="">בחרו כרטיסייה</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </SelectField>
          <SelectField label="תשלום" name="payment_id" value={payment} onChange={(event) => setPayment(event.target.value)} hint="תשלום שנרשם לאיש הקשר הזה.">
            <option value="">בלי תשלום (ממתינה)</option>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </SelectField>
          {isAdmin && payment === "" ? (
            <Checkbox name="activate" label="להפעיל עכשיו בלי תשלום" hint="מותר לבעלים ולמנהלי מערכת." />
          ) : null}
        </>
      )}
    </DialogForm>
  );
}

/** PKG-01: a waiting card gets a payment, or is activated by hand (owners/admins). */
export function ActivatePunchCardButton({
  orgId,
  contactId,
  cardId,
  payments,
  isAdmin,
  canSell,
}: {
  orgId: string;
  contactId: string;
  cardId: string;
  payments: Choice[];
  isAdmin: boolean;
  canSell: boolean;
}) {
  return (
    <DialogForm label="הפעלה" title="הפעלת כרטיסייה" action={activatePunchCardAction.bind(null, orgId, contactId, cardId)} submit="הפעלה" pending="מפעילים…">
      {() => (
        <SelectField
          label="תשלום"
          name="payment_id"
          defaultValue={canSell && payments[0] ? payments[0].id : ""}
          hint={isAdmin ? "בלי תשלום, הכרטיסייה מופעלת ידנית." : "בחרו את התשלום שנרשם עליה."}
        >
          {isAdmin ? <option value="">בלי תשלום (הפעלה ידנית)</option> : null}
          {canSell
            ? payments.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))
            : null}
        </SelectField>
      )}
    </DialogForm>
  );
}

/**
 * PKG-01: cancelling a card (owners/admins), with a reason. Owner (84) ב: when the card has a payment, the refund form
 * opens next with the unused part filled in (unused entries / all entries x what the card was sold for); the person may
 * change it or close without a refund. The refund is an ordinary PAY-08 refund on the card's payment.
 */
export function CancelPunchCardButton({
  orgId,
  contactId,
  cardId,
  remaining,
  refund,
  today,
}: {
  orgId: string;
  contactId: string;
  cardId: string;
  remaining: number;
  refund: { paymentId: string; method: PaymentMethod; suggestedAgorot: number } | null;
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"cancel" | "refund">("cancel");
  const close = () => {
    setOpen(false);
    setStep("cancel");
  };
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        ביטול
      </Button>
      <Dialog open={open} onClose={close} title={step === "cancel" ? "ביטול כרטיסייה" : "החזר על הכניסות שלא נוצלו"} variant="sheet">
        {open && step === "cancel" ? (
          <Inner
            action={cancelPunchCardAction.bind(null, orgId, contactId, cardId)}
            submit="ביטול הכרטיסייה"
            pending="מבטלים…"
            onDone={() => (refund ? setStep("refund") : close())}
            onCancel={close}
          >
            {(failure) => (
              <>
                <p className="text-md">
                  {remaining === 1 ? "נשארה בה כניסה אחת שלא נוצלה." : `נשארו בה ${remaining} כניסות שלא נוצלו.`}{" "}
                  {refund ? "אחרי הביטול נפתח טופס החזר עם החלק שלא נוצל. אפשר לשנות את הסכום או לסגור בלי החזר." : "לכרטיסייה אין תשלום, ולכן אין החזר."}
                </p>
                <ReasonField failure={failure} />
              </>
            )}
          </Inner>
        ) : null}
        {open && step === "refund" && refund ? (
          <RefundForm
            orgId={orgId}
            subject={{ kind: "contact", id: contactId }}
            paymentId={refund.paymentId}
            method={refund.method}
            today={today}
            creditDocuments={[]}
            defaultAmount={refund.suggestedAgorot > 0 ? moneyInput(refund.suggestedAgorot) : ""}
            onDone={close}
            onCancel={close}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** PKG-01: moving a card to another contact (owners/admins). */
export function TransferPunchCardButton({ orgId, contactId, cardId }: { orgId: string; contactId: string; cardId: string }) {
  const [target, setTarget] = useState<SearchPickerChoice>(null);
  return (
    <DialogForm label="העברה" title="העברת כרטיסייה ללקוח אחר" variant="ghost" action={transferPunchCardAction.bind(null, orgId, contactId, cardId)} submit="העברה" pending="מעבירים…">
      {(failure) => (
        <ContactPicker
          orgId={orgId}
          label="איש הקשר שיקבל את הכרטיסייה"
          name="to_contact_id"
          initial={target}
          onChange={setTarget}
          exclude={[contactId]}
          required
          error={failure?.fieldErrors?.to_contact_id}
        />
      )}
    </DialogForm>
  );
}

/** PKG-02: giving a used entry back (owners, admins, managers), with a reason. */
export function ReturnPunchUseButton({ orgId, contactId, useId }: { orgId: string; contactId: string; useId: string }) {
  return (
    <DialogForm label="החזרת כניסה" title="החזרת כניסה" variant="ghost" action={returnPunchUseAction.bind(null, orgId, contactId, useId)} submit="החזרה" pending="מחזירים…">
      {(failure) => <ReasonField failure={failure} label="למה הכניסה מוחזרת" />}
    </DialogForm>
  );
}
