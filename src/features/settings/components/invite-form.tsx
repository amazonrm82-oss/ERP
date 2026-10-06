"use client";

import { useActionState, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { FormState } from "@/lib/action-result";

import { inviteUserAction } from "../actions";
import { ROLE_DESCRIPTIONS, type InvitableRole } from "../permissions";

type Props = { orgId: string; orgName: string; roles: InvitableRole[] };
type InviteState = FormState<{ link: string; email: string }>;

/**
 * Creates an invitation and shows its link once, to copy or share.
 * The link is not stored anywhere readable: closing it means creating a new one.
 */
export function InviteForm({ orgId, orgName, roles }: Props) {
  const [state, formAction] = useActionState<InviteState, FormData>(inviteUserAction.bind(null, orgId), null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const failure = state && !state.ok ? state : null;
  const created = state?.ok && state.data && state.data.link !== dismissed ? state.data : null;

  if (created) {
    return <InviteLink orgName={orgName} email={created.email} link={created.link} onDone={() => setDismissed(created.link)} />;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <TextField
          label="אימייל"
          name="email"
          type="email"
          dir="ltr"
          inputMode="email"
          autoComplete="off"
          required
          defaultValue={failure?.values?.email}
          error={failure?.fieldErrors?.email}
        />
        <SelectField
          key={`role-${failure?.values?.role ?? "member"}`}
          label="תפקיד"
          name="role"
          defaultValue={failure?.values?.role ?? "member"}
          error={failure?.fieldErrors?.role}
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </SelectField>
      </div>
      <ul className="space-y-1 text-sm text-ink-soft">
        {roles.map((role) => (
          <li key={role}>
            <span className="font-medium text-ink">{ROLE_LABELS[role]}:</span> {ROLE_DESCRIPTIONS[role]}
          </li>
        ))}
      </ul>
      <SubmitButton pendingText="יוצר הזמנה…">יצירת קישור הזמנה</SubmitButton>
    </form>
  );
}

function InviteLink({ orgName, email, link, onDone }: { orgName: string; email: string; link: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const message = `הוזמנת להצטרף ל-${orgName}. להצטרפות: ${link}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // clipboard blocked: the link is selectable in the field
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <p role="status" className="rounded-md bg-success-soft px-3 py-2.5 text-sm text-success">
        ההזמנה ל-<span dir="ltr">{email}</span> מוכנה. שלחו את הקישור למוזמן. הוא תקף 7 ימים ומתאים רק לכתובת הזו.
      </p>
      <TextField label="קישור ההזמנה" value={link} readOnly dir="ltr" onFocus={(event) => event.currentTarget.select()} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={copy}>
          {copied ? "הקישור הועתק" : "העתקת הקישור"}
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClasses("secondary", "sm")}
        >
          שליחה ב-WhatsApp
        </a>
        <a
          href={`mailto:${email}?subject=${encodeURIComponent(`הזמנה להצטרף ל-${orgName}`)}&body=${encodeURIComponent(message)}`}
          className={buttonClasses("secondary", "sm")}
        >
          שליחה באימייל
        </a>
        <Button variant="ghost" size="sm" onClick={onDone}>
          הזמנה נוספת
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "הקישור הועתק" : ""}
      </span>
    </div>
  );
}
