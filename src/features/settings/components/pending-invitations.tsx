"use client";

import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS } from "@/features/shell/labels";
import type { MembershipRole } from "@/lib/database.types";

import { revokeInvitationAction } from "../actions";

export type PendingInvitationView = {
  id: string;
  email: string;
  role: MembershipRole;
  // formatted on the server so server and browser output cannot differ
  expiresText: string;
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
          </div>
          {canWrite ? <RevokeButton orgId={orgId} invitation={invitation} /> : null}
        </li>
      ))}
    </ul>
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
        {pending ? "מבטל…" : "ביטול ההזמנה"}
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
