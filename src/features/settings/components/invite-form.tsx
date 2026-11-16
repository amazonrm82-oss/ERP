"use client";

import { useActionState, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { FormState } from "@/lib/action-result";

import { MAX_INVITES } from "@/features/invitations/addresses";
import { inviteUsersAction, type InviteResult } from "@/features/invitations/email-actions";
import { ROLE_DESCRIPTIONS, type InvitableRole } from "../permissions";

type Props = { orgId: string; orgName: string; roles: InvitableRole[] };
type InviteState = FormState<{ results: InviteResult[] }>;

/**
 * USR-09 (owner (387) א): invites one or several addresses at once. By default the system sends each invitation by email
 * (its own link, which replaces any earlier one); without that, or when email is not available, the link is shown once to
 * copy or share, as before. The link is not stored anywhere readable: closing it means creating a new one.
 */
export function InviteForm({ orgId, orgName, roles }: Props) {
  const [state, formAction] = useActionState<InviteState, FormData>(inviteUsersAction.bind(null, orgId), null);
  const [dismissed, setDismissed] = useState<InviteResult[] | null>(null);
  const [byEmail, setByEmail] = useState(true);
  const failure = state && !state.ok ? state : null;
  const results = state?.ok && state.data && state.data.results !== dismissed ? state.data.results : null;

  if (results) {
    const done = () => setDismissed(results);
    const only = results.length === 1 ? results[0] : null;
    if (only?.status === "link") {
      return <InviteLink orgName={orgName} email={only.email} link={only.link} note={only.note} onDone={done} />;
    }
    return <InviteResults orgName={orgName} results={results} onDone={done} />;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <TextareaField
          label="אימייל"
          hint={`כתובת אחת או כמה, מופרדות בפסיק או בשורה חדשה (עד ${MAX_INVITES}).`}
          name="emails"
          dir="ltr"
          rows={2}
          autoComplete="off"
          required
          defaultValue={failure?.values?.emails}
          error={failure?.fieldErrors?.emails}
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
      <Checkbox
        name="send_email"
        label="שליחת ההזמנה במייל מהמערכת"
        hint="המוזמן מקבל מייל עם קישור הצטרפות. קישור קודם שנשלח לאותה כתובת יפסיק לעבוד. אפשר גם לבטל את הסימון ולהעתיק את הקישור בעצמכם."
        checked={byEmail}
        onChange={(e) => setByEmail(e.target.checked)}
      />
      <ul className="space-y-1 text-sm text-ink-soft">
        {roles.map((role) => (
          <li key={role}>
            <span className="font-medium text-ink">{ROLE_LABELS[role]}:</span> {ROLE_DESCRIPTIONS[role]}
          </li>
        ))}
      </ul>
      <SubmitButton pendingText={byEmail ? "שולחים…" : "יוצרים הזמנה…"}>{byEmail ? "שליחת הזמנה" : "יצירת קישור הזמנה"}</SubmitButton>
    </form>
  );
}

function InviteResults({ orgName, results, onDone }: { orgName: string; results: InviteResult[]; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line rounded-md border border-line">
        {results.map((result) => (
          <li key={result.email} className="space-y-2 px-3 py-2.5">
            <p className="flex flex-wrap items-center gap-2">
              <span dir="ltr" className="font-medium">
                {result.email}
              </span>
              {result.status === "emailed" ? <span className="text-sm text-success">ההזמנה תישלח במייל</span> : null}
              {result.status === "failed" ? <span className="text-sm text-danger">{result.message}</span> : null}
            </p>
            {result.status === "link" ? <CopyLink orgName={orgName} link={result.link} note={result.note} /> : null}
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={onDone}>
        הזמנה נוספת
      </Button>
    </div>
  );
}

function CopyLink({ orgName, link, note }: { orgName: string; link: string; note: string | null }) {
  const [copied, setCopied] = useState(false);
  const message = `הוזמנת להצטרף ל-${orgName}. להצטרפות: ${link}`;
  return (
    <div className="space-y-2">
      {note ? <p className="text-sm text-ink-soft">{note}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "הקישור הועתק" : "העתקת הקישור"}
        </Button>
        <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "sm")}>
          שליחה ב-WhatsApp
          <span className="sr-only"> (נפתח בחלון חדש)</span>
        </a>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "הקישור הועתק" : ""}
      </span>
    </div>
  );
}

function InviteLink({ orgName, email, link, note, onDone }: { orgName: string; email: string; link: string; note: string | null; onDone: () => void }) {
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
      {note ? <p className="text-sm text-ink-soft">{note}</p> : null}
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
          <span className="sr-only"> (נפתח בחלון חדש)</span>
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
