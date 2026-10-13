"use client";

import { useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Checkbox } from "@/components/ui/field";

import { eraseFromAuditAction } from "../actions";

type Props = { orgId: string; entityType: string; entityId: string; name: string | null };

/**
 * A privacy erasure from the audit log. "המחיקה היא לבקשת האדם?" (default yes): then the
 * person is also marked "do not contact" for their phone and email (owner, 13 October 2026).
 */
export function EraseDetailsButton({ orgId, entityType, entityId, name }: Props) {
  const [personRequest, setPersonRequest] = useState(true);
  const person = entityType === "leads" || entityType === "contacts";
  return (
    <span className="inline-flex flex-col items-start gap-2">
      {person ? (
        <Checkbox
          label="המחיקה היא לבקשת האדם?"
          hint="אם כן, הוא גם לא יקבל דיוור, עד שייתן הסכמה חדשה בעצמו."
          checked={personRequest}
          onChange={(event) => setPersonRequest(event.target.checked)}
        />
      ) : null}
      <ActionButton
        action={() => eraseFromAuditAction(orgId, entityType, entityId, person ? personRequest : false)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        srLabel={name ?? undefined}
        confirm="למחוק את הפרטים של הרשומה הזו מהיומן? אי אפשר לשחזר אותם."
      >
        מחיקת הפרטים מהיומן
      </ActionButton>
    </span>
  );
}
