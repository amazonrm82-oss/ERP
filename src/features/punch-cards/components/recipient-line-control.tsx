"use client";

import { useActionState, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, Select, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ContactPicker } from "@/features/contacts/components/contact-picker";
import type { SearchPickerChoice } from "@/components/ui/search-picker";
import type { FormState } from "@/lib/action-result";

import { addLineRecipientAction, setLineRecipientAction } from "../recipient-actions";
import { PAYER_CHOICE, RECIPIENT_LABEL, recipientLine, recipientOptionLabel, type LineRecipient, type RecipientDocKind, type RecipientOption } from "../recipients";
import type { RecipientSetup } from "../recipient-server";

type Props = {
  orgId: string;
  kind: RecipientDocKind;
  docId: string;
  lineId: string;
  recipient: LineRecipient;
  // null = read only (a sent quote, a numbered order, or a person who may not edit it)
  edit: RecipientSetup["edit"];
};

/**
 * PKG-06: who gets the punch card of this line. On a draft: a choice of the payer's relations and the paying company's
 * employees (saved at once), and "מקבל אחר" to add a relation, or a new contact, without leaving the document. Otherwise
 * one line of text.
 */
export function RecipientLineControl({ orgId, kind, docId, lineId, recipient, edit }: Props) {
  const [value, setValue] = useState(recipient.recipientId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  const id = useId();

  if (!edit) {
    return <p className="mt-1 text-sm text-ink-soft">{recipientLine(recipient.recipientName)}</p>;
  }
  const options: RecipientOption[] = edit.options.filter((o) => o.how !== "payer");
  // a recipient saved before that the list no longer offers (the person may not read it, or the link went) stays shown
  const kept = recipient.recipientId && !edit.options.some((o) => o.id === recipient.recipientId) ? recipient : null;

  function change(next: string) {
    const before = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const outcome = await setLineRecipientAction(orgId, kind, docId, lineId, next === "" ? null : next);
      if (!outcome.ok) {
        setValue(before);
        setError(outcome.message);
      }
    });
  }

  return (
    <div className="mt-1 space-y-1 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm text-ink-soft">
          {RECIPIENT_LABEL}
        </label>
        <Select id={id} controlSize="sm" value={value} disabled={pending} onChange={(event) => change(event.target.value)} className="w-auto max-w-full">
          <option value="">{PAYER_CHOICE}</option>
          {kept ? <option value={kept.recipientId ?? ""}>{kept.recipientName ?? "איש קשר"}</option> : null}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {recipientOptionLabel(option)}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
          מקבל אחר
        </Button>
      </div>
      <FormError message={error} />
      {adding ? (
        <AddRecipientDialog orgId={orgId} kind={kind} docId={docId} lineId={lineId} edit={edit} onClose={() => setAdding(false)} />
      ) : null}
    </div>
  );
}

function AddRecipientDialog({
  orgId,
  kind,
  docId,
  lineId,
  edit,
  onClose,
}: {
  orgId: string;
  kind: RecipientDocKind;
  docId: string;
  lineId: string;
  edit: NonNullable<RecipientSetup["edit"]>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [picked, setPicked] = useState<SearchPickerChoice>(null);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await addLineRecipientAction(orgId, kind, docId, lineId, prev, formData);
    if (result?.ok) onClose();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const byCompany = !edit.payerContactId;
  const noChoices = !byCompany && edit.relationChoices.length === 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title="מקבל שירות אחר"
      description={
        byCompany
          ? "מקבל השירות יירשם כעובד בחברה המשלמת. הכרטיסייה תיפתח על שמו, והמסמך והתשלום נשארים על החברה."
          : "מקבל השירות יקושר למשלם בקשר בין אנשי קשר. הכרטיסייה תיפתח על שמו, והמסמך והתשלום נשארים על המשלם."
      }
    >
      <form action={formAction} className="space-y-4" noValidate>
        <FormError message={errors.allow_duplicate || !failure?.fieldErrors ? failure?.message : undefined} />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">מי מקבל את השירות</legend>
          <label className="flex items-center gap-2 text-md">
            <input type="radio" name="mode" value="existing" checked={mode === "existing"} onChange={() => setMode("existing")} />
            איש קשר קיים
          </label>
          <label className="flex items-center gap-2 text-md">
            <input type="radio" name="mode" value="new" checked={mode === "new"} onChange={() => setMode("new")} />
            איש קשר חדש
          </label>
        </fieldset>
        {mode === "existing" ? (
          <ContactPicker
            orgId={orgId}
            name="contact_id"
            label="חיפוש איש קשר"
            initial={picked}
            onChange={setPicked}
            exclude={edit.payerContactId ? [edit.payerContactId] : []}
            required
            error={errors.contact_id}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="שם פרטי" name="first_name" required maxLength={100} defaultValue={failure?.values?.first_name ?? ""} error={errors.first_name} />
            <TextField label="שם משפחה" name="last_name" maxLength={100} defaultValue={failure?.values?.last_name ?? ""} error={errors.last_name} />
            <TextField label="טלפון" name="phone" type="tel" dir="ltr" inputMode="tel" defaultValue={failure?.values?.phone ?? ""} error={errors.phone} />
            <TextField label="אימייל" name="email" type="email" dir="ltr" defaultValue={failure?.values?.email ?? ""} error={errors.email} />
            {errors.allow_duplicate ? (
              <div className="sm:col-span-2">
                <Checkbox name="allow_duplicate" label="ליצור איש קשר חדש בכל זאת" hint="אפשר גם לבחור את הקיים: ״איש קשר קיים״ למעלה." />
              </div>
            ) : null}
          </div>
        )}
        {byCompany ? null : noChoices ? (
          <p className="text-sm text-warning">אין סוגי קשר פעילים בעסק. אפשר להוסיף אותם בהגדרות, בסוגי הקשרים בין אנשי קשר.</p>
        ) : (
          <SelectField label="מקבל השירות הוא" name="choice" required defaultValue={failure?.values?.choice ?? ""} error={errors.choice} hint="של המשלם">
            <option value="" disabled>
              בחרו סוג קשר
            </option>
            {edit.relationChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </SelectField>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <SubmitButton pendingText="שומרים…" disabled={noChoices}>
            שמירה
          </SubmitButton>
          <Button variant="ghost" onClick={onClose}>
            ביטול
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
