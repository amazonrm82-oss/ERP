"use client";

import { useActionState } from "react";

import { Badge } from "@/components/ui/badge";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { formatDateTime } from "@/lib/format";

import { findInBlocklistAction, removeFromBlocklistAction, type BlocklistFindEntry, type BlocklistFindResult } from "../actions";
import {
  BLOCKLIST_CHANNEL_LABELS,
  BLOCKLIST_REASON_LABELS,
  BLOCKLIST_REMOVED_REASON_LABELS,
  BLOCKLIST_REMOVED_REASONS,
} from "../model";

/**
 * CNS-06: looks up one exact phone or email. The list never shows addresses: only what is found for the address typed.
 */
export function BlocklistSearch({ orgId, editable }: { orgId: string; editable: boolean }) {
  const [state, formAction] = useActionState<FormState<BlocklistFindResult>, FormData>(findInBlocklistAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  const result = state?.ok ? state.data : undefined;
  return (
    <div className="space-y-4">
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <TextField
          label="טלפון או אימייל"
          name="address"
          dir="ltr"
          required
          className="sm:flex-1"
          defaultValue={failed?.values?.address ?? ""}
          error={failed?.fieldErrors?.address}
        />
        <SubmitButton variant="secondary" pendingText="מחפשים…">
          חיפוש
        </SubmitButton>
      </form>
      <FormError message={failed && !failed.fieldErrors ? failed.message : null} />
      {result ? <SearchResult orgId={orgId} result={result} editable={editable} /> : null}
    </div>
  );
}

function SearchResult({ orgId, result, editable }: { orgId: string; result: BlocklistFindResult; editable: boolean }) {
  if (!result.valid) {
    return <p className="text-sm text-ink-soft">זה לא נראה כמו טלפון או אימייל. בדקו ונסו שוב.</p>;
  }
  const active = result.entries.filter((entry) => !entry.removedAt);
  return (
    <div className="space-y-3" aria-live="polite">
      {!result.checked ? (
        <p className="text-sm text-warning">המפתח של העסק לקוד המגובב חסר כרגע, ולכן אי אפשר לבדוק את כל הרשימה. התשובה חלקית.</p>
      ) : null}
      <p className="text-sm text-ink">
        {active.length > 0 ? "הכתובת ברשימת החסימה: לא תקבל דיוור בערוצים שמסומנים כאן." : "הכתובת לא ברשימת החסימה."}
      </p>
      {result.erasure ? (
        <p className="text-sm text-ink-soft">בנוסף, אדם עם הכתובת הזאת ביקש למחוק את פרטיו, ולכן היא חסומה לדיוור גם בלי הרשימה.</p>
      ) : null}
      {result.entries.length > 0 ? (
        <ul className="divide-y divide-line rounded-md border border-line">
          {result.entries.map((entry) => (
            <EntryRow key={entry.id} orgId={orgId} entry={entry} editable={editable} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EntryRow({ orgId, entry, editable }: { orgId: string; entry: BlocklistFindEntry; editable: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(removeFromBlocklistAction.bind(null, orgId, entry.id), null);
  const removed = Boolean(entry.removedAt) || Boolean(state?.ok);
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={removed ? "neutral" : "danger"}>{BLOCKLIST_CHANNEL_LABELS[entry.channel]}</Badge>
        <span className="text-sm text-ink">{BLOCKLIST_REASON_LABELS[entry.reason]}</span>
        {removed ? <Badge>הוסרה</Badge> : null}
      </div>
      <p className="text-xs text-ink-soft">
        נוספה {formatDateTime(entry.createdAt)}
        {entry.addedBy ? ` על ידי ${entry.addedBy}` : ""}
        {entry.removedAt
          ? ` · הוסרה ${formatDateTime(entry.removedAt)}${entry.removedBy ? ` על ידי ${entry.removedBy}` : ""}${
              entry.removedReason ? ` (${BLOCKLIST_REMOVED_REASON_LABELS[entry.removedReason]})` : ""
            }`
          : ""}
      </p>
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      {editable && !removed ? (
        <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <SelectField label="למה מסירים?" name="reason" controlSize="sm" defaultValue="" required className="sm:flex-1">
            <option value="" disabled>
              בחרו סיבה
            </option>
            {BLOCKLIST_REMOVED_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {BLOCKLIST_REMOVED_REASON_LABELS[reason]}
              </option>
            ))}
          </SelectField>
          <SubmitButton variant="secondary" size="sm" pendingText="מסירים…">
            הסרה מהרשימה
          </SubmitButton>
        </form>
      ) : null}
    </li>
  );
}
