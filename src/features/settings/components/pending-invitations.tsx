"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { resendInvitationEmailAction } from "@/features/invitations/email-actions";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { MembershipRole } from "@/lib/database.types";

import { revokeInvitationAction } from "../actions";

export type PendingInvitationView = {
  id: string;
  email: string;
  role: MembershipRole;
  // formatted on the server so server and browser output cannot differ
  expiresText: string;
  // USR-09: the line about its latest email (sent, on its way, or failed; null = never sent by email)
  emailLine: string | null;
  emailed: boolean;
};

export function PendingInvitations({ orgId, invitations, canWrite }: { orgId: string; invitations: PendingInvitationView[]; canWrite: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {invitations.map((invitation) => (
        <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span dir="ltr" className="truncate font-medium">
                {invitation.email}
              </span>
              <Badge>{ROLE_LABELS[invitation.role]}</Badge>
            </p>
            <p className="text-sm text-ink-soft">בתוקף עד {invitation.expiresText}</p>
            {invitation.emailLine ? <p className="text-sm text-ink-soft">{invitation.emailLine}</p> : null}
          </div>
          {canWrite ? (
            <span className="flex flex-wrap items-start gap-2">
              <ResendButton orgId={orgId} invitation={invitation} />
              <RevokeButton orgId={orgId} invitation={invitation} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** USR-09: a new email; its link replaces the previous one (an earlier email's, or a copied link). */
function ResendButton({ orgId, invitation }: { orgId: string; invitation: PendingInvitationView }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-end gap-1">
      <ConfirmButton
        variant="secondary"
        title={invitation.emailed ? "לשלוח שוב את ההזמנה במייל?" : "לשלוח את ההזמנה במייל?"}
        description="המוזמן יקבל מייל עם קישור חדש. קישור קודם של ההזמנה הזו, ממייל או מהעתקה, יפסיק לעבוד."
        confirmLabel="שליחה"
        action={async () => {
          const result = await resendInvitationEmailAction(orgId, invitation.id);
          if (result.ok) setMessage(result.message ?? null);
          return result;
        }}
      >
        {invitation.emailed ? "שליחה חוזרת" : "שליחה במייל"}
        <span className="sr-only">: {invitation.email}</span>
      </ConfirmButton>
      {message ? (
        <span role="status" className="max-w-56 text-end text-sm text-success">
          {message}
        </span>
      ) : null}
    </span>
  );
}

function RevokeButton({ orgId, invitation }: { orgId: string; invitation: PendingInvitationView }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function revoke() {
    setError(null);
    startTransition(async () => {
      const result = await revokeInvitationAction(orgId, invitation.id);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <Button variant="danger-ghost" size="sm" onClick={revoke} disabled={pending} aria-busy={pending || undefined}>
        {pending ? "מבטלים…" : "ביטול ההזמנה"}
        <span className="sr-only">: {invitation.email}</span>
      </Button>
      {error ? (
        <span role="alert" className="max-w-56 text-end text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
