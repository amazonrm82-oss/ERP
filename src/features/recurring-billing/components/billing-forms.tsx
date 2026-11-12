"use client";

import { useActionState, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatDate } from "@/lib/format";

import {
  addBillingLineAction,
  cancelBillingAction,
  createBillingAction,
  createBillingFromDealAction,
  deleteBillingLineAction,
  linkCycleDocumentAction,
  pauseBillingAction,
  resumeBillingAction,
  setCycleStatusAction,
  updateBillingAction,
} from "../actions";
import { BILLING_NAME_MAX, CANCEL_REASON_MAX, COMMITMENT_MONTHS_MAX } from "../schema";
import { CYCLE_LABELS, CYCLES } from "../schedule";

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
  variant?: "primary" | "secondary" | "ghost";
  children: (failure: Failure | null) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} variant="sheet">
        {open ? (
          <InlineForm action={action} submit={submit} pending={pending} onDone={() => setOpen(false)} onCancel={() => setOpen(false)}>
            {children}
          </InlineForm>
        ) : null}
      </Dialog>
    </>
  );
}

function InlineForm({
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
  onDone?: () => void;
  onCancel?: () => void;
  children: (failure: Failure | null) => ReactNode;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone?.();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      {children(failure)}
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText={pending}>{submit}</SubmitButton>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            ביטול
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function ScheduleFields({
  failure,
  values,
}: {
  failure: Failure | null;
  values: { name?: string; billingDay?: number; endDate?: string | null; commitmentMonths?: number };
}) {
  const v = failure?.values;
  return (
    <>
      <TextField label="שם החיוב" name="name" required maxLength={BILLING_NAME_MAX} defaultValue={v?.name ?? values.name ?? ""} error={failure?.fieldErrors?.name} />
      <SelectField label="יום החיוב בחודש" name="billing_day" required defaultValue={v?.billing_day ?? String(values.billingDay ?? 1)} error={failure?.fieldErrors?.billing_day}>
        {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
          <option key={day} value={String(day)}>
            {day}
          </option>
        ))}
        <option value="0">היום האחרון בחודש</option>
      </SelectField>
      <TextField
        label="תאריך סיום"
        name="end_date"
        type="date"
        hint="ריק = עד הודעה חדשה"
        defaultValue={v?.end_date ?? values.endDate ?? ""}
        error={failure?.fieldErrors?.end_date}
      />
      <TextField
        label="תקופת התחייבות (חודשים)"
        name="commitment_months"
        inputMode="numeric"
        hint={`0 = בלי התחייבות, עד ${COMMITMENT_MONTHS_MAX}`}
        defaultValue={v?.commitment_months ?? String(values.commitmentMonths ?? 0)}
        error={failure?.fieldErrors?.commitment_months}
      />
    </>
  );
}

/** SUB-01: "חיוב חוזר חדש" on a contact's or company's card. */
export function NewBillingButton({ orgId, customer, today }: { orgId: string; customer: { kind: "contact" | "company"; id: string }; today: string }) {
  return (
    <DialogForm label="חיוב חוזר חדש" title="חיוב חוזר חדש" action={createBillingAction.bind(null, orgId, customer)} submit="יצירה" pending="יוצרים…">
      {(failure) => (
        <>
          <SelectField label="מחזור" name="cycle" required defaultValue={failure?.values?.cycle ?? "monthly"} error={failure?.fieldErrors?.cycle}>
            {CYCLES.map((cycle) => (
              <option key={cycle} value={cycle}>
                {CYCLE_LABELS[cycle]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="תאריך התחלה"
            name="start_date"
            type="date"
            required
            defaultValue={failure?.values?.start_date ?? today}
            error={failure?.fieldErrors?.start_date}
          />
          <ScheduleFields failure={failure} values={{ billingDay: Number(today.slice(8, 10)) > 28 ? 0 : Number(today.slice(8, 10)) }} />
          <p className="text-sm text-ink-soft">את השורות (מוצרים מהקטלוג או שורות חופשיות) מוסיפים בדף החיוב.</p>
        </>
      )}
    </DialogForm>
  );
}

/** SUB-01: the editable details of a billing. */
export function EditBillingForm({
  orgId,
  billingId,
  values,
}: {
  orgId: string;
  billingId: string;
  values: { name: string; billingDay: number; endDate: string | null; commitmentMonths: number };
}) {
  return (
    <InlineForm action={updateBillingAction.bind(null, orgId, billingId)} submit="שמירה" pending="שומרים…">
      {(failure) => <ScheduleFields failure={failure} values={values} />}
    </InlineForm>
  );
}

/** SUB-04: pause, resume and cancel. */
export function BillingStatusActions({
  orgId,
  billingId,
  status,
  commitmentEnd,
  canResume,
}: {
  orgId: string;
  billingId: string;
  status: string;
  // the commitment's last day when today is inside it (shown in the cancel window), else null
  commitmentEnd: string | null;
  // without the plan key a recorder may still pause and cancel, not resume
  canResume: boolean;
}) {
  if (status === "cancelled") return null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {status === "active" ? (
        <ConfirmButton
          variant="secondary"
          title="להשהות את החיוב?"
          description="בזמן ההשהיה לא נוצרים מחזורים ומשימות. בחידוש המחזור הבא הוא תאריך החיוב הראשון מהיום."
          confirmLabel="השהיה"
          action={() => pauseBillingAction(orgId, billingId)}
        >
          השהיה
        </ConfirmButton>
      ) : canResume ? (
        <DialogForm label="חידוש" title="חידוש החיוב" variant="primary" action={resumeBillingAction.bind(null, orgId, billingId)} submit="חידוש" pending="מחדשים…">
          {(failure) => (
            <fieldset className="space-y-2">
              <legend className="mb-1 font-medium">מה לעשות עם המחזורים שעברו בזמן העצירה?</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="make_up" value="no" defaultChecked={failure?.values?.make_up !== "yes"} className="mt-1" />
                <span>להמשיך מתאריך החיוב הבא, בלי ליצור את המחזורים שעברו</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="make_up" value="yes" defaultChecked={failure?.values?.make_up === "yes"} className="mt-1" />
                <span>ליצור את המחזורים שעברו מאז העצירה: לכל אחד משימה וטיוטת הזמנה (עד 24 המחזורים האחרונים)</span>
              </label>
              {failure?.fieldErrors?.make_up ? <p className="text-sm text-danger">{failure.fieldErrors.make_up}</p> : null}
            </fieldset>
          )}
        </DialogForm>
      ) : null}
      <DialogForm label="ביטול החיוב" title="ביטול החיוב החוזר" variant="ghost" action={cancelBillingAction.bind(null, orgId, billingId)} submit="ביטול החיוב" pending="מבטלים…">
        {(failure) => (
          <>
            {commitmentEnd ? (
              <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                הלקוח עדיין בתקופת ההתחייבות, עד {formatDate(commitmentEnd)}. אפשר לבטל, והביטול יירשם כביטול בתוך תקופת ההתחייבות.
              </p>
            ) : null}
            <p className="text-sm text-ink-soft">חיוב שבוטל לא משתנה יותר. המחזורים שכבר נוצרו נשארים.</p>
            <TextareaField
              label="סיבת הביטול"
              name="reason"
              required
              rows={3}
              maxLength={CANCEL_REASON_MAX}
              defaultValue={failure?.values?.reason ?? ""}
              error={failure?.fieldErrors?.reason}
            />
          </>
        )}
      </DialogForm>
    </span>
  );
}

/** SUB-01: a new line from the catalog or a free line. */
export function AddLineButton({ orgId, billingId, products }: { orgId: string; billingId: string; products: { id: string; name: string }[] }) {
  return (
    <DialogForm label="הוספת שורה" title="שורה בחיוב" action={addBillingLineAction.bind(null, orgId, billingId)} submit="הוספה" pending="מוסיפים…">
      {(failure) => (
        <>
          <SelectField label="מוצר מהקטלוג" name="product_id" defaultValue={failure?.values?.product_id ?? ""} error={failure?.fieldErrors?.product_id}>
            <option value="">שורה חופשית (בלי מוצר)</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </SelectField>
          <TextField label="תיאור" name="description" required maxLength={1000} defaultValue={failure?.values?.description ?? ""} error={failure?.fieldErrors?.description} />
          <TextField label="כמות" name="quantity" inputMode="decimal" defaultValue={failure?.values?.quantity ?? "1"} error={failure?.fieldErrors?.quantity} />
          <TextField
            label="מחיר ליחידה (₪)"
            name="unit_price"
            inputMode="decimal"
            hint="במוצר מהקטלוג, ריק = המחיר של הלקוח לפי המחירון, אחרת מחיר המוצר"
            defaultValue={failure?.values?.unit_price ?? ""}
            error={failure?.fieldErrors?.unit_price}
          />
          <input type="hidden" name="discount_kind" value="" />
        </>
      )}
    </DialogForm>
  );
}

export function DeleteLineButton({ orgId, billingId, lineId }: { orgId: string; billingId: string; lineId: string }) {
  return (
    <ConfirmButton title="למחוק את השורה?" description="השינוי חל מהמחזור הבא. מחזורים שכבר נוצרו לא משתנים." confirmLabel="מחיקה" action={() => deleteBillingLineAction(orgId, billingId, lineId)}>
      מחיקה
    </ConfirmButton>
  );
}

/** SUB-02: the document recorded for a cycle (an invoice or receipt of the customer). */
export function CycleDocumentForm({
  orgId,
  billingId,
  cycleId,
  documentId,
  documents,
}: {
  orgId: string;
  billingId: string;
  cycleId: string;
  documentId: string | null;
  documents: { id: string; label: string }[];
}) {
  return (
    <InlineForm action={linkCycleDocumentAction.bind(null, orgId, billingId, cycleId)} submit="שמירה" pending="שומרים…">
      {(failure) => (
        <SelectField label="המסמך שנרשם" hideLabel name="document_id" defaultValue={failure?.values?.document_id ?? documentId ?? ""}>
          <option value="">בלי מסמך</option>
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </SelectField>
      )}
    </InlineForm>
  );
}

export function SkipCycleButton({ orgId, billingId, cycleId, skipped }: { orgId: string; billingId: string; cycleId: string; skipped: boolean }) {
  return skipped ? (
    <ConfirmButton variant="secondary" title="להחזיר את המחזור להמתנה?" confirmLabel="החזרה" action={() => setCycleStatusAction(orgId, billingId, cycleId, "due")}>
      החזרה להמתנה
    </ConfirmButton>
  ) : (
    <ConfirmButton
      variant="secondary"
      title="לסמן שהמחזור דולג?"
      description="למשל חודש חינם. המשימה של המחזור נסגרת."
      confirmLabel="דילוג"
      action={() => setCycleStatusAction(orgId, billingId, cycleId, "skipped")}
    >
      דילוג
    </ConfirmButton>
  );
}

/** SUB-03: one click from a won deal with recurring lines. */
export function BillingFromDealButton({ orgId, dealId }: { orgId: string; dealId: string }) {
  return (
    <ConfirmButton
      variant="secondary"
      title="ליצור חיוב חוזר מהעסקה?"
      description="השורות החוזרות של העסקה מועתקות לחיוב חוזר חדש של הלקוח, עם המחירים שלהן. בכל מחזור תיווצר משימה להפקת מסמך."
      confirmLabel="יצירה"
      action={() => createBillingFromDealAction(orgId, dealId)}
    >
      חיוב חוזר מהעסקה
    </ConfirmButton>
  );
}
