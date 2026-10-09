"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { transferRecordsAction } from "../actions";

// total: records the person still owns. The form stays mounted when it drops to 0,
// so the result of a transfer is still shown after the page refreshes.
type Props = { orgId: string; fromUserId: string; fromName: string; total: number; candidates: Array<{ userId: string; name: string }> };

export function TransferRecordsForm({ orgId, fromUserId, fromName, total, candidates }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(transferRecordsAction.bind(null, orgId, fromUserId), null);
  if (state?.ok) {
    return (
      <div className="space-y-3">
        <FormNotice message={state.message} />
        <p className="text-md">
          עכשיו אפשר להשבית את {fromName} בלי לאבד אף רשומה.{" "}
          <Link href={paths.settingsUsers(orgId)} className="text-accent-strong underline underline-offset-4">
            חזרה למשתמשים
          </Link>
        </p>
      </div>
    );
  }
  if (total === 0) return null;
  if (candidates.length === 0) return <p className="text-ink-soft">אין משתמש פעיל אחר שאפשר להעביר אליו.</p>;
  return (
    <form action={formAction} className="space-y-4">
      <FormError message={state && !state.ok ? state.message : null} />
      <SelectField label="למי להעביר" name="to" required defaultValue="">
        <option value="" disabled>
          בחירה
        </option>
        {candidates.map((c) => (
          <option key={c.userId} value={c.userId}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <SubmitButton pendingText="מעבירים…">העברת כל הרשומות</SubmitButton>
    </form>
  );
}
