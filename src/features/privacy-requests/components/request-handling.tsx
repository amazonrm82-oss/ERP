"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField } from "@/components/ui/field";
import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";
import { SubmitButton } from "@/components/ui/submit-button";
import { searchRecordLinkAction } from "@/features/custom-fields/record-link-actions";
import type { PrivacyRequestStatus } from "@/lib/database.types";
import type { FormState } from "@/lib/action-result";

import { linkPrivacyRequestAction, refusePrivacyRequestAction, setPrivacyRequestStatusAction, verifyPrivacyRequestAction } from "../actions";
import { NOTE_MAX, OTHER_REFUSAL, PRIVACY_VERIFY_METHODS, REFUSAL_REASONS, STATUS_LABELS, VERIFY_METHOD_LABELS } from "../model";

function Result({ state }: { state: FormState }) {
  return (
    <>
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
    </>
  );
}

/** "זהות אומתה": how the identity was checked, with an optional note. Marked once. */
export function VerifyForm({ orgId, requestId, status }: { orgId: string; requestId: string; status: PrivacyRequestStatus }) {
  const [state, formAction] = useActionState<FormState, FormData>(verifyPrivacyRequestAction.bind(null, orgId, requestId), null);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Result state={state} />
      <input type="hidden" name="status" value={status} />
      <SelectField label="איך אומתה הזהות" name="verify_method" defaultValue="" required className="sm:max-w-sm">
        <option value="" disabled>
          בחרו
        </option>
        {PRIVACY_VERIFY_METHODS.map((method) => (
          <option key={method} value={method}>
            {VERIFY_METHOD_LABELS[method]}
          </option>
        ))}
      </SelectField>
      <TextareaField label="הערה (לא חובה)" name="verify_note" rows={2} maxLength={NOTE_MAX} hint="בלי מספר תעודה ובלי פרטים מזהים: רק מה נבדק." />
      <SubmitButton size="sm" pendingText="שומרים…">
        זהות אומתה
      </SubmitButton>
    </form>
  );
}

/** Moves an open request to another open status, or to "טופלה". */
export function StatusForm({ orgId, requestId, options }: { orgId: string; requestId: string; options: PrivacyRequestStatus[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(setPrivacyRequestStatusAction.bind(null, orgId, requestId), null);
  if (options.length === 0) return null;
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2" noValidate>
      <SelectField label="מעבר למצב" name="status" defaultValue={options[0]} className="min-w-48">
        {options.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </SelectField>
      <SubmitButton size="sm" pendingText="שומרים…">
        עדכון המצב
      </SubmitButton>
      <div className="w-full">
        <Result state={state} />
      </div>
    </form>
  );
}

/** Refuses the request with a ready reason (junk: "בקשה לא רצינית / ספאם") or one typed; kept with it. Nothing is deleted. */
export function RefuseForm({ orgId, requestId }: { orgId: string; requestId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(refusePrivacyRequestAction.bind(null, orgId, requestId), null);
  const [choice, setChoice] = useState<string>(REFUSAL_REASONS[0]);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Result state={state} />
      <SelectField label="סיבת הדחייה" name="refusal_choice" value={choice} onChange={(event) => setChoice(event.target.value)} className="sm:max-w-sm">
        {REFUSAL_REASONS.map((reason) => (
          <option key={reason} value={reason}>
            {reason}
          </option>
        ))}
        <option value={OTHER_REFUSAL}>סיבה אחרת</option>
      </SelectField>
      {choice === OTHER_REFUSAL ? <TextareaField label="הסיבה" name="refusal_detail" rows={2} required maxLength={NOTE_MAX} /> : null}
      <SubmitButton size="sm" variant="secondary" pendingText="שומרים…">
        דחיית הבקשה
      </SubmitButton>
    </form>
  );
}

type LinkProps = {
  orgId: string;
  requestId: string;
  kind: "lead" | "contact";
  current: SearchPickerChoice;
  leadLabel: string;
  contactLabel: string;
};

/** Links the request to the lead or contact it is about (picked by search, with the user's session), or clears it. */
export function LinkForm({ orgId, requestId, kind: initialKind, current, leadLabel, contactLabel }: LinkProps) {
  const [state, formAction] = useActionState<FormState, FormData>(linkPrivacyRequestAction.bind(null, orgId, requestId), null);
  const [kind, setKind] = useState<"lead" | "contact">(initialKind);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Result state={state} />
      <SelectField label="סוג הרשומה" name="record_kind" value={kind} onChange={(event) => setKind(event.target.value === "lead" ? "lead" : "contact")} className="sm:max-w-xs">
        <option value="contact">{contactLabel}</option>
        <option value="lead">{leadLabel}</option>
      </SelectField>
      <SearchPicker
        key={kind}
        label="הרשומה"
        name="record_id"
        initial={kind === initialKind ? current : null}
        search={(query) => searchRecordLinkAction(orgId, kind, query)}
        placeholder="חיפוש לפי שם, טלפון או אימייל"
      />
      <SubmitButton size="sm" pendingText="שומרים…">
        שמירת הקישור לרשומה
      </SubmitButton>
    </form>
  );
}
